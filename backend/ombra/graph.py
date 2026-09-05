"""Costruzione del grafo percorribile a partire dalla rete OpenStreetMap.

Le vie OSM vengono tagliate ai nodi di giunzione e poi suddivise in tratti
brevi. Tratti corti servono a tre cose: agganciare con precisione un punto
cliccato sulla mappa, dare al router una granularita' temporale fine mentre
il sole si sposta, e permettere di colorare il percorso tratto per tratto in
base all'esposizione.

Per ogni tratto vengono precalcolati lunghezza, pendenza con segno,
permessi di transito per modalita' e i punti dove campionare l'ombra.
"""

from __future__ import annotations

import numpy as np

# Bit di accesso per modalita'
FOOT = 1
BIKE = 2
WHEELCHAIR = 4

MODE_BITS = {"foot": FOOT, "bike": BIKE, "wheelchair": WHEELCHAIR}

# Strade dove un pedone non ha nulla da fare
_FORBIDDEN_FOOT = {"motorway", "motorway_link", "trunk", "trunk_link"}
# Scomodita' della pavimentazione, da 0 (asfalto liscio) a 1 (impraticabile).
# Il selciato di un centro storico non e' un divieto: e' una fatica. Trattarlo
# come divieto scollegherebbe l'intero centro di citta' come Ascoli, lastricata
# in travertino. Diventa quindi un costo, e solo i fondi davvero cedevoli
# restano esclusi.
_SURFACE_ROUGHNESS = {
    "asphalt": 0.0, "concrete": 0.0, "paved": 0.05, "concrete:plates": 0.15,
    "paving_stones": 0.25, "compacted": 0.35, "wood": 0.35,
    "fine_gravel": 0.55, "cobblestone": 0.7, "sett": 0.7, "unpaved": 0.7,
    "gravel": 0.8, "pebblestone": 0.85, "ground": 0.85, "dirt": 0.85,
    "earth": 0.85, "woodchips": 0.9, "grass": 0.9, "mud": 1.0, "sand": 1.0,
}
# Oltre questa scomodita' una carrozzina non passa davvero
ROUGHNESS_IMPASSABLE = 0.9
_DEFAULT_ROUGHNESS = 0.1
# Il limite normativo per una rampa accessibile e' l'8%, ma la pendenza qui
# e' stimata da un modello del terreno a 10 m su tratti di 25 m: l'errore e'
# dell'ordine del 4%, abbastanza da bocciare strade percorribili e spezzare
# la rete in tronconi scollegati. La pendenza viene quindi usata soprattutto
# come costo (vedi router.edge_speeds, che a queste pendenze rallenta
# moltissimo) e come divieto solo oltre una soglia che il rumore del dato non
# puo' inventarsi.
WHEELCHAIR_MAX_SLOPE = 0.15

# Larghezza stimata dell'impalcato quando il tag OSM `width` manca, per
# classe stradale. Serve solo a "bruciare" un corridoio nel DTM esportato
# (vedi export.export_terrain): non e' una misura, e' una stima grossolana
# quanto basta a non far vedere il rilievo che si tuffa sotto il ponte.
_BRIDGE_WIDTH_M = {
    "motorway": 12.0, "motorway_link": 8.0, "trunk": 10.0, "trunk_link": 7.0,
    "primary": 9.0, "primary_link": 6.0, "secondary": 8.0, "secondary_link": 6.0,
    "tertiary": 7.0, "residential": 6.0, "unclassified": 6.0, "living_street": 5.0,
    "service": 4.0, "track": 3.0, "cycleway": 2.5, "footway": 2.0, "path": 1.5,
    "pedestrian": 4.0, "steps": 2.0, "road": 5.0,
}
_BRIDGE_WIDTH_DEFAULT = 5.0


def _is_bridge(tags: dict) -> bool:
    """Vero se la via e' un impalcato sopraelevato.

    Il tag OSM `bridge` vale "no" per default e un valore esplicito (yes,
    viaduct, aqueduct, boardwalk, ...) quando la via e' davvero sollevata dal
    terreno: qualunque valore diverso da "no"/assente conta.
    """
    value = tags.get("bridge")
    return bool(value) and value != "no"


def _bridge_width(tags: dict) -> float:
    """Larghezza in metri: dal tag OSM `width` se c'e' un numero valido,
    altrimenti una stima dalla classe stradale."""
    raw = tags.get("width")
    if raw:
        try:
            return float(str(raw).split()[0].replace(",", "."))
        except ValueError:
            pass
    return _BRIDGE_WIDTH_M.get(tags.get("highway", ""), _BRIDGE_WIDTH_DEFAULT)


def _roughness(tags: dict) -> float:
    """Scomodita' del fondo stradale, da 0 a 1, dai tag OSM."""
    surface = tags.get("surface")
    if surface is None:
        # Senza indicazione si assume una pavimentazione ordinaria, tranne
        # sui sentieri, dove il fondo naturale e' la norma.
        return 0.6 if tags.get("highway") in ("path", "track") else _DEFAULT_ROUGHNESS
    return _SURFACE_ROUGHNESS.get(surface, _DEFAULT_ROUGHNESS)


def _access(tags: dict) -> int:
    """Bitmask delle modalita' ammesse su una via, secondo i tag OSM."""
    highway = tags.get("highway", "")
    mask = 0

    # ---- pedoni ----
    foot_tag = tags.get("foot")
    if foot_tag in ("no", "private"):
        pass
    elif highway in _FORBIDDEN_FOOT and foot_tag not in ("yes", "designated", "permissive"):
        pass
    elif highway == "cycleway" and foot_tag not in ("yes", "designated", "permissive"):
        pass  # pista ciclabile pura: il pedone non ci cammina
    else:
        mask |= FOOT

    # ---- bici ----
    bike_tag = tags.get("bicycle")
    if bike_tag in ("no", "private", "dismount"):
        pass
    elif highway == "steps":
        pass
    elif highway == "cycleway" or bike_tag in ("yes", "designated", "permissive"):
        mask |= BIKE
    elif highway in _FORBIDDEN_FOOT:
        pass
    elif highway in ("footway", "pedestrian", "path"):
        # Ammessi solo se esplicitamente consentiti, gia' coperto sopra
        pass
    else:
        mask |= BIKE

    # ---- carrozzina ----
    # Si esclude solo cio' che e' davvero impraticabile: gradini, divieti
    # espliciti e fondi cedevoli. Il resto e' scomodo, non impossibile, e
    # viene pagato in velocita' dal router.
    wc_tag = tags.get("wheelchair")
    if wc_tag == "no":
        pass
    elif highway == "steps":
        pass
    elif _roughness(tags) >= ROUGHNESS_IMPASSABLE and wc_tag != "yes":
        pass
    elif highway in _FORBIDDEN_FOOT:
        pass
    elif mask & FOOT:
        mask |= WHEELCHAIR

    return mask


def _resample_polyline(xy: np.ndarray, target: float) -> np.ndarray:
    """Ricampiona una polilinea inserendo vertici a passo ~target metri.

    I vertici originali vengono mantenuti: la geometria resta fedele e i
    tratti aggiunti servono solo ad accorciare gli archi.
    """
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    total = float(seg.sum())
    if total <= target or len(xy) < 2:
        return xy

    n_cuts = int(np.ceil(total / target))
    wanted = np.linspace(0.0, total, n_cuts + 1)[1:-1]
    cumulative = np.concatenate([[0.0], np.cumsum(seg)])

    out = [xy[0]]
    vi, ci = 1, 0
    while vi < len(xy) or ci < len(wanted):
        next_vertex = cumulative[vi] if vi < len(xy) else np.inf
        next_cut = wanted[ci] if ci < len(wanted) else np.inf
        if next_cut < next_vertex - 1e-9:
            k = int(np.searchsorted(cumulative, next_cut, side="right") - 1)
            k = min(max(k, 0), len(seg) - 1)
            f = (next_cut - cumulative[k]) / max(seg[k], 1e-9)
            out.append(xy[k] + f * (xy[k + 1] - xy[k]))
            ci += 1
        else:
            out.append(xy[vi])
            vi += 1
    return np.array(out)


def build_graph(aoi, osm_json: dict, log=print) -> dict:
    """Costruisce e salva il grafo percorribile dell'area.

    Ritorna un dizionario di statistiche.
    """
    import rasterio
    from pyproj import Transformer

    nodes_raw = {
        el["id"]: (el["lon"], el["lat"])
        for el in osm_json["elements"]
        if el["type"] == "node"
    }
    ways = [el for el in osm_json["elements"] if el["type"] == "way" and el.get("nodes")]
    log(f"  {len(ways)} vie, {len(nodes_raw)} vertici grezzi da OSM")

    # Un vertice e' una giunzione se appartiene a piu' di una via oppure se
    # e' l'estremita' di una via: li' il grafo deve poter cambiare strada.
    usage: dict[int, int] = {}
    for w in ways:
        for nid in w["nodes"]:
            usage[nid] = usage.get(nid, 0) + 1
    junctions = {nid for nid, c in usage.items() if c > 1}
    for w in ways:
        junctions.add(w["nodes"][0])
        junctions.add(w["nodes"][-1])

    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{aoi.utm_epsg}", always_xy=True)

    node_index: dict[tuple, int] = {}
    node_xy: list[tuple[float, float]] = []

    def node_id(x: float, y: float) -> int:
        """Indice del nodo alla posizione data, con arrotondamento a 10 cm."""
        key = (round(x, 1), round(y, 1))
        idx = node_index.get(key)
        if idx is None:
            idx = len(node_xy)
            node_index[key] = idx
            node_xy.append((x, y))
        return idx

    edges_u, edges_v, edges_flags, edges_way = [], [], [], []
    edges_rough = []
    edge_coords: list[np.ndarray] = []
    names: list[str] = []
    name_index: dict[str, int] = {}
    edges_name = []
    edges_bridge, edges_bridge_width = [], []
    # (indice del nodo interno, indice della spalla iniziale, indice della
    # spalla finale, frazione 0..1 lungo il ponte): risolto in quota dopo che
    # node_z e' stato campionato dal DTM, vedi piu' sotto.
    bridge_interp: list[tuple[int, int, int, float]] = []

    for way in ways:
        tags = way.get("tags", {})
        mask = _access(tags)
        if mask == 0:
            continue
        rough = _roughness(tags)
        is_bridge = _is_bridge(tags)
        bridge_width = _bridge_width(tags) if is_bridge else 0.0

        name = tags.get("name") or tags.get("highway", "")
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        name_idx = name_index[name]

        seq = [n for n in way["nodes"] if n in nodes_raw]
        if len(seq) < 2:
            continue

        # Spezziamo la via in pezzi delimitati dalle giunzioni
        pieces, current = [], [seq[0]]
        for nid in seq[1:]:
            current.append(nid)
            if nid in junctions:
                pieces.append(current)
                current = [nid]
        if len(current) > 1:
            pieces.append(current)

        for piece in pieces:
            lonlat = np.array([nodes_raw[n] for n in piece], dtype=np.float64)
            xs, ys = to_utm.transform(lonlat[:, 0], lonlat[:, 1])
            xy = np.column_stack([xs, ys])
            xy = _resample_polyline(xy, aoi.segment_length)

            if is_bridge and len(xy) >= 3:
                # Le due spalle sono gli estremi del pezzo (giunzioni, o fine
                # via): li' il DTM e' terreno vero. I nodi in mezzo prendono
                # una quota interpolata invece del fondovalle che il DTM
                # campionerebbe sotto l'impalcato.
                seg_len = np.linalg.norm(np.diff(xy, axis=0), axis=1)
                cum = np.concatenate([[0.0], np.cumsum(seg_len)])
                total = cum[-1]
                if total > 1e-6:
                    start_id = node_id(*xy[0])
                    end_id = node_id(*xy[-1])
                    for k in range(1, len(xy) - 1):
                        bridge_interp.append(
                            (node_id(*xy[k]), start_id, end_id, float(cum[k] / total))
                        )

            for i in range(len(xy) - 1):
                a, b = xy[i], xy[i + 1]
                if np.linalg.norm(b - a) < 0.5:
                    continue
                edges_u.append(node_id(*a))
                edges_v.append(node_id(*b))
                edges_flags.append(mask)
                edges_rough.append(rough)
                edges_way.append(way["id"])
                edges_name.append(name_idx)
                edges_bridge.append(is_bridge)
                edges_bridge_width.append(bridge_width)
                edge_coords.append(np.array([a, b]))

    if not edges_u:
        raise ValueError("nessun arco percorribile trovato nell'area")

    node_xy_arr = np.array(node_xy, dtype=np.float64)
    edges_u = np.array(edges_u, dtype=np.int32)
    edges_v = np.array(edges_v, dtype=np.int32)
    edges_flags = np.array(edges_flags, dtype=np.uint8)
    edges_rough = np.array(edges_rough, dtype=np.float32)
    edges_bridge = np.array(edges_bridge, dtype=bool)
    edges_bridge_width = np.array(edges_bridge_width, dtype=np.float32)

    ax, ay = node_xy_arr[edges_u, 0], node_xy_arr[edges_u, 1]
    bx, by = node_xy_arr[edges_v, 0], node_xy_arr[edges_v, 1]
    lengths = np.hypot(bx - ax, by - ay).astype(np.float32)

    # ---- pendenza dal modello del terreno ------------------------------
    slopes = np.zeros(len(edges_u), dtype=np.float32)
    node_z = np.zeros(len(node_xy_arr), dtype=np.float32)
    if aoi.dtm_path.exists():
        with rasterio.open(aoi.dtm_path) as src:
            dtm = src.read(1)
            inv = ~src.transform
            cols, rows = inv * (node_xy_arr[:, 0], node_xy_arr[:, 1])
            cols = np.clip(np.floor(cols).astype(int), 0, dtm.shape[1] - 1)
            rows = np.clip(np.floor(rows).astype(int), 0, dtm.shape[0] - 1)
            node_z = dtm[rows, cols].astype(np.float32)

        # I nodi interni di un tratto-ponte non stanno sul terreno nudo che
        # il DTM campiona li' sotto (il letto del fiume, una scarpata): la
        # loro quota diventa l'interpolazione fra le due spalle calcolata
        # sopra. Senza questo un ponte risultava ripidissimo (o impraticabile
        # in carrozzina) semplicemente perche' il DTM sotto scende e risale.
        for node_idx, start_idx, end_idx, frac in bridge_interp:
            z0, z1 = node_z[start_idx], node_z[end_idx]
            node_z[node_idx] = z0 + frac * (z1 - z0)

        slopes = ((node_z[edges_v] - node_z[edges_u]) / np.maximum(lengths, 1.0)).astype(
            np.float32
        )
        # Il DTM a 10 m non risolve gradini e rampe: pendenze oltre il 50%
        # su un tratto stradale sono rumore, non realta'.
        slopes = np.clip(slopes, -0.5, 0.5)
        log(f"  pendenza media assoluta {np.abs(slopes).mean() * 100:.1f}%")
        if edges_bridge.any():
            log(f"  {int(edges_bridge.sum())} tratti su impalcato (ponti)")

    # Le pendenze forti tolgono l'accesso alla carrozzina
    too_steep = np.abs(slopes) > WHEELCHAIR_MAX_SLOPE
    clear_wheelchair = np.uint8(0xFF ^ WHEELCHAIR)
    edges_flags = np.where(
        too_steep, edges_flags & clear_wheelchair, edges_flags
    ).astype(np.uint8)

    # ---- punti di campionamento dell'ombra -----------------------------
    # Un punto ogni ~8 m lungo il tratto, agli estremi esclusi: cosi' la
    # frazione d'ombra e' rappresentativa di tutto il tratto e non solo del
    # suo centro (importante sotto un filare di alberi).
    counts = np.maximum(2, np.ceil(lengths / 8.0).astype(int))
    offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.int32)
    total_samples = int(offsets[-1])
    samp_xy = np.empty((total_samples, 2), dtype=np.float64)
    for i in range(len(edges_u)):
        n = counts[i]
        f = (np.arange(n) + 0.5) / n
        samp_xy[offsets[i] : offsets[i + 1], 0] = ax[i] + f * (bx[i] - ax[i])
        samp_xy[offsets[i] : offsets[i + 1], 1] = ay[i] + f * (by[i] - ay[i])

    # ---- geometria in gradi per il frontend ----------------------------
    to_wgs = Transformer.from_crs(f"EPSG:{aoi.utm_epsg}", "EPSG:4326", always_xy=True)
    node_lon, node_lat = to_wgs.transform(node_xy_arr[:, 0], node_xy_arr[:, 1])
    node_lonlat = np.column_stack([node_lon, node_lat]).astype(np.float32)

    # ---- liste di adiacenza (CSR) --------------------------------------
    # Il grafo e' bidirezionale: ogni tratto e' percorribile nei due sensi.
    n_nodes = len(node_xy_arr)
    src_all = np.concatenate([edges_u, edges_v])
    dst_all = np.concatenate([edges_v, edges_u])
    eid_all = np.concatenate([np.arange(len(edges_u)), np.arange(len(edges_u))]).astype(
        np.int32
    )
    order = np.argsort(src_all, kind="stable")
    adj_target = dst_all[order].astype(np.int32)
    adj_edge = eid_all[order]
    adj_start = np.zeros(n_nodes + 1, dtype=np.int32)
    np.add.at(adj_start, src_all.astype(np.int64) + 1, 1)
    adj_start = np.cumsum(adj_start).astype(np.int32)

    aoi.graph_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        aoi.graph_path,
        node_xy=node_xy_arr,
        node_lonlat=node_lonlat,
        node_z=node_z,
        edge_u=edges_u,
        edge_v=edges_v,
        edge_len=lengths,
        edge_slope=slopes,
        edge_flags=edges_flags,
        edge_rough=edges_rough,
        edge_bridge=edges_bridge,
        edge_bridge_width=edges_bridge_width,
        edge_way=np.array(edges_way, dtype=np.int64),
        edge_name=np.array(edges_name, dtype=np.int32),
        sample_offset=offsets,
        sample_xy=samp_xy,
        adj_start=adj_start,
        adj_target=adj_target,
        adj_edge=adj_edge,
        names=np.array(names, dtype=object),
    )

    stats = {
        "nodes": int(n_nodes),
        "edges": int(len(edges_u)),
        "total_km": float(lengths.sum() / 1000),
        "samples": total_samples,
        "foot_km": float(lengths[(edges_flags & FOOT) > 0].sum() / 1000),
        "bike_km": float(lengths[(edges_flags & BIKE) > 0].sum() / 1000),
        "wheelchair_km": float(lengths[(edges_flags & WHEELCHAIR) > 0].sum() / 1000),
        "mean_roughness": float(edges_rough.mean()),
    }
    log(
        f"  {stats['nodes']} nodi, {stats['edges']} tratti, "
        f"{stats['total_km']:.1f} km di rete"
    )
    log(
        f"  percorribile: {stats['foot_km']:.1f} km a piedi, "
        f"{stats['bike_km']:.1f} km in bici, "
        f"{stats['wheelchair_km']:.1f} km in carrozzina"
    )
    return stats


def load_graph(aoi) -> dict:
    """Rilegge il grafo salvato come dizionario di array numpy."""
    data = np.load(aoi.graph_path, allow_pickle=True)
    return {k: data[k] for k in data.files}
