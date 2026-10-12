"""Esportazione di un'area in file statici, leggibili dal browser senza server.

La pipeline di preparazione resta quella di sempre e gira sul portatile: qui si
prende quello che ha prodotto (`dsm.tif`, `cdsm.tif`, `tcd.tif`, `graph.npz`) e
lo si riscrive in una forma che il client sa leggere da solo. Nessun servizio
applicativo in produzione: c'e' solo una cartella da mettere online.

Due scelte guidano il formato.

**La superficie va a tasselli** perche' un tragitto ne usa una striscia
sottile: scaricare l'intera citta' per attraversare tre isolati sarebbe lo
stesso spreco che il calcolo live ha appena tolto di mezzo. I tasselli sono
allineati alla griglia del raster, cosi' rimetterli insieme e' una copia di
righe e non una riproiezione.

**I dati sono binari compressi, non PNG.** Un tassello porta cinque byte per
pixel (quota su due, chioma su uno, densita' arborea su uno, costruito su uno)
e in un PNG non ci stanno senza usare il canale alfa, che passando dalla canvas
viene premoltiplicato e corrompe gli altri canali. Un blocco binario con `gzip`
davanti evita il problema, si legge con una vista tipizzata e comprime quanto
un PNG applicando prima la stessa differenza di riga che il PNG userebbe.

**Il terreno viaggia come altezza del costruito**, non come secondo piano di
quote. Servono tutti e due -- il DSM per le ombre com'erano, il terreno nudo
per disegnare le ombre degli edifici in geometria e per il rilievo -- ma sono
due superfici quasi identiche, e mandarle entrambe per intero vorrebbe dire
pagare due volte lo stesso profilo di collina. La differenza `dsm - dtm` invece
e' zero quasi ovunque e costante dentro ogni edificio: un byte per pixel che il
gzip riduce quasi a nulla, e il client ricostruisce il terreno sottraendo.
"""

from __future__ import annotations

import gzip
import json
import math
import shutil
import struct
from pathlib import Path

import numpy as np

# Lato del tassello in pixel. A 2 m sono 1024 m di citta': un tragitto tipico
# ne tocca da uno a quattro, e alla peggio (attraversamento diagonale della
# citta') una dozzina.
TILE = 512

# La veduta d'insieme: tutta l'area in un solo blocco, un pixel ogni quattro.
# Serve a disegnare le ombre sulla mappa quando si guarda la citta' da lontano,
# dove i tasselli a piena risoluzione sarebbero megabyte per mostrare un
# dettaglio che a quello zoom non si vede. A 8 m pesa quanto un tassello solo.
# E' la stessa scelta che il backend faceva con `render.PREVIEW_RESOLUTION`,
# spostata dal momento del disegno a quello dell'esportazione.
OVERVIEW_STEP = 4

# Quote in centimetri sopra la base del tassello: 655 m di dislivello dentro
# un chilometro quadrato non capitano in citta'. Se capitassero, il passo si
# raddoppia finche' basta, e il client legge comunque il fattore dal tassello.
Z_SCALE = 0.01
# Altezza della chioma in un solo byte. A 25 cm l'errore di quota si traduce
# in mezzo pixel d'ombra con il sole a 30 gradi: sotto la risoluzione.
CANOPY_SCALE = 0.25
CANOPY_MAX = 255 * CANOPY_SCALE

# Altezza del costruito, sempre in un byte. Si parte dallo stesso quarto di
# metro della chioma e si raddoppia finche' l'edificio piu' alto del tassello ci
# sta: in citta' non si muove mai da 0,25 m, ma un grattacielo non deve poter
# tagliare il terreno che ci sta sotto.
BUILT_SCALE = 0.25

TILE_MAGIC = b"OMBT"
TILE_VERSION = 2
TILE_HEADER = 28  # byte, vedi _tile_bytes

GRAPH_MAGIC = b"OMBG"
# La 2 ha aggiunto in coda `edge_traffic` (Fase 3 dell'asse comfort
# traffico): sempre presente in un export v2, a zero dove l'area non ha
# passato `traffico.calibra` (ogni citta' diversa da Ascoli, oggi). La 3
# (Fase 4 della variazione oraria) ha reso `edge_traffic` una matrice
# `[fasce x tratti]` invece di un vettore: subito dopo l'header fisso da 40
# byte scrive tre scalari (`n_traffic_slices`, `traffic_slice_start_min`,
# `traffic_slice_step_min`) che nella v1/v2 non esistono affatto, poi
# l'array appiattito. La 1 e la 2 si leggono ancora lato client: un'area
# esportata prima resta percorribile, semplicemente con l'asse traffico
# costante durante la giornata invece che a fasce (v1: zero ovunque; v2: il
# valore statico di allora, trattato come una singola fascia che copre
# tutto il giorno).
GRAPH_VERSION = 3
GRAPH_HEADER = 40

FLAG_CANOPY = 1
FLAG_TCD = 2
FLAG_BUILT = 4


# ---------------------------------------------------------------------------
# Superficie
# ---------------------------------------------------------------------------

def _row_delta(a: np.ndarray) -> np.ndarray:
    """Differenza col pixel a sinistra, come il filtro `Sub` del PNG.

    Su un modello di superficie i valori vicini si somigliano, e la differenza
    e' quasi sempre un numero piccolo: e' quello che rende comprimibile un
    dato di quota. L'aritmetica e' modulare, quindi il client ricostruisce
    l'originale con una somma cumulata dello stesso tipo intero.
    """
    out = a.copy()
    out[:, 1:] -= a[:, :-1]
    return out


def _tile_bytes(dsm_q, canopy_q, tcd_q, built_q, z_offset, z_scale, built_scale) -> bytes:
    """Serializza un tassello: intestazione piu' i piani presenti."""
    h, w = dsm_q.shape
    flags = 0
    if canopy_q is not None:
        flags |= FLAG_CANOPY
    if tcd_q is not None:
        flags |= FLAG_TCD
    if built_q is not None:
        flags |= FLAG_BUILT

    head = struct.pack(
        "<4sHHHHffff",
        TILE_MAGIC, TILE_VERSION, flags, w, h,
        float(z_offset), float(z_scale), float(CANOPY_SCALE), float(built_scale),
    )
    assert len(head) == TILE_HEADER, len(head)

    # I piani nuovi si aggiungono in coda, cosi' l'ordine di lettura di quelli
    # vecchi non cambia mai.
    parts = [head, _row_delta(dsm_q).tobytes()]
    if canopy_q is not None:
        parts.append(_row_delta(canopy_q).tobytes())
    if tcd_q is not None:
        parts.append(_row_delta(tcd_q).tobytes())
    if built_q is not None:
        parts.append(_row_delta(built_q).tobytes())
    return b"".join(parts)


def _quantize_tile(dsm, canopy, tcd, built):
    """Porta un tassello nei tipi interi con cui viaggia sulla rete."""
    finite = dsm[np.isfinite(dsm)]
    lo = float(np.floor(finite.min())) if finite.size else 0.0
    hi = float(finite.max()) if finite.size else 0.0

    # Il dislivello di un tassello di citta' sta sempre nei 655 m del passo
    # centimetrico. Il caso alpino non e' escluso a priori: il passo si allarga
    # quel tanto che basta e finisce nell'intestazione del tassello.
    z_scale = Z_SCALE
    while (hi - lo) / z_scale > 65535 and z_scale < 1.0:
        z_scale *= 2.0

    dsm_q = np.clip(np.round((dsm - lo) / z_scale), 0, 65535).astype("<u2")

    canopy_q = None
    if canopy is not None and float(canopy.max()) > 0.0:
        canopy_q = np.clip(
            np.round(np.clip(canopy, 0.0, CANOPY_MAX) / CANOPY_SCALE), 0, 255
        ).astype(np.uint8)

    tcd_q = None
    if tcd is not None and canopy_q is not None:
        tcd_q = np.clip(np.round(tcd), 0, 100).astype(np.uint8)

    built_q = None
    built_scale = BUILT_SCALE
    if built is not None and float(built.max()) > 0.0:
        while float(built.max()) / built_scale > 255 and built_scale < 4.0:
            built_scale *= 2.0
        built_q = np.clip(np.round(built / built_scale), 0, 255).astype(np.uint8)

    return dsm_q, canopy_q, tcd_q, built_q, lo, z_scale, built_scale


def export_surface(aoi, out_dir: Path, log=print) -> dict:
    """Scrive i tasselli di superficie e ne descrive la griglia.

    Il piano della chioma non e' `cdsm` ma la sua altezza sopra `dsm`: e' la
    sola cosa che il calcolo delle ombre legge davvero, visto che l'ostacolo
    della vegetazione e' `max(dsm, cdsm)`. Dove c'e' un edificio la chioma e'
    gia' stata azzerata in fase di costruzione della superficie, quindi la
    differenza e' nulla e la somma ricostruisce esattamente quel massimo.

    Il piano del costruito segue la stessa logica al contrario: e' `dsm - dtm`,
    cioe' quanto il costruito solleva il terreno, e il client ne ricava il
    terreno nudo sottraendolo dal DSM. Le due superfici sono nate insieme in
    `build_surface` sulla stessa griglia, quindi la differenza e' esatta.
    """
    import rasterio

    tiles_dir = out_dir / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    for old in tiles_dir.glob("*.bin.gz"):
        old.unlink()

    with rasterio.open(aoi.dsm_path) as src:
        dsm = src.read(1)
        transform = src.transform
        width, height = src.width, src.height

    built = None
    if aoi.dtm_path.exists():
        with rasterio.open(aoi.dtm_path) as src:
            dtm = src.read(1)
        built = np.maximum(dsm - dtm, 0.0).astype(np.float32)
        del dtm
        log(f"  costruito: fino a {built.max():.1f} m sopra il terreno")
    else:
        log("  costruito: nessun dtm.tif, il terreno non viaggia")

    canopy = None
    if aoi.cdsm_path.exists():
        with rasterio.open(aoi.cdsm_path) as src:
            cdsm = src.read(1)
        canopy = np.maximum(cdsm - dsm, 0.0).astype(np.float32)
        del cdsm
        if not np.any(canopy > 0):
            canopy = None

    tcd = None
    if canopy is not None and aoi.tcd_path.exists():
        with rasterio.open(aoi.tcd_path) as src:
            tcd = src.read(1)

    nx = (width + TILE - 1) // TILE
    ny = (height + TILE - 1) // TILE
    log(f"  superficie {width}x{height} px -> {nx}x{ny} = {nx * ny} tasselli")

    entries, total = [], 0
    for ty in range(ny):
        r0, r1 = ty * TILE, min((ty + 1) * TILE, height)
        for tx in range(nx):
            c0, c1 = tx * TILE, min((tx + 1) * TILE, width)
            dsm_q, canopy_q, tcd_q, built_q, z_off, z_scale, b_scale = _quantize_tile(
                dsm[r0:r1, c0:c1],
                None if canopy is None else canopy[r0:r1, c0:c1],
                None if tcd is None else tcd[r0:r1, c0:c1],
                None if built is None else built[r0:r1, c0:c1],
            )
            blob = gzip.compress(
                _tile_bytes(dsm_q, canopy_q, tcd_q, built_q, z_off, z_scale, b_scale), 9
            )
            name = f"{tx}_{ty}.bin.gz"
            (tiles_dir / name).write_bytes(blob)
            total += len(blob)
            entries.append(
                {
                    "x": tx,
                    "y": ty,
                    "url": f"tiles/{name}",
                    "width": c1 - c0,
                    "height": r1 - r0,
                    "bytes": len(blob),
                }
            )

    log(
        f"  {len(entries)} tasselli, {total / 1024 / 1024:.1f} MB in tutto "
        f"({total / len(entries) / 1024:.0f} kB l'uno)"
    )

    # ---- veduta d'insieme ----------------------------------------------
    # Si prende un pixel ogni `OVERVIEW_STEP` invece di mediarli: su un modello
    # di superficie la media smusserebbe gli spigoli dei tetti, che sono
    # proprio cio' che fa l'ombra.
    s = OVERVIEW_STEP
    dsm_q, canopy_q, tcd_q, built_q, z_off, z_scale, b_scale = _quantize_tile(
        dsm[::s, ::s],
        None if canopy is None else canopy[::s, ::s],
        None if tcd is None else tcd[::s, ::s],
        None if built is None else built[::s, ::s],
    )
    blob = gzip.compress(
        _tile_bytes(dsm_q, canopy_q, tcd_q, built_q, z_off, z_scale, b_scale), 9
    )
    (out_dir / "overview.bin.gz").write_bytes(blob)
    log(
        f"  veduta d'insieme {dsm_q.shape[1]}x{dsm_q.shape[0]} px a "
        f"{aoi.resolution * s:.0f} m: {len(blob) / 1024:.0f} kB"
    )

    return {
        "overview": {
            "url": "overview.bin.gz",
            "width": int(dsm_q.shape[1]),
            "height": int(dsm_q.shape[0]),
            "resolution": float(aoi.resolution * s),
            "bytes": len(blob),
        },
        "width": width,
        "height": height,
        # Spigolo alto-sinistra del pixel (0, 0) in coordinate UTM: da qui il
        # client ricava la posizione di ogni pixel senza altra geometria.
        "origin": [float(transform.c), float(transform.f)],
        "resolution": float(aoi.resolution),
        "tile_size": TILE,
        "tiles_x": nx,
        "tiles_y": ny,
        # In ordine di riga: il client indicizza con y * tiles_x + x.
        "tiles": entries,
        "bytes": total + len(blob),
    }


# ---------------------------------------------------------------------------
# Grafo
# ---------------------------------------------------------------------------

def _pad4(buf: bytearray) -> None:
    while len(buf) % 4:
        buf.append(0)


def export_graph(aoi, out_dir: Path, log=print) -> dict:
    """Scrive il grafo in un unico blocco binario, piu' l'elenco dei nomi.

    Rispetto al `.npz` cadono tre cose. I punti di campionamento dell'ombra
    (due terzi del peso) si ricostruiscono dagli estremi dei tratti con la
    stessa formula che li ha generati, quindi basta portarsi dietro quanti ne
    ha ciascun tratto. Le quote dei nodi servivano solo a calcolare le
    pendenze, che sono gia' qui. L'identificativo OSM della via non lo legge
    nessuno.

    Le coordinate metriche diventano millimetri interi rispetto a un'origine:
    un intero a 32 bit le rappresenta esattamente, mezzo peso del doppia
    precisione e nessun errore che possa spostare un campione di pixel.
    """
    from .graph import load_graph

    g = load_graph(aoi)

    node_xy = g["node_xy"]
    n_nodes = len(node_xy)
    n_edges = len(g["edge_len"])

    origin = np.floor(node_xy.min(axis=0))
    node_mm = np.round((node_xy - origin) * 1000.0).astype("<i4")

    # Quanti campioni d'ombra per tratto: stessa formula di `graph.build_graph`,
    # calcolata qui una volta sola perche' rifarla in virgola mobile dall'altra
    # parte potrebbe arrotondare diversamente su un tratto di lunghezza esatta.
    lengths = g["edge_len"]
    counts = np.maximum(2, np.ceil(lengths / 8.0).astype(int))
    if not np.array_equal(counts, np.diff(g["sample_offset"])):
        raise ValueError("il numero di campioni non coincide con quello salvato")

    names = [str(s) for s in g["names"]]
    edge_name = g["edge_name"]
    if edge_name.max(initial=0) > 65535:
        raise ValueError("troppi nomi di via per un indice a 16 bit")

    adj_target = g["adj_target"]
    adj_edge = g["adj_edge"]

    # Presente solo se `traffico.calibra` e' girata su quest'area (oggi solo
    # Ascoli Piceno): altrove una singola fascia di zeri, che sommata a costo
    # zero nel router equivale a "nessun dato", mai a un'ipotesi di traffico.
    edge_traffic = np.asarray(g["edge_traffic"]) if "edge_traffic" in g else np.zeros((1, n_edges), dtype=np.float32)
    if edge_traffic.ndim == 1:  # tutela un .npz mai piu' prodotto da calibra() dopo la v3
        edge_traffic = edge_traffic[np.newaxis, :]
    n_traffic_slices = int(edge_traffic.shape[0])
    traffic_slice_start = float(g["traffic_slice_start_min"]) if "traffic_slice_start_min" in g else 0.0
    traffic_slice_step = float(g["traffic_slice_step_min"]) if "traffic_slice_step_min" in g else 15.0

    buf = bytearray()
    buf += struct.pack(
        "<4sIIIIIdd",
        GRAPH_MAGIC, GRAPH_VERSION,
        n_nodes, n_edges, len(adj_target), int(counts.sum()),
        float(origin[0]), float(origin[1]),
    )
    assert len(buf) == GRAPH_HEADER, len(buf)

    for arr in (
        node_mm[:, 0], node_mm[:, 1],
        g["node_lonlat"][:, 0].astype("<f4"), g["node_lonlat"][:, 1].astype("<f4"),
        g["edge_u"].astype("<i4"), g["edge_v"].astype("<i4"),
        lengths.astype("<f4"), g["edge_slope"].astype("<f4"),
        g["edge_rough"].astype("<f4"),
        g["adj_start"].astype("<i4"), adj_target.astype("<i4"),
        adj_edge.astype("<i4"),
        edge_name.astype("<u2"), counts.astype("<u2"),
        g["edge_flags"].astype(np.uint8),
    ):
        buf += np.ascontiguousarray(arr).tobytes()
        _pad4(buf)

    # Metadati della griglia di fasce, solo in v3+: un u32 (quante fasce) e
    # due float32 (inizio e passo in minuti dalla mezzanotte). Gia' allineati
    # a 4 byte, nessun padding necessario, ma _pad4 resta un no-op sicuro.
    buf += struct.pack("<Iff", n_traffic_slices, traffic_slice_start, traffic_slice_step)
    _pad4(buf)
    buf += np.ascontiguousarray(edge_traffic.astype("<f4")).tobytes()
    _pad4(buf)

    blob = gzip.compress(bytes(buf), 9)
    (out_dir / "graph.bin.gz").write_bytes(blob)
    log(
        f"  grafo {n_nodes} nodi, {n_edges} tratti: "
        f"{len(buf) / 1024:.0f} kB -> {len(blob) / 1024:.0f} kB compressi"
    )

    return {
        "url": "graph.bin.gz",
        "bytes": len(blob),
        "raw_bytes": len(buf),
        "nodes": n_nodes,
        "edges": n_edges,
        "samples": int(counts.sum()),
        "names": names,
    }


# ---------------------------------------------------------------------------
# Terreno (fase 3 - rilievo 3D)
# ---------------------------------------------------------------------------
#
# MapLibre vuole il terreno come sorgente `raster-dem`: tessere XYZ in Web
# Mercator, codifica Terrarium (altezza = R*256 + G + B/256 - 32768). Il DTM
# che gia' abbiamo (EPSG:32633, 2 m) viene solo riproiettato tassello per
# tassello, non ricampionato una volta sola: cosi' ogni tassello ha la sua
# griglia esatta in EPSG:3857 senza passare da un mosaico intermedio.
#
# Zoom 12-15: alla scala di Ascoli (3,4 km di lato) sono poche decine di
# tessere in tutto, dal profilo della valle (z12) a un dettaglio vicino a
# quello del DTM sorgente (z15, circa 4,8 m/px alla nostra latitudine).

TERRAIN_TILE = 256
TERRAIN_MIN_ZOOM = 12
TERRAIN_MAX_ZOOM = 15
WEB_MERCATOR_EXTENT = 20037508.342789244  # metri, meta' della circonferenza

# Margine oltre la larghezza stimata dell'impalcato (graph._bridge_width),
# aggiunto solo qui, sul corridoio bruciato nel rilievo. Verificato di
# persona: con la sola larghezza stradale (2-6 m) il corridoio spariva quasi
# del tutto nella tessera z15 (~4,8 m/px) -- `queryTerrainElevation` di
# MapLibre tornava al fondovalle a pochi metri dal centro del ponte, per
# arrotondamenti fra il campionamento bilineare e il percorso disegnato.
# Il margine e' voluto grande: qui non serve la sagoma vera dell'impalcato,
# serve solo che non si sprofondi.
BRIDGE_BURN_MARGIN_M = 8.0


def _quota_impalcati(aoi, shape, transform, log=print) -> np.ndarray | None:
    """Quota dell'impalcato dei ponti su un corridoio largo quanto la strada,
    nella stessa griglia del DTM sorgente. `None` dove non c'e' un ponte.

    Il DTM e' terreno nudo: sotto un ponte campiona il letto del fiume o la
    scarpata, non l'impalcato. `graph.build_graph` ha gia' interpolato la
    quota dei nodi-ponte fra le due spalle (vedi `bridge_interp` li'); qui si
    ridisegna quel corridoio nella griglia raster cosi' che anche il rilievo
    esportato -- da cui il client drappeggia percorso, edifici e ombre --
    mostri un impalcato in piano invece di una valle da scendere e risalire.
    """
    from rasterio.features import rasterize
    from shapely.geometry import LineString

    from .graph import load_graph

    if not aoi.graph_path.exists():
        return None
    g = load_graph(aoi)
    edge_bridge = g["edge_bridge"]
    if not edge_bridge.any():
        return None

    node_xy = g["node_xy"]
    node_z = g["node_z"]
    edge_u, edge_v = g["edge_u"], g["edge_v"]
    width = g["edge_bridge_width"]

    shapes = []
    for i in np.nonzero(edge_bridge)[0]:
        p0, p1 = node_xy[edge_u[i]], node_xy[edge_v[i]]
        line = LineString([p0, p1])
        if line.length < 1e-6:
            continue
        z = 0.5 * (node_z[edge_u[i]] + node_z[edge_v[i]])
        raggio = max(float(width[i]), 1.0) / 2.0 + BRIDGE_BURN_MARGIN_M
        shapes.append((line.buffer(raggio), float(z)))
    if not shapes:
        return None

    deck = rasterize(shapes, out_shape=shape, transform=transform, fill=np.nan, dtype=np.float32)
    log(f"  impalcati: {int(edge_bridge.sum())} tratti-ponte, {int(np.isfinite(deck).sum())} celle rialzate")
    return deck


def _lonlat_a_tassello(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Indice (x, y) del tassello XYZ che contiene un punto in gradi."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    lat_rad = math.radians(lat)
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def _riquadro_tassello_3857(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    """Estensione in metri Web Mercator del tassello XYZ (x, y, z)."""
    n = 2**z
    lato = 2 * WEB_MERCATOR_EXTENT / n
    x0 = -WEB_MERCATOR_EXTENT + x * lato
    y1 = WEB_MERCATOR_EXTENT - y * lato
    return x0, y1 - lato, x0 + lato, y1


def _codifica_terrarium(quota: np.ndarray) -> np.ndarray:
    """Quota in metri -> RGB Terrarium (24 bit, precisione 1/256 m)."""
    valore = np.clip(np.round((quota + 32768.0) * 256.0), 0, 256**3 - 1).astype(np.int64)
    r = (valore >> 16) & 0xFF
    g = (valore >> 8) & 0xFF
    b = valore & 0xFF
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def export_terrain(aoi, out_dir: Path, log=print) -> dict | None:
    """Esporta il DTM come tessere raster-dem per l'illuminazione 3D di MapLibre."""
    if not aoi.dtm_path.exists():
        log("  terreno: nessun dtm.tif, il rilievo 3D resta spento")
        return None

    import rasterio
    from PIL import Image
    from rasterio import Affine
    from rasterio.warp import Resampling, reproject

    terrain_dir = out_dir / "terrain"
    if terrain_dir.exists():
        shutil.rmtree(terrain_dir)

    lon_min, lat_min, lon_max, lat_max = aoi.buffered_bounds

    with rasterio.open(aoi.dtm_path) as src:
        src_crs, src_transform = src.crs, src.transform
        dtm = src.read(1)
        nodata = src.nodata

    deck = _quota_impalcati(aoi, dtm.shape, src_transform, log=log)
    if deck is not None:
        rialzato = np.isfinite(deck)
        dtm = np.where(rialzato, deck, dtm).astype(dtm.dtype, copy=False)

    conteggio, totale_byte = 0, 0
    for z in range(TERRAIN_MIN_ZOOM, TERRAIN_MAX_ZOOM + 1):
        tx0, ty0 = _lonlat_a_tassello(lon_min, lat_max, z)  # nord-ovest
        tx1, ty1 = _lonlat_a_tassello(lon_max, lat_min, z)  # sud-est
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                x0, y0, x1, y1 = _riquadro_tassello_3857(tx, ty, z)
                dst_transform = Affine(
                    (x1 - x0) / TERRAIN_TILE, 0, x0,
                    0, -(y1 - y0) / TERRAIN_TILE, y1,
                )
                dst = np.full((TERRAIN_TILE, TERRAIN_TILE), np.nan, dtype=np.float32)
                reproject(
                    source=dtm,
                    destination=dst,
                    src_transform=src_transform,
                    src_crs=src_crs,
                    src_nodata=nodata,
                    dst_transform=dst_transform,
                    dst_crs="EPSG:3857",
                    dst_nodata=np.nan,
                    resampling=Resampling.bilinear,
                )
                if not np.any(np.isfinite(dst)):
                    continue  # tassello fuori dal DTM esportato

                rgb = _codifica_terrarium(np.where(np.isfinite(dst), dst, 0.0))
                cartella = terrain_dir / str(z) / str(tx)
                cartella.mkdir(parents=True, exist_ok=True)
                percorso = cartella / f"{ty}.png"
                Image.fromarray(rgb, mode="RGB").save(percorso, optimize=True)
                conteggio += 1
                totale_byte += percorso.stat().st_size

    if conteggio == 0:
        log("  terreno: nessuna tessera dentro il riquadro, salto")
        return None

    log(
        f"  terreno {conteggio} tessere raster-dem (z{TERRAIN_MIN_ZOOM}-{TERRAIN_MAX_ZOOM}), "
        f"{totale_byte / 1024:.0f} kB in tutto"
    )
    return {
        "tiles": "terrain/{z}/{x}/{y}.png",
        "encoding": "terrarium",
        "tile_size": TERRAIN_TILE,
        "minzoom": TERRAIN_MIN_ZOOM,
        "maxzoom": TERRAIN_MAX_ZOOM,
        "count": conteggio,
        "bytes": totale_byte,
    }


# ---------------------------------------------------------------------------
# Area completa
# ---------------------------------------------------------------------------

def export_area(aoi, root: Path, log=print) -> dict:
    """Esporta un'area intera: tasselli, grafo, edifici e manifesto."""
    out_dir = Path(root) / aoi.slug
    out_dir.mkdir(parents=True, exist_ok=True)

    surface = export_surface(aoi, out_dir, log=log)
    graph = export_graph(aoi, out_dir, log=log)
    terrain = export_terrain(aoi, out_dir, log=log)

    buildings = None
    if aoi.buildings_path.exists():
        shutil.copyfile(aoi.buildings_path, out_dir / "buildings.geojson")
        buildings = {
            "url": "buildings.geojson",
            "bytes": aoi.buildings_path.stat().st_size,
        }
        log(f"  edifici {buildings['bytes'] / 1024:.0f} kB")

    traffic = None
    if aoi.traffic_stats_path.exists():
        traffic = json.loads(aoi.traffic_stats_path.read_text())
        log("  traffico: riepilogo calibrazione incluso nel manifesto")

    w, h = aoi.size_km
    manifest = {
        "version": 1,
        "slug": aoi.slug,
        "name": aoi.name,
        "bounds": list(aoi.bounds),
        "center": list(aoi.center),
        "size_km": [round(w, 3), round(h, 3)],
        "timezone": aoi.timezone,
        "utm_epsg": aoi.utm_epsg,
        "resolution": aoi.resolution,
        "segment_length": aoi.segment_length,
        "step_minutes": aoi.step_minutes,
        "buffer_m": aoi.buffer_m,
        "surface": surface,
        "graph": graph,
        "buildings": buildings,
        "terrain": terrain,
        "traffic": traffic,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))

    total = (
        surface["bytes"] + graph["bytes"]
        + (buildings["bytes"] if buildings else 0)
        + (terrain["bytes"] if terrain else 0)
    )
    log(f"  area esportata in {out_dir} ({total / 1024 / 1024:.1f} MB)")
    return manifest


def write_index(root: Path, log=print) -> list[dict]:
    """Riscrive l'indice delle aree disponibili leggendo i manifesti presenti."""
    root = Path(root)
    aree = []
    for manifest_path in sorted(root.glob("*/manifest.json")):
        m = json.loads(manifest_path.read_text())
        aree.append(
            {
                "slug": m["slug"],
                "name": m["name"],
                "bounds": m["bounds"],
                "center": m["center"],
                "size_km": m["size_km"],
                "timezone": m["timezone"],
                "url": f"{m['slug']}/manifest.json",
            }
        )
    (root / "aree.json").write_text(json.dumps(aree, indent=1))
    log(f"  indice aggiornato: {', '.join(a['slug'] for a in aree) or 'nessuna area'}")
    return aree
