"""Acquisizione dei dati di base per un'area di interesse.

Porting senza dipendenze QGIS dei downloader del plugin EnviMet Protocol.
Ogni sorgente e' indipendente e mette in cache i tasselli grezzi, cosi' che
aree diverse che condividono lo stesso tassello lo scarichino una volta sola.

Sorgenti:
  TINITALY   modello digitale del terreno 10 m, INGV        (obbligatoria)
  TUM LoD1   impronte edifici con altezza, Global Building Atlas (obbligatoria)
  Overpass   grafo stradale OpenStreetMap                   (obbligatoria)
  ETH GCH    altezza delle chiome 10 m                      (opzionale)
  Copernicus densita' di copertura arborea 10 m             (opzionale)
"""

from __future__ import annotations

import math
import zipfile
from pathlib import Path

import requests

USER_AGENT = "Ombra/1.0 (percorsi all'ombra; https://github.com/ombra)"
_TIMEOUT = 300


class SourceError(RuntimeError):
    """Errore recuperabile durante l'acquisizione di una sorgente."""


def _download(url: str, dest: Path, log=print, min_bytes: int = 1000) -> Path:
    """Scarica un file con cache su disco e verifica di dimensione minima.

    I servizi usati rispondono spesso con un XML di errore al posto del dato
    quando il tassello non esiste: il controllo di dimensione minima serve a
    smascherare quel caso.
    """
    if dest.exists() and dest.stat().st_size >= min_bytes:
        log(f"    cache: {dest.name}")
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")

    try:
        with requests.get(
            url, stream=True, headers={"User-Agent": USER_AGENT}, timeout=_TIMEOUT
        ) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length") or 0)
            done = 0
            last_pct = -10
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = int(100 * done / total)
                        if pct >= last_pct + 10:
                            log(f"    {dest.name}: {pct}% ({done >> 20} MB)")
                            last_pct = pct
                    elif done >> 20 >= last_pct + 20:
                        last_pct = done >> 20
                        log(f"    {dest.name}: {last_pct} MB")
    except requests.RequestException as exc:
        tmp.unlink(missing_ok=True)
        raise SourceError(f"download fallito {url}: {exc}") from exc

    if tmp.stat().st_size < min_bytes:
        tmp.unlink(missing_ok=True)
        raise SourceError(f"risposta troppo piccola, tassello inesistente: {url}")

    tmp.rename(dest)
    log(f"    scaricato: {dest.name} ({dest.stat().st_size >> 20} MB)")
    return dest


# --------------------------------------------------------------------------
# TINITALY - modello digitale del terreno
# --------------------------------------------------------------------------

TINITALY_BASE = "https://tinitaly.pi.ingv.it/data_1.1/"


def tinitaly_tiles(bounds_utm32) -> list[str]:
    """Nomi dei tasselli TINITALY che coprono un bbox in EPSG:32632.

    TINITALY distribuisce tutta l'Italia in UTM 32N con una griglia di 50 km.
    """
    xmin, ymin, xmax, ymax = bounds_utm32
    tiles = []
    x0 = math.floor(xmin / 50000) * 50000
    y0 = math.floor(ymin / 50000) * 50000
    for x in range(int(x0), int(math.ceil(xmax / 50000) * 50000), 50000):
        for y in range(int(y0), int(math.ceil(ymax / 50000) * 50000), 50000):
            nnn = int(y / 10000)
            if x <= 1000000:
                prefix, ee = "w", int(x / 10000)
                ee_str = "10" if ee == 100 else str(ee).zfill(2)
            else:
                prefix, ee = "e", int((x - 1000000) / 10000)
                ee_str = str(ee).zfill(2)
            tiles.append(f"{prefix}{str(nnn).zfill(3)}{ee_str}")
    return sorted(set(tiles))


def fetch_dtm(bounds_utm32, cache: Path, log=print) -> list[Path]:
    """Scarica ed estrae i tasselli DTM TINITALY. Ritorna i percorsi dei GeoTIFF."""
    out_dir = cache / "tinitaly"
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []

    for tile in tinitaly_tiles(bounds_utm32):
        tif = out_dir / f"{tile}_s10.tif"
        if tif.exists():
            log(f"    cache: {tif.name}")
            paths.append(tif)
            continue

        zip_path = out_dir / f"{tile}_s10.zip"
        url = f"{TINITALY_BASE}{tile}_s10/{tile}_s10.zip"
        try:
            _download(url, zip_path, log=log, min_bytes=100_000)
        except SourceError as exc:
            log(f"    tassello DTM {tile} non disponibile ({exc})")
            continue

        # L'archivio annida il raster in una cartella e ci affianca il PDF di
        # accompagnamento: estraiamo il solo GeoTIFF, appiattendo il percorso.
        with zipfile.ZipFile(zip_path) as zf:
            member = next(
                (n for n in zf.namelist() if n.lower().endswith(f"{tile}_s10.tif")),
                None,
            )
            if member is None:
                log(f"    archivio {tile} senza GeoTIFF: {zf.namelist()}")
                continue
            with zf.open(member) as src, open(tif, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)

        paths.append(tif)
        zip_path.unlink(missing_ok=True)

    if not paths:
        raise SourceError(
            "nessun tassello TINITALY disponibile: l'area e' fuori dall'Italia?"
        )
    return paths


# --------------------------------------------------------------------------
# TUM Global Building Atlas LoD1 - edifici con altezza
# --------------------------------------------------------------------------

TUM_BASE = "https://data.source.coop/tge-labs/globalbuildingatlas-lod1/"


def tum_tiles(bounds_wgs84) -> list[str]:
    """Nomi dei tasselli parquet TUM LoD1 (griglia di 5 gradi) per un bbox WGS84."""
    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    names = []
    for lon in range(
        int(math.floor(lon_min / 5) * 5), int(math.floor(lon_max / 5) * 5) + 5, 5
    ):
        for lat in range(
            int(math.floor(lat_min / 5) * 5), int(math.floor(lat_max / 5) * 5) + 5, 5
        ):
            lo0, lo1, la0, la1 = lon, lon + 5, lat, lat + 5
            ew0, ew1 = ("e" if lo0 >= 0 else "w"), ("e" if lo1 >= 0 else "w")
            ns0, ns1 = ("n" if la0 >= 0 else "s"), ("n" if la1 >= 0 else "s")
            names.append(
                f"{ew0}{abs(lo0):03d}_{ns1}{abs(la1):02d}_"
                f"{ew1}{abs(lo1):03d}_{ns0}{abs(la0):02d}.parquet"
            )
    return sorted(set(names))


def fetch_buildings(bounds_wgs84, cache: Path, log=print):
    """Edifici LoD1 ritagliati sul bbox. Ritorna un GeoDataFrame in EPSG:4326.

    I tasselli sono enormi (5x5 gradi, centinaia di MB) ma sono GeoParquet
    ordinati spazialmente con una colonna `bbox` statisticata per row group.
    Leggiamo quindi in remoto via range request scaricando solo i pochi MB
    di row group che intersecano l'area: un tassello da 658 MB si risolve in
    una decina di secondi senza toccare il disco.
    """
    import fsspec
    import geopandas as gpd
    import pandas as pd
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    import shapely

    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    out_dir = cache / "tum_lod1"
    out_dir.mkdir(parents=True, exist_ok=True)
    clipped = out_dir / (
        f"edifici_{lon_min:.4f}_{lat_min:.4f}_{lon_max:.4f}_{lat_max:.4f}.parquet"
    )
    if clipped.exists():
        log(f"    cache: {clipped.name}")
        return gpd.read_parquet(clipped)

    # Row group tenuti solo se il loro bbox interseca l'area richiesta
    spatial_filter = (
        (pc.field("bbox", "xmax") >= lon_min)
        & (pc.field("bbox", "xmin") <= lon_max)
        & (pc.field("bbox", "ymax") >= lat_min)
        & (pc.field("bbox", "ymin") <= lat_max)
    )
    fs = fsspec.filesystem("https", block_size=2 * 1024 * 1024)
    frames = []

    for name in tum_tiles(bounds_wgs84):
        log(f"    lettura remota tassello edifici {name}")
        try:
            with fs.open(TUM_BASE + name) as handle:
                table = pq.read_table(
                    handle, filters=spatial_filter, columns=["id", "height", "geometry"]
                )
        except Exception as exc:  # tassello inesistente o servizio irraggiungibile
            log(f"    tassello {name} non leggibile: {exc}")
            continue

        if table.num_rows == 0:
            continue

        gdf = gpd.GeoDataFrame(
            {
                "id": table.column("id").to_pylist(),
                "height": table.column("height").to_numpy(),
            },
            geometry=shapely.from_wkb(
                table.column("geometry").to_numpy(zero_copy_only=False)
            ),
            crs="EPSG:4326",
        )
        # -999 e' il nodata del dataset; scartiamo anche altezze non fisiche
        gdf = gdf[(gdf.height > 0.5) & (gdf.height < 400.0)]
        if len(gdf):
            frames.append(gdf)

    if not frames:
        raise SourceError("nessun edificio TUM LoD1 trovato per l'area richiesta")

    merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")
    merged.to_parquet(clipped)
    log(f"    {len(merged)} edifici, altezza mediana {merged.height.median():.1f} m")
    return merged


# --------------------------------------------------------------------------
# ETH Global Canopy Height - altezza delle chiome
# --------------------------------------------------------------------------

ETH_BASE = (
    "https://libdrive.ethz.ch/index.php/s/cO8or7iOe5dT2Rt/download"
    "?path=%2F3deg_cogs&files="
)


def eth_tiles(bounds_wgs84) -> list[str]:
    """Nomi dei tasselli ETH Canopy Height (griglia di 3 gradi) per un bbox WGS84."""
    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    names = []
    for lat in range(
        int(math.floor(lat_min / 3) * 3), int(math.floor(lat_max / 3) * 3) + 3, 3
    ):
        for lon in range(
            int(math.floor(lon_min / 3) * 3), int(math.floor(lon_max / 3) * 3) + 3, 3
        ):
            ns = f"N{abs(lat):02d}" if lat >= 0 else f"S{abs(lat):02d}"
            ew = f"E{abs(lon):03d}" if lon >= 0 else f"W{abs(lon):03d}"
            names.append(f"ETH_GlobalCanopyHeight_10m_2020_{ns}{ew}_Map.tif")
    return sorted(set(names))


def fetch_canopy(bounds_wgs84, cache: Path, log=print) -> Path | None:
    """Ritaglio dell'altezza delle chiome sul bbox, come GeoTIFF locale.

    I tasselli ETH sono COG da 36000x36000 px: li leggiamo a finestra via
    /vsicurl/ invece di scaricare i 200 MB interi. Ritorna None se la
    sorgente non e' raggiungibile: la vegetazione e' un livello opzionale.
    """
    import numpy as np
    import rasterio
    from rasterio.windows import from_bounds

    out_dir = cache / "eth_canopy"
    out_dir.mkdir(parents=True, exist_ok=True)
    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    dest = out_dir / (
        f"chiome_{lon_min:.4f}_{lat_min:.4f}_{lon_max:.4f}_{lat_max:.4f}.tif"
    )
    if dest.exists():
        log(f"    cache: {dest.name}")
        return dest

    # Il server ETH non risponde alle HEAD: senza questo GDAL rinuncia subito.
    env = rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_USE_HEAD="NO",
        GDAL_HTTP_MAX_RETRY="3",
        GDAL_HTTP_RETRY_DELAY="2",
    )

    pieces = []
    profile = None
    with env:
        for name in eth_tiles(bounds_wgs84):
            log(f"    lettura remota tassello chiome {name}")
            try:
                with rasterio.open("/vsicurl/" + ETH_BASE + name) as src:
                    window = from_bounds(
                        lon_min, lat_min, lon_max, lat_max, src.transform
                    )
                    window = window.intersection(
                        rasterio.windows.Window(0, 0, src.width, src.height)
                    )
                    if window.width < 1 or window.height < 1:
                        continue
                    data = src.read(1, window=window).astype(np.float32)
                    # Il prodotto ETH maschera le superfici non vegetate:
                    # sui centri urbani densi la gran parte dei pixel e'
                    # nodata, che per noi significa semplicemente "niente
                    # chioma qui".
                    valid = src.read_masks(1, window=window) > 0
                    if src.nodata is not None:
                        valid &= data != src.nodata
                    data = np.where(valid, data, 0.0)
                    pieces.append((data, src.window_transform(window)))
                    profile = src.profile
            except Exception as exc:
                log(f"    chiome {name} non leggibile: {exc}")

    if not pieces or profile is None:
        log("    altezza chiome non disponibile: procedo senza vegetazione")
        return None

    # Nell'uso tipico l'area sta dentro un solo tassello; se ne tocca piu'
    # d'uno li fondiamo su una griglia comune.
    if len(pieces) == 1:
        data, transform = pieces[0]
    else:
        from rasterio.merge import merge as rio_merge
        from rasterio.io import MemoryFile

        datasets = []
        for arr, tr in pieces:
            mem = MemoryFile()
            with mem.open(
                driver="GTiff",
                height=arr.shape[0],
                width=arr.shape[1],
                count=1,
                dtype=arr.dtype,
                crs=profile["crs"],
                transform=tr,
            ) as tmp:
                tmp.write(arr, 1)
            datasets.append(mem.open())
        data, transform = rio_merge(datasets)
        data = data[0]
        for ds in datasets:
            ds.close()

    # 255 e' il nodata ETH; le chiome plausibili stanno sotto i 60 m
    data = np.where((data > 60) | (data == 255), 0, data).astype(np.float32)

    with rasterio.open(
        dest,
        "w",
        driver="GTiff",
        height=data.shape[0],
        width=data.shape[1],
        count=1,
        dtype="float32",
        crs=profile["crs"],
        transform=transform,
        compress="deflate",
    ) as dst:
        dst.write(data, 1)

    log(f"    chiome {data.shape}, altezza max {float(data.max()):.1f} m")
    return dest


# --------------------------------------------------------------------------
# Copernicus HRL - densita' di copertura arborea
# --------------------------------------------------------------------------

TCD_URL = (
    "https://image.discomap.eea.europa.eu/arcgis/rest/services/GioLandPublic/"
    "HRL_TreeCoverDensity_2018/ImageServer/exportImage"
)


def fetch_tree_cover_density(bounds_wgs84, cache: Path, log=print) -> Path | None:
    """Densita' di copertura arborea 0-100 come GeoTIFF. None se il servizio fallisce.

    Serve a modulare la trasmissivita' delle chiome: un pino isolato ombreggia
    diversamente da un filare fitto di platani.
    """
    out_dir = cache / "copernicus"
    out_dir.mkdir(parents=True, exist_ok=True)
    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    dest = out_dir / (
        f"tcd_{lon_min:.3f}_{lat_min:.3f}_{lon_max:.3f}_{lat_max:.3f}.tif"
    )

    # Circa 10 m di risoluzione, entro il limite del servizio ArcGIS
    mid_lat = math.radians((lat_min + lat_max) / 2)
    width = int((lon_max - lon_min) * 111320 * math.cos(mid_lat) / 10)
    height = int((lat_max - lat_min) * 110540 / 10)
    width = min(max(width, 64), 4000)
    height = min(max(height, 64), 4000)

    params = {
        "bbox": f"{lon_min},{lat_min},{lon_max},{lat_max}",
        "bboxSR": "4326",
        "imageSR": "4326",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "U8",
        "noData": "255",
        "f": "image",
    }
    url = requests.Request("GET", TCD_URL, params=params).prepare().url

    try:
        return _download(url, dest, log=log, min_bytes=5000)
    except SourceError as exc:
        log(f"    densita' arborea non disponibile, uso valore di default: {exc}")
        return None


# --------------------------------------------------------------------------
# OpenStreetMap - rete percorribile
# --------------------------------------------------------------------------

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Tutto cio' su cui puo' transitare un pedone, una bici o una carrozzina.
# Il filtro per modalita' avviene piu' avanti, sul grafo.
_HIGHWAY_FILTER = (
    "footway|path|pedestrian|steps|living_street|residential|unclassified|"
    "service|track|cycleway|tertiary|secondary|primary|trunk|road"
)


def fetch_osm(bounds_wgs84, cache: Path, log=print) -> dict:
    """Scarica la rete percorribile da Overpass. Ritorna il JSON Overpass grezzo."""
    import json

    lon_min, lat_min, lon_max, lat_max = bounds_wgs84
    out_dir = cache / "osm"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / (
        f"net_{lon_min:.4f}_{lat_min:.4f}_{lon_max:.4f}_{lat_max:.4f}.json"
    )
    if dest.exists() and dest.stat().st_size > 1000:
        log(f"    cache: {dest.name}")
        return json.loads(dest.read_text())

    bbox = f"{lat_min},{lon_min},{lat_max},{lon_max}"
    query = f"""
    [out:json][timeout:180];
    (
      way["highway"~"{_HIGHWAY_FILTER}"]({bbox});
    );
    out body;
    >;
    out skel qt;
    """

    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            log(f"    query Overpass su {endpoint}")
            resp = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": USER_AGENT},
                timeout=240,
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("elements"):
                raise SourceError("Overpass ha risposto senza elementi")
            dest.write_text(json.dumps(data))
            ways = sum(1 for e in data["elements"] if e["type"] == "way")
            log(f"    {ways} archi stradali scaricati")
            return data
        except (requests.RequestException, ValueError, SourceError) as exc:
            log(f"    endpoint fallito: {exc}")
            last_error = exc

    raise SourceError(f"tutti gli endpoint Overpass hanno fallito: {last_error}")
