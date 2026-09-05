"""Costruzione del modello di superficie su cui vengono calcolate le ombre.

Le sorgenti arrivano con risoluzioni, proiezioni e nature diverse (terreno a
10 m in UTM, edifici vettoriali in gradi, chiome a 10 m in gradi). Qui vengono
portate tutte su un'unica griglia metrica dell'area e combinate in due
superfici:

  DSM   terreno + edifici    -> ostacoli opachi
  CDSM  terreno + chiome     -> ostacoli semi-trasparenti

La separazione e' necessaria perche' un albero e un muro non fanno la stessa
ombra: sotto la chioma passa comunque una frazione di radiazione.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.merge import merge as rio_merge
from rasterio.transform import from_origin
from rasterio.warp import reproject

# Sotto questa altezza la chioma non fa ombra utile a un pedone
MIN_CANOPY_HEIGHT = 2.5


def _target_grid(aoi):
    """Griglia metrica dell'area: trasformazione affine e dimensioni in pixel.

    Copre il riquadro allargato del margine, non solo l'area percorribile,
    per non perdere le ombre proiettate da fuori.
    """
    x0, y0, x1, y1 = aoi.buffered_bounds_in(aoi.utm_epsg)
    res = aoi.resolution
    # Allineiamo gli spigoli a multipli della risoluzione: i pixel restano
    # stabili se l'area viene ricostruita, e i tasselli combaciano.
    x0 = np.floor(x0 / res) * res
    y0 = np.floor(y0 / res) * res
    x1 = np.ceil(x1 / res) * res
    y1 = np.ceil(y1 / res) * res
    width = int(round((x1 - x0) / res))
    height = int(round((y1 - y0) / res))
    return from_origin(x0, y1, res, res), width, height


def _write(path: Path, data, transform, crs, nodata=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=data.shape[0],
        width=data.shape[1],
        count=1,
        dtype="float32",
        crs=crs,
        transform=transform,
        nodata=nodata,
        compress="deflate",
        predictor=2,
        tiled=True,
    ) as dst:
        dst.write(data.astype(np.float32), 1)


def _reproject_to_grid(
    src_data, src_transform, src_crs, transform, width, height, dst_crs,
    resampling=Resampling.bilinear, src_nodata=None,
):
    """Porta un raster qualsiasi sulla griglia di destinazione."""
    out = np.zeros((height, width), dtype=np.float32)
    reproject(
        source=src_data,
        destination=out,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=transform,
        dst_crs=dst_crs,
        resampling=resampling,
        src_nodata=src_nodata,
        dst_nodata=0.0,
    )
    return out


def build_surface(aoi, dtm_tiles, buildings, canopy_path=None, tcd_path=None, log=print):
    """Costruisce e salva DTM, DSM, CDSM e densita' arborea per l'area.

    Args:
        aoi: istanza AOI
        dtm_tiles: percorsi dei GeoTIFF TINITALY che coprono l'area
        buildings: GeoDataFrame di edifici in EPSG:4326 con colonna `height`
        canopy_path: GeoTIFF di altezza chioma, opzionale
        tcd_path: GeoTIFF di densita' arborea, opzionale

    Returns:
        dict con le statistiche di costruzione.
    """
    transform, width, height = _target_grid(aoi)
    dst_crs = rasterio.CRS.from_epsg(aoi.utm_epsg)
    log(f"  griglia {width}x{height} px a {aoi.resolution} m ({aoi.utm_epsg})")

    # ---- terreno -------------------------------------------------------
    log("  terreno: fusione tasselli TINITALY e ricampionamento")
    srcs = [rasterio.open(p) for p in dtm_tiles]
    try:
        if len(srcs) == 1:
            dtm_raw, dtm_tr = srcs[0].read(1), srcs[0].transform
        else:
            merged, dtm_tr = rio_merge(srcs)
            dtm_raw = merged[0]
        src_crs, src_nodata = srcs[0].crs, srcs[0].nodata
    finally:
        for s in srcs:
            s.close()

    # TINITALY usa -9999 sul mare e fuori copertura
    dtm_raw = np.where(dtm_raw <= -9000, np.nan, dtm_raw.astype(np.float32))
    valid_fill = float(np.nanmedian(dtm_raw)) if np.isfinite(dtm_raw).any() else 0.0
    dtm_raw = np.nan_to_num(dtm_raw, nan=valid_fill)

    dtm = _reproject_to_grid(
        dtm_raw, dtm_tr, src_crs, transform, width, height, dst_crs,
        Resampling.bilinear, src_nodata=src_nodata,
    )
    # I bordi possono restare a zero se la copertura non arriva: li riempiamo
    # con la quota mediana invece di lasciare una voragine che falsa le ombre.
    dtm = np.where(dtm <= 0.0, valid_fill, dtm)
    log(f"    quota {dtm.min():.0f}-{dtm.max():.0f} m slm")

    # ---- edifici -------------------------------------------------------
    log(f"  edifici: rasterizzazione di {len(buildings)} volumi")
    b = buildings.to_crs(dst_crs)
    # Gli edifici piu' bassi vengono bruciati per primi: in caso di
    # sovrapposizione prevale il volume piu' alto, che e' quello che conta
    # per l'ombra.
    b = b.sort_values("height")
    shapes = ((geom, float(h)) for geom, h in zip(b.geometry, b.height) if geom is not None)
    building_h = rasterize(
        shapes,
        out_shape=(height, width),
        transform=transform,
        fill=0.0,
        dtype="float32",
        all_touched=False,
    )
    built_mask = building_h > 0
    dsm = dtm + building_h
    log(
        f"    {built_mask.mean() * 100:.1f}% della superficie coperta da edifici, "
        f"altezza max {building_h.max():.1f} m"
    )

    # ---- densita' arborea ---------------------------------------------
    tcd = None
    if tcd_path is not None and Path(tcd_path).exists():
        log("  densita' arborea: riproiezione")
        with rasterio.open(tcd_path) as src:
            tcd = _reproject_to_grid(
                src.read(1).astype(np.float32), src.transform, src.crs,
                transform, width, height, dst_crs, Resampling.nearest,
            )
        tcd = np.where(tcd > 100, 0.0, tcd)  # 255 e' il nodata del servizio

    # ---- chiome --------------------------------------------------------
    canopy_h = np.zeros((height, width), dtype=np.float32)
    if canopy_path is not None and Path(canopy_path).exists():
        log("  chiome: riproiezione altezza vegetazione")
        with rasterio.open(canopy_path) as src:
            canopy_h = _reproject_to_grid(
                src.read(1), src.transform, src.crs, transform, width, height,
                dst_crs, Resampling.bilinear,
            )
        raw_cover = (canopy_h >= MIN_CANOPY_HEIGHT).mean() * 100

        # La vegetazione bassa non ombreggia, e dove c'e' un edificio il
        # dato di chioma e' quasi sempre il tetto scambiato per albero.
        canopy_h = np.where(canopy_h < MIN_CANOPY_HEIGHT, 0.0, canopy_h)
        canopy_h = np.where(built_mask, 0.0, canopy_h)

        # Corroborazione con la densita' arborea Copernicus. L'altezza ETH
        # ha pixel da 10 m e in citta' sborda sulle strade: dove il prodotto
        # dedicato alla copertura arborea non vede alberi, non ne mettiamo.
        if tcd is not None:
            before = (canopy_h > 0).mean() * 100
            canopy_h = np.where(tcd > 0, canopy_h, 0.0)
            after = (canopy_h > 0).mean() * 100
            log(
                f"    copertura ETH grezza {raw_cover:.1f}%, "
                f"tolti gli edifici {before:.1f}%, "
                f"confermata da Copernicus {after:.1f}%"
            )
        else:
            log(f"    {(canopy_h > 0).mean() * 100:.1f}% di copertura arborea")
        log(f"    altezza chioma max {canopy_h.max():.1f} m")
    else:
        log("  chiome: dato assente, si procede senza vegetazione")

    cdsm = dtm + canopy_h

    # ---- salvataggio ---------------------------------------------------
    _write(aoi.dtm_path, dtm, transform, dst_crs)
    _write(aoi.dsm_path, dsm, transform, dst_crs)
    _write(aoi.cdsm_path, cdsm, transform, dst_crs)
    if tcd is not None:
        _write(aoi.tcd_path, tcd, transform, dst_crs)

    log(f"  superficie salvata in {aoi.dir}")
    return {
        "width": width,
        "height": height,
        "resolution": aoi.resolution,
        "epsg": aoi.utm_epsg,
        "ground_min": float(dtm.min()),
        "ground_max": float(dtm.max()),
        "building_count": int(len(buildings)),
        "building_max_height": float(building_h.max()),
        "built_fraction": float(built_mask.mean()),
        "canopy_fraction": float((canopy_h > 0).mean()),
        "has_canopy": bool(canopy_h.max() > 0),
        "has_tcd": tcd is not None,
    }


def load_surfaces(aoi):
    """Rilegge le superfici salvate. Ritorna (dsm, cdsm, tcd, transform, crs)."""
    with rasterio.open(aoi.dsm_path) as src:
        dsm = src.read(1)
        transform, crs = src.transform, src.crs

    cdsm = None
    if aoi.cdsm_path.exists():
        with rasterio.open(aoi.cdsm_path) as src:
            cdsm = src.read(1)
        # Se la vegetazione non aggiunge nulla al terreno, non serve il
        # secondo passaggio di shadow casting.
        if not np.any(cdsm > dsm):
            cdsm = None

    tcd = None
    if aoi.tcd_path.exists():
        with rasterio.open(aoi.tcd_path) as src:
            tcd = src.read(1)

    return dsm, cdsm, tcd, transform, crs
