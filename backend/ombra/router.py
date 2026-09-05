"""Calcolo del percorso piu' fresco, con il sole che si sposta durante il tragitto.

Il problema non e' il cammino minimo classico: il costo di un tratto dipende
da quando ci si passa. Un vicolo che alle 9 e' in ombra alle 15 e' una
fornace, e mentre si cammina il sole continua a spostarsi.

L'algoritmo e' un Dijkstra dipendente dal tempo. Ogni etichetta porta con se'
sia il costo accumulato sia il tempo di percorrenza accumulato; il tempo
determina quale riga della matrice di esposizione usare per valutare il
tratto successivo. Poiche' il tempo di percorrenza di un tratto non dipende
dall'orario (si cammina alla stessa velocita' tutto il giorno), vale la
proprieta' FIFO e Dijkstra resta corretto.

Il costo di un tratto e':

    tempo_percorrenza x (1 + alpha x esposizione x carico_solare)

dove alpha e' quanto l'utente detesta il sole, l'esposizione e' la frazione
di tratto illuminata a quell'ora, e il carico solare pesa il fatto che il
sole delle 8 scalda molto meno di quello delle 14.
"""

from __future__ import annotations

import heapq

import numpy as np

from . import solar
from .graph import MODE_BITS

# Velocita' di base in km/h su terreno pianeggiante
BASE_SPEED = {"foot": 5.0, "bike": 16.0, "wheelchair": 3.6}

# Il passo temporale con cui si discretizza il costo durante il tragitto.
# Piu' fine di cosi' non cambia nulla: in 2 minuti il sole si sposta di mezzo grado.
COST_BIN_MINUTES = 2.0

# Durata massima ammessa per un tragitto, oltre la quale si rinuncia
MAX_TRIP_MINUTES = 240.0


class RoutingError(RuntimeError):
    """Richiesta di percorso non soddisfacibile."""


# Quanto la scomodita' del fondo rallenta ciascuna modalita'
_ROUGHNESS_PENALTY = {"foot": 0.18, "bike": 0.45, "wheelchair": 0.7}


def edge_speeds(mode: str, slope: np.ndarray, rough: np.ndarray | None = None) -> np.ndarray:
    """Velocita' di percorrenza in m/s per ogni tratto, data pendenza e fondo.

    A piedi si usa la funzione di Tobler, che descrive bene sia la fatica in
    salita sia il rallentamento nelle discese ripide. Per bici e carrozzina
    la penalita' in salita e' molto piu' marcata. Il fondo stradale pesa poco
    a piedi e moltissimo su due ruote piccole.
    """
    base = BASE_SPEED[mode]

    if mode == "foot":
        kmh = 6.0 * np.exp(-3.5 * np.abs(slope + 0.05))
    elif mode == "bike":
        uphill = base * np.exp(-9.0 * np.clip(slope, 0.0, None))
        downhill = base * (1.0 + 2.5 * np.clip(-slope, 0.0, None))
        kmh = np.where(slope > 0, uphill, np.minimum(downhill, base * 1.6))
    else:  # carrozzina
        uphill = base * np.exp(-14.0 * np.clip(slope, 0.0, None))
        downhill = base * (1.0 + 0.8 * np.clip(-slope, 0.0, None))
        kmh = np.where(slope > 0, uphill, np.minimum(downhill, base * 1.25))

    if rough is not None:
        kmh = kmh * (1.0 - _ROUGHNESS_PENALTY[mode] * np.clip(rough, 0.0, 1.0))

    return np.maximum(kmh, 0.3) / 3.6


def _traffic_row(traffic, traffic_meta, minute):
    """Riga [tratti] di indice di traffico interpolata all'istante `minute`.

    A specchio di `Exposure.row()`, ma con una differenza: il traffico e' un
    pattern che si ripete ogni giorno (l'ora 8:00 e' sempre l'ora 8:00),
    mentre il sole di `Exposure` e' ancorato al giorno preciso del tragitto
    -- quindi qui si riporta prima `minute` dentro un solo giorno (`% 1440`),
    lui no. Fuori dalla finestra rilevata (`traffic_meta`, tipicamente la
    notte) si tiene il valore del bordo piu' vicino, mai un'estrapolazione:
    stesso principio "default prudente, mai favorevole" del vento tipico.
    """
    n_slices, slice_start, slice_step = traffic_meta
    if n_slices <= 1:
        return traffic[0]
    m = minute % 1440.0
    idx = np.clip((m - slice_start) / slice_step, 0.0, n_slices - 1)
    i0 = int(idx)
    i1 = min(i0 + 1, n_slices - 1)
    w = idx - i0
    return traffic[i0] * (1.0 - w) + traffic[i1] * w


def _cost_multipliers(
    exposure_day, departure_minute, alpha, n_bins,
    beta=0.0, traffic=None, traffic_meta=None, wind_factor=1.0,
):
    """Matrice [istante x tratto] del moltiplicatore di costo.

    Precalcolarla evita di interpolare l'esposizione (e ora anche il
    traffico) a ogni estrazione dalla coda di priorita': durante il Dijkstra
    il costo di un tratto diventa una singola lettura in un array.

    Il termine di traffico (`beta * _traffic_row(...) * wind_factor`) segue
    ora lo stesso ciclo sui bin del sole, invece di sommarsi una sola volta a
    tutte le righe: da quando l'indice varia per fascia oraria (Fase 4 della
    variazione oraria) non e' piu' costante durante il tragitto. Se
    `beta <= 0` il blocco resta saltato del tutto, non solo moltiplicato per
    zero: chi non tocca lo slider traffico ottiene lo stesso identico
    output, bit per bit, di prima che questo termine esistesse.
    """
    bins = departure_minute + np.arange(n_bins) * COST_BIN_MINUTES
    n_edges = exposure_day.exposure.shape[1]
    mult = np.ones((n_bins, n_edges), dtype=np.float32)

    if alpha > 0.0:
        for b, minute in enumerate(bins):
            elev, _ = exposure_day.sun_at(minute)
            load = float(solar.solar_load(elev))
            if load <= 0.0:
                continue  # di notte non c'e' sole da evitare
            mult[b] = 1.0 + alpha * exposure_day.row(minute) * load

    if beta > 0.0 and traffic is not None:
        for b, minute in enumerate(bins):
            mult[b] += (beta * wind_factor * _traffic_row(traffic, traffic_meta, minute)).astype(np.float32)

    return mult


# Sotto questa dimensione una componente e' un troncone senza sbocco, non una
# rete su cui abbia senso calcolare un percorso.
MIN_COMPONENT_NODES = 40


def choose_component(graph, allowed, origin_xy, dest_xy) -> np.ndarray:
    """Sceglie su quale porzione connessa di rete calcolare il percorso.

    La rete si frammenta: il ritaglio sul riquadro tronca le vie di bordo, e
    per la carrozzina i gradini isolano interi quartieri. Ad Ascoli il centro
    storico sta su un pianoro e i suoi accessi ripidi lo staccano dalla citta'
    bassa, che essendo piu' estesa "vincerebbe" se ci limitassimo a prendere
    la componente maggiore: un percorso dentro il centro diventerebbe
    impossibile. Si sceglie quindi la componente che avvicina di piu' entrambi
    gli estremi richiesti.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    n = len(graph["node_xy"])
    u, v = graph["edge_u"][allowed], graph["edge_v"][allowed]
    adj = coo_matrix((np.ones(len(u), dtype=np.int8), (u, v)), shape=(n, n))
    _, labels = connected_components(adj, directed=False)

    used = np.unique(np.concatenate([u, v]))
    counts = np.bincount(labels[used], minlength=int(labels.max()) + 1)
    candidate_labels = np.flatnonzero(counts >= MIN_COMPONENT_NODES)
    if candidate_labels.size == 0:
        candidate_labels = np.array([int(np.argmax(counts))])

    best_nodes, best_score = None, np.inf
    for lab in candidate_labels:
        nodes = np.flatnonzero(labels == lab)
        tree = cKDTree(graph["node_xy"][nodes])
        d_origin, _ = tree.query(origin_xy)
        d_dest, _ = tree.query(dest_xy)
        score = float(d_origin) + float(d_dest)
        if score < best_score:
            best_score, best_nodes = score, nodes

    return best_nodes


def snap(graph, lon: float, lat: float, mode: str, utm_epsg: int, candidates=None):
    """Nodo percorribile piu' vicino a un punto.

    `candidates` limita la ricerca a un insieme di nodi, tipicamente la
    componente connessa principale.
    """
    from pyproj import Transformer
    from scipy.spatial import cKDTree

    bit = MODE_BITS[mode]
    allowed = (graph["edge_flags"] & bit) > 0
    if not allowed.any():
        raise RoutingError(f"nessun tratto percorribile in modalita' '{mode}'")

    if candidates is None:
        candidates = np.unique(
            np.concatenate([graph["edge_u"][allowed], graph["edge_v"][allowed]])
        )
    tree = cKDTree(graph["node_xy"][candidates])

    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{utm_epsg}", always_xy=True)
    x, y = tr.transform(lon, lat)
    dist, idx = tree.query([x, y])
    return int(candidates[idx]), float(dist)


def _dijkstra(graph, travel_time, allowed, mult, start, goal, max_speed_ms):
    """Dijkstra dipendente dal tempo con euristica A* sulla distanza residua.

    Ritorna (costo, tempo_minuti, lista_archi) oppure None se irraggiungibile.
    """
    adj_start = graph["adj_start"]
    adj_target = graph["adj_target"]
    adj_edge = graph["adj_edge"]
    node_xy = graph["node_xy"]
    n_nodes = len(node_xy)
    n_bins = mult.shape[0]

    goal_xy = node_xy[goal]
    # Stima ottimistica del tempo residuo: distanza in linea d'aria alla
    # velocita' massima e senza penalita' di sole. Non sovrastima mai il
    # costo reale, quindi A* resta esatto. I costi sono in minuti, quindi
    # anche l'euristica deve esserlo: sovrastimarla renderebbe la ricerca
    # avida verso la destinazione e farebbe perdere i percorsi in ombra.
    inv_speed = 1.0 / (max_speed_ms * 60.0)  # minuti per metro

    best_cost = np.full(n_nodes, np.inf, dtype=np.float64)
    best_time = np.full(n_nodes, np.inf, dtype=np.float64)
    prev_node = np.full(n_nodes, -1, dtype=np.int32)
    prev_edge = np.full(n_nodes, -1, dtype=np.int32)
    settled = np.zeros(n_nodes, dtype=bool)

    best_cost[start] = 0.0
    best_time[start] = 0.0
    heap = [(0.0, 0.0, int(start))]

    while heap:
        _, cost, u = heapq.heappop(heap)
        if settled[u]:
            continue
        settled[u] = True
        if u == goal:
            break

        t_offset = best_time[u]
        if t_offset > MAX_TRIP_MINUTES:
            continue
        bin_idx = min(int(t_offset / COST_BIN_MINUTES), n_bins - 1)
        row = mult[bin_idx]

        for k in range(adj_start[u], adj_start[u + 1]):
            e = adj_edge[k]
            if not allowed[e]:
                continue
            v = adj_target[k]
            if settled[v]:
                continue

            dt = travel_time[e]
            new_cost = cost + dt * row[e]
            if new_cost < best_cost[v]:
                best_cost[v] = new_cost
                best_time[v] = t_offset + dt
                prev_node[v] = u
                prev_edge[v] = e
                dx = node_xy[v, 0] - goal_xy[0]
                dy = node_xy[v, 1] - goal_xy[1]
                h = np.hypot(dx, dy) * inv_speed
                heapq.heappush(heap, (new_cost + h, new_cost, int(v)))

    if not settled[goal] or not np.isfinite(best_cost[goal]):
        return None

    edges, nodes = [], []
    cur = goal
    while cur != start:
        edges.append(int(prev_edge[cur]))
        nodes.append(int(cur))
        cur = int(prev_node[cur])
        if cur < 0:
            return None
    nodes.append(int(start))
    edges.reverse()
    nodes.reverse()
    return float(best_cost[goal]), float(best_time[goal]), edges, nodes


def _describe(graph, exposure_day, edges, nodes, departure_minute, travel_time, traffic=None, traffic_meta=None):
    """Costruisce geometria, statistiche e profilo di esposizione di un percorso."""
    node_lonlat = graph["node_lonlat"]
    edge_len = graph["edge_len"]
    names = graph["names"]
    edge_name = graph["edge_name"]
    # Assente per le citta' mai passate da `traffico.calibra`: zero ovunque,
    # a specchio di come lo esporta gia' `export_graph` per un grafo v3 senza
    # calibrazione (vedi export.py).
    if traffic is None:
        traffic = np.zeros((1, len(edge_len)), dtype=np.float32)
        traffic_meta = (1, 0.0, 15.0)

    coords = [[float(node_lonlat[n, 0]), float(node_lonlat[n, 1])] for n in nodes]

    # Esposizione ed indice di traffico di ogni tratto valutati all'orario in
    # cui lo si percorre davvero -- lo stesso principio per entrambi, ora che
    # anche il traffico varia per fascia oraria (Fase 4).
    t = departure_minute
    segments = []
    exposures = np.zeros(len(edges), dtype=np.float32)
    traffics = np.zeros(len(edges), dtype=np.float32)
    for i, e in enumerate(edges):
        dt = travel_time[e]
        mid = t + dt / 2.0  # valore a meta' del tratto
        exposures[i] = float(exposure_day.row(mid)[e])
        traffics[i] = float(_traffic_row(traffic, traffic_meta, mid)[e])
        segments.append(
            {
                "from": coords[i],
                "to": coords[i + 1],
                "exposure": round(float(exposures[i]), 3),
                "length_m": round(float(edge_len[e]), 1),
                "minute": round(t, 2),
                "name": str(names[edge_name[e]]),
                "traffic_index": round(float(traffics[i]), 3),
            }
        )
        t += dt

    lengths = edge_len[edges].astype(np.float64)
    total_len = float(lengths.sum())
    duration = float(t - departure_minute)
    sun_len = float((lengths * exposures).sum())

    # Quanto sole si prende davvero, pesato per il carico radiativo: e' la
    # grandezza che conta per il disagio percepito, non la sola percentuale.
    dose = 0.0
    tt = departure_minute
    for i, e in enumerate(edges):
        dt = travel_time[e]
        elev, _ = exposure_day.sun_at(tt + dt / 2.0)
        dose += dt * float(exposures[i]) * float(solar.solar_load(elev))
        tt += dt

    # Indice di traffico medio del percorso, pesato per lunghezza -- a
    # specchio esatto di come `shade_pct`/`sun_dose_min` sono rollup per
    # rotta dell'esposizione per segmento. Usa `traffics`, gia' valutato
    # all'orario di transito di ciascun tratto (vedi sopra), non un valore
    # costante.
    traffic_len = float((lengths * traffics).sum())
    avg_traffic_index = traffic_len / max(total_len, 1e-9)

    return {
        "coordinates": coords,
        "segments": segments,
        "distance_m": round(total_len, 1),
        "duration_min": round(duration, 2),
        "shade_pct": round(100.0 * (1.0 - sun_len / max(total_len, 1e-9)), 1),
        "sun_distance_m": round(sun_len, 1),
        "sun_dose_min": round(dose, 2),
        "avg_traffic_index": round(avg_traffic_index, 3),
        "arrival_minute": round(t, 2),
    }


def compute_route(
    aoi,
    graph,
    exposure,
    origin,
    destination,
    mode="foot",
    departure_minute=None,
    alpha=2.0,
    beta=0.0,
    wind_factor=1.0,
):
    """Calcola il percorso di comfort e quello piu' rapido per confronto.

    Args:
        origin, destination: coppie (lon, lat)
        exposure: l'esposizione dei tratti nel tempo, oppure una funzione
            `(corridoio_xy, durata_min) -> Exposure` che la costruisce. La
            seconda forma serve a calcolare le ombre solo dove e quando il
            tragitto passa davvero, cosa che si puo' sapere soltanto dopo
            aver trovato il percorso piu' rapido.
        mode: 'foot', 'bike' o 'wheelchair'
        departure_minute: minuti dalla mezzanotte locale
        alpha: quanto pesa evitare il sole (0 = percorso piu' rapido)
        beta: quanto pesa evitare il traffico (0 = nessun peso, no-op)
        wind_factor: moltiplicatore sul termine di traffico gia' cotto,
            raffinato dal vento live lato client (1.0 = fidati del valore
            tipico dell'export, vedi `web/src/ombra/vento.ts`)

    Returns:
        dict con il percorso di comfort, quello rapido e il confronto.
    """
    if mode not in MODE_BITS:
        raise RoutingError(f"modalita' sconosciuta: {mode}")

    bit = MODE_BITS[mode]
    allowed = (graph["edge_flags"] & bit) > 0
    if not allowed.any():
        raise RoutingError(f"nessun tratto percorribile in modalita' '{mode}'")

    speeds = edge_speeds(mode, graph["edge_slope"], graph.get("edge_rough"))
    travel_time = (graph["edge_len"] / speeds / 60.0).astype(np.float64)  # minuti
    max_speed = float(speeds[allowed].max())

    # Entrambi gli estremi vanno agganciati alla stessa rete connessa,
    # altrimenti si finisce su tronconi isolati e nessun percorso esiste.
    from pyproj import Transformer

    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{aoi.utm_epsg}", always_xy=True)
    origin_xy = to_utm.transform(origin[0], origin[1])
    dest_xy = to_utm.transform(destination[0], destination[1])

    reachable = choose_component(graph, allowed, origin_xy, dest_xy)
    start, d_start = snap(graph, origin[0], origin[1], mode, aoi.utm_epsg, reachable)
    goal, d_goal = snap(graph, destination[0], destination[1], mode, aoi.utm_epsg, reachable)

    if start == goal:
        raise RoutingError("partenza e arrivo coincidono sullo stesso tratto")

    nome_modo = {
        "foot": "a piedi",
        "bike": "in bici",
        "wheelchair": "in carrozzina",
    }[mode]
    for label, dist in (("partenza", d_start), ("arrivo", d_goal)):
        if dist > 400:
            raise RoutingError(
                f"il punto di {label} dista {dist:.0f} m dalla rete percorribile "
                f"{nome_modo}. Puo' essere fuori dall'area preparata, oppure i due "
                "punti stanno su porzioni di rete che questa modalita' non collega."
            )

    n_bins = int(MAX_TRIP_MINUTES / COST_BIN_MINUTES) + 1

    # Assente per le citta' mai passate da `traffico.calibra`: una sola
    # fascia di zeri, cosi' beta>0 su una di queste aree e' innocuo quanto
    # beta=0 (0 * beta = 0), mai un'ipotesi di traffico inventata. Presente,
    # e' sempre una matrice [fasce x tratti] (Fase 4 della variazione
    # oraria): mai piu' un vettore piatto da qui in poi.
    traffic = graph.get("edge_traffic")
    if traffic is None:
        traffic = np.zeros((1, len(travel_time)), dtype=np.float32)
        traffic_meta = (1, 0.0, 15.0)
    else:
        traffic_meta = (
            int(traffic.shape[0]),
            float(graph.get("traffic_slice_start_min", 0.0)),
            float(graph.get("traffic_slice_step_min", 15.0)),
        )

    # Percorso piu' rapido: nessuna penalita' di sole, e' il riferimento.
    # Va calcolato per primo anche perche' dice dove passera' il tragitto e
    # quanto durera', le due cose che servono a sapere quali ombre calcolare.
    flat = np.ones((1, len(travel_time)), dtype=np.float32)
    fastest = _dijkstra(graph, travel_time, allowed, flat, start, goal, max_speed)
    if fastest is None:
        raise RoutingError(
            "nessun percorso trovato fra i due punti in questa modalita'"
        )

    exposure_day = (
        exposure(graph["node_xy"][fastest[3]], fastest[1])
        if callable(exposure)
        else exposure
    )

    if departure_minute is None:
        departure_minute = exposure_day.start_minute
    departure_minute = float(
        np.clip(departure_minute, exposure_day.start_minute, exposure_day.end_minute)
    )

    # Percorso di comfort (sole, traffico, o entrambi). Un utente con
    # alpha=0 e beta>0 vuole solo evitare il traffico: deve ottenere un
    # percorso ricalcolato, non quello piatto, da cui il gate su entrambi.
    if alpha > 0 or beta > 0:
        mult = _cost_multipliers(
            exposure_day, departure_minute, alpha, n_bins,
            beta=beta, traffic=traffic, traffic_meta=traffic_meta, wind_factor=wind_factor,
        )
        shaded = _dijkstra(graph, travel_time, allowed, mult, start, goal, max_speed)
    else:
        shaded = fastest
    if shaded is None:
        shaded = fastest

    shaded_desc = _describe(
        graph, exposure_day, shaded[2], shaded[3], departure_minute, travel_time,
        traffic=traffic, traffic_meta=traffic_meta,
    )
    fastest_desc = _describe(
        graph, exposure_day, fastest[2], fastest[3], departure_minute, travel_time,
        traffic=traffic, traffic_meta=traffic_meta,
    )

    same = shaded[2] == fastest[2]
    extra_min = shaded_desc["duration_min"] - fastest_desc["duration_min"]
    extra_m = shaded_desc["distance_m"] - fastest_desc["distance_m"]

    return {
        "mode": mode,
        "alpha": alpha,
        "beta": beta,
        "departure_minute": round(departure_minute, 2),
        "snap_distance_m": {"origin": round(d_start, 1), "destination": round(d_goal, 1)},
        "shaded": shaded_desc,
        "fastest": fastest_desc,
        "comparison": {
            "identical": bool(same),
            "extra_minutes": round(extra_min, 2),
            "extra_meters": round(extra_m, 1),
            "shade_gain_pct": round(
                shaded_desc["shade_pct"] - fastest_desc["shade_pct"], 1
            ),
            "sun_dose_saved_pct": round(
                100.0
                * (1.0 - shaded_desc["sun_dose_min"] / max(fastest_desc["sun_dose_min"], 1e-9)),
                1,
            ),
            "traffic_index_saved_pct": round(
                100.0
                * (1.0 - shaded_desc["avg_traffic_index"] / max(fastest_desc["avg_traffic_index"], 1e-9)),
                1,
            ),
        },
    }
