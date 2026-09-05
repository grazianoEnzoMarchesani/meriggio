"""Calibrazione dell'indice statico di esposizione a traffico/inquinamento.

Secondo asse di comfort accanto al sole (vedi `router.py`): non solo "il
percorso piu' ombreggiato" ma anche "il percorso meno esposto al traffico".
A differenza del sole, che si calcola ovunque dalla sola geometria, qui
serve un dato reale di conteggio veicolare — oggi disponibile solo per
Ascoli Piceno (PUMS, TPS Pro srl, maggio 2025, vedi
`data/ascoli-piceno/README.md`). Questo modulo gira **solo offline**, dentro
`cli.py prepara()`, mai nel browser: scrive un array statico `edge_traffic`
dentro lo stesso `graph.npz` che `graph.build_graph` produce, senza toccare
`build_graph` ne' `export.py` ne' `router.py` (li estende la Fase 3/4 del
piano, non questo modulo).

La spazializzazione ha due livelli:

1. **Dove un conteggio PUMS esiste** (le sezioni del gruppo `cordone`/
   `pedonale`): l'indice e' il conteggio in veicoli-equivalenti disperso con
   un modello a scatola (box model) ispirato a OSPM (Hertel & Berkowicz,
   1989; Berkowicz, "OSPM -- A Parameterised Street Pollution Model",
   Environmental Monitoring and Assessment 65, 2000), calibrato sulla
   geometria locale del canyon stradale (altezza/larghezza dagli edifici) e
   sul vento tipico dell'area.
2. **Altrove** (`_stima_da_centralita`): una regressione fra la centralita'
   topologica del tratto nella rete veicolare (betweenness centrality, vedi
   `_centralita_stradale`) e il traffico osservato sui tratti misurati --
   mai sul gruppo `periferica`, che il README dichiara troppo rumoroso per
   calibrare, solo utile come controllo a parte. Prima di questo (v3) qui
   c'era una semplice media per tipo OSM (`_typology_fallback`, tenuta come
   ripiego se la regressione non e' calibrabile): un limite reale di quella
   versione era che ogni strada dello stesso tipo (`highway=residential`,
   `tertiary`, ...) otteneva lo stesso identico numero, e i tipi mai
   osservati fra le sezioni PUMS (ad Ascoli: `secondary`, come Via Napoli)
   restavano a zero su tutta la rete invece che stimati.

v2 variava nel tempo quanto una fotografia: solo le colonne `_14h` del CSV,
un indice costante per tutta la giornata. Da quando `pums_traffico_15min.csv`
esiste (lettura diretta della terza pagina di ogni sezione del PDF originale,
non piu' solo la sintesi) il conteggio vero e' disponibile ogni 15 minuti,
gia' scomposto per classe veicolare -- quindi l'indice puo' seguire il
traffico reale della giornata invece di restare piatto. Questo modulo scrive
ora `edge_traffic` come matrice `[fasce x tratti]` (56 fasce, una ogni 15'
dalle 06:00 alle 19:45, la finestra del rilievo), non piu' un vettore: la
pesatura PCE e il modello di dispersione si ripetono per ciascuna fascia
invece che una volta sola sul totale 14h. Fuori dalla finestra rilevata (di
notte) il router (Fase 4) tiene il valore del bordo piu' vicino invece di
estrapolare -- stesso principio "default prudente, mai favorevole" gia'
usato per il vento, mai un'invenzione di un calo notturno che i dati non
dicono.
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import numpy as np

# Il CSV PUMS e' dato curato a mano, committato accanto al codice -- non un
# artefatto generato sotto `aoi.dir` (vedi aoi.AOI_DIR). Vive in una terza
# cartella sorella di `aoi.DATA_ROOT` (`backend/data/`), dentro il pacchetto
# stesso: `backend/ombra/data/<slug>/`.
PUMS_DIR = Path(__file__).resolve().parent / "data"

# ---------------------------------------------------------------------------
# Pesi in veicoli-equivalenti (PCE, passenger-car-equivalent)
# ---------------------------------------------------------------------------
# Da Transport for London, valori PCU in contesto urbano: pedal cycle 0.2,
# motorcycle 0.4, car/light goods vehicle 1.0, medium goods vehicle 1.5,
# bus/coach 2.0, heavy goods vehicle 2.3. Le colonne del CSV PUMS non
# distinguono "medium" da "heavy": `pesanti_isolati_14h` (autocarri) prende
# il valore HGV; `pesanti_combinati_14h` (autoarticolati, piu' ingombranti di
# un HGV isolato) estende la tabella oltre l'ultimo valore citato, a 2.9 --
# un'estrapolazione dichiarata, non un altro dato di letteratura.
# `bici_14h` e' esclusa: non e' fonte di emissione (vedi README del CSV).
_PCE = {
    "autovetture_14h": 1.0,
    "comm_leggeri_14h": 1.0,
    "moto_14h": 0.4,
    "pesanti_isolati_14h": 2.3,
    "autobus_14h": 2.0,
    "pesanti_combinati_14h": 2.9,
}

# Stessi pesi, ma sui nomi di colonna di `pums_traffico_15min.csv`
# (`autovetture_14h` -> `auto`, e cosi' per le altre): il CSV a 15' usa i nomi
# brevi della terza pagina del PDF, non quelli della sintesi. `bici` esclusa
# per lo stesso motivo di `_PCE`.
_PCE_15MIN = {
    "auto": 1.0,
    "comm_leggeri": 1.0,
    "moto": 0.4,
    "pesanti_isolati": 2.3,
    "autobus": 2.0,
    "pesanti_combinati": 2.9,
}

# ---------------------------------------------------------------------------
# Geometria del canyon stradale
# ---------------------------------------------------------------------------
# Raggio massimo di ricerca degli edifici per lato, in metri. I vicoli del
# centro storico di Ascoli sono larghi pochi metri (i tratti piu' stretti
# sotto i 4 m), le vie principali del cordone (Viale Treviri, Corso Mazzini)
# arrivano a 15-20 m con marciapiedi; 30 m per lato (60 m di canyon) copre
# comodamente entrambi i casi e degrada dolcemente a "canyon aperto" (nessun
# edificio trovato) sui viali piu' larghi e sulle sezioni periferiche, dove
# un muro a 30 m sarebbe comunque poco significativo per la dispersione.
# Scelta e motivata qui (Fase 9 del piano lasciava il valore aperto), non
# una misura.
CANYON_SEARCH_M = 30.0

# ---------------------------------------------------------------------------
# Dispersione: box model semplificato ispirato a OSPM
# ---------------------------------------------------------------------------
# La forma completa di OSPM somma un contributo diretto (plume) e uno di
# ricircolo, con la geometria del vortice che dipende dalla direzione del
# vento rispetto all'asse strada. Qui il vento e' un solo scalare per area
# (Fase 1.3 del piano) e non porta una direzione utile per-tratto -- quindi
# si usa la riduzione "a scatola" del modello: la concentrazione scala come
# emissione / (larghezza del canyon x (vento + una velocita' minima che
# evita la singolarita' a vento calmo)). u0 = 0.5 m/s e' l'ordine di
# grandezza usato in letteratura per questa costante di ricircolo a bassa
# velocita' (Hertel & Berkowicz 1989; Berkowicz 2000).
_WIND_MIN_MS = 0.5
# Larghezza minima del canyon per evitare un fattore di dispersione
# spropositato su tratti dove il raycast non trova nulla vicino.
_CANYON_W_MIN_M = 3.0

# Regime del canyon per rapporto altezza/larghezza (Oke, "Street design and
# urban canopy layer climate", Energy and Buildings 11, 1988): sopra 0.65 il
# flusso e' "skimming" e il vortice intrappola l'inquinante contro la parete
# sottovento; sotto 0.3 gli edifici sono troppo radi per formare un vero
# canyon e la dispersione e' quella di un ostacolo isolato; in mezzo c'e' un
# regime di interferenza delle scie. I moltiplicatori (1.5 / 1.0 / 0.6) sono
# una traduzione qualitativa di queste tre fasce, non valori di letteratura:
# pesano la stessa dispersione di base in piu' o in meno a seconda di quanto
# il canyon intrappola l'aria, restando ancorati alla classificazione citata.
_CANYON_REGIME_DEEP = 0.65
_CANYON_REGIME_OPEN = 0.30
_REGIME_MULT_DEEP = 1.5
_REGIME_MULT_MID = 1.0
_REGIME_MULT_OPEN = 0.6

# Gruppi PUMS ammessi a calibrare (mai "periferica": il README lo dichiara
# esplicitamente troppo rumoroso e a bassa numerosita' per il canyon urbano,
# utile solo come controllo a parte).
_GRUPPI_CALIBRAZIONE = {"cordone", "pedonale"}

# ---------------------------------------------------------------------------
# Stima per centralita' di rete (sostituisce la media per tipologia OSM sui
# tratti mai misurati direttamente, vedi `_stima_da_centralita`)
# ---------------------------------------------------------------------------
# Tipi non percorribili da veicoli a motore: fuori dal grafo usato per la
# centralita' veicolare, e sempre a zero nell'indice finale qualunque sia la
# loro posizione nella rete -- un marciapiede puo' essere una scorciatoia
# molto centrale per chi cammina o pedala senza portare una sola auto.
_TIPI_NON_VEICOLARI = {
    "footway", "path", "steps", "cycleway", "pedestrian", "track", "bridleway", "corridor",
}

# Velocita' tipica per tipo di strada (km/h), usata solo per pesare il grafo
# della centralita': un tipo piu' veloce "accorcia" topologicamente il
# tragitto rispetto a uno lento della stessa lunghezza, cosi' il cammino piu'
# breve pesato assomiglia a quello che sceglierebbe chi guida, non solo al
# piu' corto in metri. Scala diversa (e diverso scopo) dalle velocita'
# pedonali/bici di `router.ts`: qui serve solo a ordinare le strade fra loro,
# non a stimare un tempo di percorrenza vero.
_VELOCITA_TIPICA_KMH = {
    "trunk": 70.0, "trunk_link": 50.0,
    "primary": 50.0, "primary_link": 40.0,
    "secondary": 50.0, "secondary_link": 40.0,
    "tertiary": 40.0, "tertiary_link": 35.0,
    "unclassified": 30.0,
    "residential": 30.0,
    "living_street": 15.0,
    "service": 15.0,
}
_VELOCITA_DEFAULT_KMH = 30.0

# Nodi sorgente campionati per la betweenness centrality approssimata
# (Brandes & Pich, "Centrality Estimation in Large Networks", 2007): sui
# ~15.000 nodi di Ascoli Piceno il calcolo esatto supera abbondantemente i
# due minuti (verificato), un campione da poche centinaia lo riporta a
# pochi secondi con la stessa stima attesa. Valore tarato empiricamente su
# quest'area, non un default di libreria.
_CAMPIONI_CENTRALITA = 300

# Sotto questa soglia di tratti calibrabili -- o se la loro centralita' non
# varia affatto, regressione non identificabile -- si ricade sulla media per
# tipologia (`_typology_fallback`).
_MIN_PUNTI_REGRESSIONE = 15

# Evita log(0) per un tratto isolato con betweenness esattamente nulla
# (es. un vicolo cieco mai attraversato da nessun cammino piu' breve).
_EPS_CENTRALITA = 1e-6


def disponibile(aoi) -> bool:
    """Vero se esiste un CSV PUMS per quest'area.

    Unico cancello usato ovunque per decidere se un'area ha l'asse traffico:
    nessun controllo su `aoi.slug` da nessuna parte, cosi' l'estensione a
    un'altra citta' in futuro e' solo questione di aggiungere il suo CSV.
    """
    return (PUMS_DIR / aoi.slug / "pums_traffico.csv").exists()


def _csv_path(aoi, nome: str) -> Path:
    return PUMS_DIR / aoi.slug / nome


def _leggi_pums(aoi) -> list[dict]:
    with open(_csv_path(aoi, "pums_traffico.csv"), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _leggi_vie(aoi) -> dict[str, dict]:
    """Coordinate approssimate dei due estremi di ogni sezione, indicizzate per id.

    Le righe con coordinate assenti (sezioni `periferica` fuori dall'area
    preparata, vedi README) sono escluse: non sono un errore, sono sezioni
    che questo CSV non puo' agganciare al grafo.
    """
    out = {}
    with open(_csv_path(aoi, "pums_traffico_vie.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if not row["lon_da"] or not row["lon_a"]:
                continue
            out[row["id"]] = {
                "da": (float(row["lon_da"]), float(row["lat_da"])),
                "a": (float(row["lon_a"]), float(row["lat_a"])),
            }
    return out


def _vehicle_equivalents(row: dict) -> float:
    """Indice medio in veicoli-equivalenti/h sulle 14 ore del rilievo.

    Solo le colonne `_14h` (le piu' affidabili, vedi README) -- mai i picchi.
    Non piu' usata per calibrare (vedi `_vehicle_equivalents_slice`), resta
    solo perche' util in futuro per un controllo di coerenza a campione.
    """
    totale = sum(_PCE[col] * float(row[col]) for col in _PCE)
    return totale / 14.0


def _minuti_da_ora(hhmm: str) -> float:
    ore, minuti = hhmm.split(":")
    return float(int(ore) * 60 + int(minuti))


def _leggi_15min(aoi) -> tuple[dict[str, list[dict]], list[str]]:
    """Conteggio a 15' per classe veicolare, raggruppato per sezione.

    Ogni sezione deve avere esattamente la stessa sequenza di orari delle
    altre: e' quello che rende sensato un unico "griglia di fasce" condivisa
    per tutto il grafo invece di una per sezione. Un disallineamento e' un
    errore di trascrizione, non un caso da gestire in silenzio.
    """
    per_sezione: dict[str, list[dict]] = {}
    with open(_csv_path(aoi, "pums_traffico_15min.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            per_sezione.setdefault(row["id"], []).append(row)

    orari_riferimento: list[str] | None = None
    for id_, righe in per_sezione.items():
        righe.sort(key=lambda r: _minuti_da_ora(r["ora"]))
        orari = [r["ora"] for r in righe]
        if orari_riferimento is None:
            orari_riferimento = orari
        elif orari != orari_riferimento:
            raise ValueError(
                f"pums_traffico_15min.csv: la sezione {id_} ha una griglia oraria "
                "diversa dalle altre sezioni"
            )

    return per_sezione, orari_riferimento or []


def _vehicle_equivalents_slice(row: dict) -> float:
    """Veicoli-equivalenti/h nel quarto d'ora, dalla tabella a 15'.

    Il conteggio e' su 15 minuti, non su un'ora: si moltiplica per 4 per
    restare nella stessa unita' (veicoli-equivalenti/h) di
    `_vehicle_equivalents`, cosi' la dispersione (Fase 2) non deve sapere se
    il numero che riceve viene da una media 14h o da un singolo quarto d'ora.
    """
    totale = sum(_PCE_15MIN[col] * float(row[col]) for col in _PCE_15MIN)
    return totale * 4.0


def _shortest_path_edges(graph, start: int, goal: int) -> list[int] | None:
    """Cammino piu' breve per lunghezza fra due nodi, come lista di indici di tratto.

    A differenza di `router._dijkstra` non dipende dal tempo (l'asse
    traffico non varia nel tempo in questa fase, vedi il modulo) e non e'
    limitato per modalita': il canyon stradale esiste indipendentemente da
    chi puo' percorrerlo a piedi o in bici.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra

    n = len(graph["node_xy"])
    u, v, length = graph["edge_u"], graph["edge_v"], graph["edge_len"]
    rows = np.concatenate([u, v])
    cols = np.concatenate([v, u])
    data = np.concatenate([length, length]).astype(np.float64)
    mat = coo_matrix((data, (rows, cols)), shape=(n, n)).tocsr()

    dist, pred = dijkstra(mat, directed=False, indices=start, return_predecessors=True)
    if not np.isfinite(dist[goal]):
        return None

    adj_start, adj_target, adj_edge = graph["adj_start"], graph["adj_target"], graph["adj_edge"]
    edges = []
    cur = goal
    while cur != start:
        prev = int(pred[cur])
        if prev < 0:
            return None
        # Fra `prev` e `cur` puo' esserci piu' di un tratto (rara ma
        # possibile su isole/rotonde brevi): si prende il piu' corto, come
        # farebbe comunque Dijkstra.
        candidati = [
            (int(adj_edge[k]), float(length[adj_edge[k]]))
            for k in range(adj_start[prev], adj_start[prev + 1])
            if adj_target[k] == cur
        ]
        if not candidati:
            return None
        edges.append(min(candidati, key=lambda c: c[1])[0])
        cur = prev
    edges.reverse()
    return edges


def _match_sections_to_edges(aoi, graph, log=print) -> dict[str, list[int]]:
    """Aggancia ogni sezione PUMS ai tratti del grafo che percorre.

    Aggancia i due estremi approssimati (Fase 0, `pums_traffico_vie.csv`) ai
    nodi del grafo piu' vicini, poi prende il cammino piu' breve per
    lunghezza fra loro -- stesso principio del "nearest node" gia' usato in
    `router.snap`. Le coordinate non devono essere esatte: bastano abbastanza
    vicine da agganciarsi al tratto giusto, ed e' per questo che si confronta
    poi il nome via dominante del cammino trovato con la colonna `strada`,
    solo come controllo -- un mismatch produce un warning, mai un fallimento
    silenzioso.
    """
    from pyproj import Transformer
    from scipy.spatial import cKDTree

    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{aoi.utm_epsg}", always_xy=True)
    node_xy = graph["node_xy"]
    tree = cKDTree(node_xy)

    strade_csv = {row["id"]: row["strada"] for row in _leggi_pums(aoi)}
    names = graph["names"]
    edge_name = graph["edge_name"]
    edge_len = graph["edge_len"]

    matched: dict[str, list[int]] = {}
    for id_, coppia in _leggi_vie(aoi).items():
        (lon_da, lat_da), (lon_a, lat_a) = coppia["da"], coppia["a"]
        xd, yd = to_utm.transform(lon_da, lat_da)
        xa, ya = to_utm.transform(lon_a, lat_a)
        _, i_da = tree.query([xd, yd])
        _, i_a = tree.query([xa, ya])
        i_da, i_a = int(i_da), int(i_a)
        if i_da == i_a:
            log(f"    {id_}: i due estremi si agganciano allo stesso nodo, sezione saltata")
            continue

        edges = _shortest_path_edges(graph, i_da, i_a)
        if not edges:
            log(f"    {id_}: nessun cammino trovato fra i due estremi, sezione saltata")
            continue

        # Nome dominante: quello che copre piu' lunghezza lungo il cammino.
        peso_nome: dict[int, float] = {}
        for e in edges:
            peso_nome[int(edge_name[e])] = peso_nome.get(int(edge_name[e]), 0.0) + float(edge_len[e])
        dominante = str(names[max(peso_nome, key=peso_nome.get)])
        atteso = strade_csv.get(id_, "")
        if atteso and atteso.lower() not in dominante.lower() and dominante.lower() not in atteso.lower():
            log(
                f"    ATTENZIONE {id_}: nome dominante del cammino trovato "
                f"'{dominante}' non corrisponde a 'strada'='{atteso}' nel CSV"
            )

        matched[id_] = edges
    return matched


def _osm_highway(graph, osm_json: dict) -> np.ndarray:
    """Tag `highway=` per tratto, da `edge_way` rimappato contro l'OSM gia' scaricato."""
    tag_per_via = {
        el["id"]: el.get("tags", {}).get("highway", "")
        for el in osm_json["elements"]
        if el["type"] == "way"
    }
    edge_way = graph["edge_way"]
    return np.array([tag_per_via.get(int(w), "") for w in edge_way], dtype=object)


def _canyon_hw(aoi, graph, buildings, log=print) -> tuple[np.ndarray, np.ndarray]:
    """Altezza e larghezza del canyon stradale per ogni tratto.

    Raycasting perpendicolare al tratto contro i volumi degli edifici, fino
    a `CANYON_SEARCH_M` per lato: il primo edificio incontrato su ciascun
    lato da' la sua altezza e la sua distanza. Un lato senza edifici entro il
    raggio e' trattato come aperto (parete assente, non un muro lontano):
    contribuisce alla larghezza per l'intero raggio di ricerca e con
    altezza zero, cosi' un canyon senza edifici su nessuno dei due lati
    risulta H/W ~ 0, il regime piu' ventilato -- mai il piu' intrappolato.
    """
    from shapely.geometry import LineString

    n = len(graph["edge_u"])
    H = np.zeros(n, dtype=np.float32)
    W = np.full(n, 2.0 * CANYON_SEARCH_M, dtype=np.float32)

    if buildings is None or len(buildings) == 0:
        log("    canyon: nessun edificio disponibile, tutti i tratti trattati come aperti")
        return H, W

    b = buildings.to_crs(aoi.utm_epsg)
    b = b[b.geometry.notna() & b.geometry.is_valid]
    sindex = b.sindex
    heights = b["height"].to_numpy(dtype=np.float64)
    geoms = b.geometry.to_numpy()

    node_xy = graph["node_xy"]
    edge_u, edge_v = graph["edge_u"], graph["edge_v"]
    ax, ay = node_xy[edge_u, 0], node_xy[edge_u, 1]
    bx, by = node_xy[edge_v, 0], node_xy[edge_v, 1]
    dx, dy = bx - ax, by - ay
    length = np.hypot(dx, dy)
    length_safe = np.maximum(length, 1e-6)
    # Perpendicolare unitaria al tratto
    px, py = -dy / length_safe, dx / length_safe
    mx, my = (ax + bx) / 2.0, (ay + by) / 2.0

    from shapely.geometry import Point

    for i in range(n):
        if length[i] < 1e-6:
            continue
        origine = Point(float(mx[i]), float(my[i]))
        # Distanza e altezza della parete su ciascun lato: default "aperto"
        # (nessuna parete entro il raggio di ricerca).
        dist_lato = [CANYON_SEARCH_M, CANYON_SEARCH_M]
        h_lato = [0.0, 0.0]
        for lato, segno in enumerate((1.0, -1.0)):
            estremo = (origine.x + segno * px[i] * CANYON_SEARCH_M,
                       origine.y + segno * py[i] * CANYON_SEARCH_M)
            raggio = LineString([(origine.x, origine.y), estremo])
            candidati = list(sindex.intersection(raggio.bounds))
            for c in candidati:
                geom = geoms[c]
                if geom is None or not raggio.intersects(geom):
                    continue
                d = raggio.intersection(geom).distance(origine)
                if d < dist_lato[lato]:
                    dist_lato[lato], h_lato[lato] = d, heights[c]

        W[i] = dist_lato[0] + dist_lato[1]
        pareti_trovate = [h for h, d in zip(h_lato, dist_lato) if d < CANYON_SEARCH_M]
        H[i] = float(np.mean(pareti_trovate)) if pareti_trovate else 0.0

    return H, W


def _dispersion_ospm_lite(source_strength: np.ndarray, h: np.ndarray, w: np.ndarray, wind_speed_ms: float) -> np.ndarray:
    """Fattore di dispersione per tratto: box model semplificato (vedi modulo)."""
    w_eff = np.maximum(w, _CANYON_W_MIN_M)
    base = source_strength / (w_eff * (wind_speed_ms + _WIND_MIN_MS))

    hw = np.divide(h, w_eff, out=np.zeros_like(h), where=w_eff > 0)
    regime = np.full_like(base, _REGIME_MULT_MID)
    regime = np.where(hw >= _CANYON_REGIME_DEEP, _REGIME_MULT_DEEP, regime)
    regime = np.where(hw < _CANYON_REGIME_OPEN, _REGIME_MULT_OPEN, regime)
    return base * regime


def _typology_fallback(highway: np.ndarray, edge_traffic: np.ndarray, matched_mask: np.ndarray, gruppo_per_edge: np.ndarray) -> np.ndarray:
    """Indice per i tratti non coperti da una sezione PUMS diretta.

    Media di quanto osservato, dopo dispersione, sui tratti misurati dello
    stesso tipo OSM -- solo `cordone`/`pedonale` (mai `periferica`, vedi
    modulo). Un tipo mai osservato nel calibrato resta a zero: e' lo stesso
    default "nessun dato" gia' usato per le citta' senza CSV PUMS, non
    un'ipotesi ottimistica.
    """
    calibrabile = matched_mask & np.isin(gruppo_per_edge, list(_GRUPPI_CALIBRAZIONE))
    medie: dict[str, float] = {}
    for tipo in np.unique(highway[calibrabile]):
        valori = edge_traffic[calibrabile & (highway == tipo)]
        if len(valori):
            medie[tipo] = float(valori.mean())

    out = np.zeros(len(highway), dtype=np.float32)
    for tipo, media in medie.items():
        out[(~matched_mask) & (highway == tipo)] = media
    return out


def _centralita_stradale(graph, highway: np.ndarray, veicolare: np.ndarray) -> np.ndarray:
    """Quanto ogni tratto e' una scorciatoia obbligata nella rete veicolare.

    Betweenness centrality approssimata per campionamento (vedi
    `_CAMPIONI_CENTRALITA`) su un grafo pesato per tempo di percorrenza
    tipico (lunghezza / velocita' del tipo di strada, non la lunghezza
    nuda): e' il pezzo che sostituisce, per i tratti mai misurati, il
    vecchio fallback per tipologia con una stima specifica per tratto (vedi
    `_stima_da_centralita`).

    Metodo dalla letteratura sui trasporti per citta' povere di dati
    (Alahakoon, Rathnayake, Kumarage, "A novel approach to model traffic on
    road segments of large-scale urban road networks", MethodsX 6, 2019,
    validato su Colombo/Phnom Penh/Hanoi/Karachi/Dar es Salaam con appena
    circa 40 conteggi reali di calibrazione -- lo stesso ordine di
    grandezza delle 21 sezioni PUMS qui disponibili). Il paper combina
    betweenness e closeness centrality; qui resta solo la betweenness: la
    closeness esatta su ~15.000 nodi supera i due minuti di calcolo anche
    solo per calibrare un'area (verificato), un costo che non si giustifica
    per un secondo termine che la letteratura tratta come complementare,
    non necessario, al primo.
    """
    import networkx as nx

    edge_u, edge_v, edge_len = graph["edge_u"], graph["edge_v"], graph["edge_len"]
    n = len(edge_u)

    G = nx.Graph()
    for e in range(n):
        if not veicolare[e] or edge_len[e] <= 0:
            continue
        velocita = _VELOCITA_TIPICA_KMH.get(highway[e], _VELOCITA_DEFAULT_KMH)
        peso = (edge_len[e] / 1000.0) / velocita
        u, v = int(edge_u[e]), int(edge_v[e])
        # Piu' di un tratto puo' collegare la stessa coppia di nodi (vedi
        # `_shortest_path_edges`): un grafo semplice non regge archi
        # paralleli, si tiene il piu' veloce dei due.
        if G.has_edge(u, v) and G[u][v]["weight"] <= peso:
            continue
        G.add_edge(u, v, weight=peso, indice=e)

    betweenness = np.zeros(n, dtype=np.float64)
    if G.number_of_edges() == 0:
        return betweenness

    bc = nx.edge_betweenness_centrality(
        G, k=min(_CAMPIONI_CENTRALITA, G.number_of_nodes()), weight="weight", seed=0,
    )
    for u, v, dati in G.edges(data=True):
        betweenness[dati["indice"]] = bc.get((u, v), bc.get((v, u), 0.0))
    return betweenness


def _stima_da_centralita(
    betweenness: np.ndarray,
    veicolare: np.ndarray,
    highway: np.ndarray,
    edge_traffic: np.ndarray,
    matched_mask: np.ndarray,
    gruppo_per_edge: np.ndarray,
) -> np.ndarray:
    """Indice per i tratti non coperti da una sezione PUMS diretta.

    Sostituisce la media per tipologia (`_typology_fallback`, tenuta come
    ripiego piu' sotto) con una stima specifica per tratto: una regressione
    lineare fra `log(betweenness)` e il traffico misurato (gia' disperso),
    tarata sui soli tratti calibrabili (`cordone`/`pedonale`, mai
    `periferica`, vedi modulo) e applicata a tutta la rete veicolare. Due
    vie dello stesso tipo OSM non condividono piu' automaticamente lo
    stesso numero: lo condividono solo se occupano davvero un ruolo simile
    nella rete. Copre anche i tipi mai osservati nel campione misurato --
    ad Ascoli nessuna sezione PUMS e' taggata `highway=secondary` (es. Via
    Napoli): prima quel tipo restava a zero su tutta la rete, ora prende un
    valore dalla sua posizione topologica.

    Il logaritmo, non la betweenness grezza, perche' la sua distribuzione e'
    fortemente asimmetrica su una rete stradale (su Ascoli il 99-esimo
    percentile e' circa 300 volte la mediana): una regressione lineare sul
    valore grezzo sarebbe dominata dalle poche strade con centralita'
    altissima e non discriminerebbe affatto la maggioranza delle vie.

    Se i tratti calibrabili sono troppo pochi o la loro centralita' non
    varia (regressione non identificabile), si ricade sulla vecchia media
    per tipologia: un modello che non si puo' stimare in modo affidabile
    non deve prendere il posto di uno piu' semplice solo perche' e' piu'
    sofisticato.
    """
    calibrabile = matched_mask & np.isin(gruppo_per_edge, list(_GRUPPI_CALIBRAZIONE))
    n_calibrabile = int(calibrabile.sum())

    x = np.log(betweenness[calibrabile] + _EPS_CENTRALITA)
    y = edge_traffic[calibrabile]

    if n_calibrabile < _MIN_PUNTI_REGRESSIONE or np.std(x) < 1e-9:
        return _typology_fallback(highway, edge_traffic, matched_mask, gruppo_per_edge)

    design = np.column_stack([np.ones(n_calibrabile), x])
    coef, *_ = np.linalg.lstsq(design, y, rcond=None)

    x_tutti = np.log(betweenness + _EPS_CENTRALITA)
    stima = coef[0] + coef[1] * x_tutti

    out = np.zeros(len(betweenness), dtype=np.float32)
    bersaglio = (~matched_mask) & veicolare
    out[bersaglio] = np.maximum(0.0, stima[bersaglio]).astype(np.float32)
    return out


def _vento_tipico(aoi, log=print) -> dict:
    """Vento tipico dell'area: media su un anno di dati storici Open-Meteo.

    Un solo scalare per area (velocita' e direzione), cotto una volta qui.
    Se il fetch storico fallisce (rete assente durante `prepara`), si ricade
    sulla sola velocita' minima di ricircolo del box model (`_WIND_MIN_MS`):
    e' il vento piu' calmo plausibile, quindi la dispersione minima e
    l'esposizione stimata massima -- il principio "default prudente, mai
    favorevole" gia' seguito da `live.ts` per il sole, qui applicato al
    fallback di calibrazione.
    """
    import datetime as _dt

    import requests

    lon, lat = aoi.center
    fine = _dt.date.today() - _dt.timedelta(days=7)
    inizio = fine - _dt.timedelta(days=365)
    try:
        resp = requests.get(
            "https://archive-api.open-meteo.com/v1/archive",
            params={
                "latitude": lat,
                "longitude": lon,
                "start_date": inizio.isoformat(),
                "end_date": fine.isoformat(),
                "hourly": "wind_speed_10m,wind_direction_10m",
                "wind_speed_unit": "ms",
                "timezone": "Europe/Rome",
            },
            timeout=30,
        )
        resp.raise_for_status()
        h = resp.json()["hourly"]
        speeds = np.array([v for v in h["wind_speed_10m"] if v is not None], dtype=np.float64)
        dirs = np.array(
            [d for d, v in zip(h["wind_direction_10m"], h["wind_speed_10m"]) if v is not None],
            dtype=np.float64,
        )
        if len(speeds) < 24 * 30:  # meno di un mese di dati: non ci si fida
            raise ValueError(f"solo {len(speeds)} ore di dati storici")
        velocita = float(speeds.mean())
        sx = float((speeds * np.sin(np.radians(dirs))).sum())
        sy = float((speeds * np.cos(np.radians(dirs))).sum())
        direzione = float(math.degrees(math.atan2(sx, sy)) % 360)
        log(f"    vento tipico: {velocita:.2f} m/s da {direzione:.0f}° (media {inizio}..{fine}, Open-Meteo)")
        return {"speed_ms": round(velocita, 2), "direction_deg": round(direzione, 1), "source": "open-meteo archive, media 1 anno"}
    except Exception as exc:
        log(f"    vento tipico: fetch storico fallito ({exc}), uso il minimo di ricircolo (default prudente)")
        return {"speed_ms": _WIND_MIN_MS, "direction_deg": None, "source": "fallback: velocita' minima di ricircolo, nessun dato storico"}


def calibra(aoi, osm_json: dict, buildings, log=print) -> dict:
    """Calibra l'indice di traffico per fascia oraria e lo scrive dentro `graph.npz`.

    Punto di ingresso della fase: non tocca `build_graph`, `export.py` ne'
    `router.py`. Se qualcosa qui dentro ha un bug, il routing solare non ne
    risente perche' nessuno di questi tre legge `edge_traffic` prima che la
    Fase 3/4 del piano li colleghi esplicitamente.

    La geometria del canyon (`_canyon_hw`, costosa: raycasting contro gli
    edifici) e l'aggancio delle sezioni ai tratti si calcolano una volta
    sola; solo la pesatura PCE e la dispersione (economiche, vettoriali) si
    ripetono per ciascuna delle fasce da 15'.
    """
    from .graph import load_graph

    g = load_graph(aoi)
    n = len(g["edge_u"])

    log("    aggancio delle sezioni PUMS ai tratti del grafo")
    matched = _match_sections_to_edges(aoi, g, log=log)

    righe = {row["id"]: row for row in _leggi_pums(aoi)}
    gruppo_di: dict[str, str] = {id_: righe[id_]["gruppo"] for id_ in righe}

    log("    geometria del canyon stradale (altezza/larghezza dagli edifici)")
    H, W = _canyon_hw(aoi, g, buildings, log=log)

    vento = _vento_tipico(aoi, log=log)

    highway = _osm_highway(g, osm_json)
    veicolare = np.array([h not in _TIPI_NON_VEICOLARI for h in highway])

    matched_mask = np.zeros(n, dtype=bool)
    gruppo_per_edge = np.full(n, "", dtype=object)
    for id_, edges in matched.items():
        idx = np.array(edges, dtype=np.int64)
        matched_mask[idx] = True
        gruppo_per_edge[idx] = gruppo_di[id_]
    n_tratti_matched = int(matched_mask.sum())
    log(f"    {len(matched)} sezioni agganciate, {n_tratti_matched} tratti calibrati direttamente")

    log("    centralita' della rete veicolare (betweenness, campionata)")
    betweenness = _centralita_stradale(g, highway, veicolare)

    profili, orari = _leggi_15min(aoi)
    n_fasce = len(orari)
    fascia_inizio_min = _minuti_da_ora(orari[0])
    fascia_passo_min = _minuti_da_ora(orari[1]) - fascia_inizio_min if n_fasce > 1 else 15.0

    log(f"    calibrazione su {n_fasce} fasce da {fascia_passo_min:g}' ({orari[0]}-{orari[-1]})")
    edge_traffic = np.zeros((n_fasce, n), dtype=np.float32)
    n_fallback = 0
    for f in range(n_fasce):
        fascia = np.zeros(n, dtype=np.float32)
        for id_, edges in matched.items():
            q = _vehicle_equivalents_slice(profili[id_][f])
            idx = np.array(edges, dtype=np.int64)
            fattore = _dispersion_ospm_lite(
                np.full(len(idx), q, dtype=np.float64), H[idx], W[idx], vento["speed_ms"]
            )
            fascia[idx] = fattore.astype(np.float32)

        fallback = _stima_da_centralita(
            betweenness, veicolare, highway, fascia, matched_mask, gruppo_per_edge
        )
        if f == 0:
            n_fallback = int(((~matched_mask) & (fallback > 0)).sum())
        edge_traffic[f] = np.where(matched_mask, fascia, fallback)

    log(
        f"    {n_fallback} tratti stimati dalla centralita' di rete (un valore per tratto, "
        f"non piu' per tipo OSM), {n - n_tratti_matched - n_fallback} restano a zero "
        "(rete non veicolare, o centralita' non calibrabile)"
    )

    # Normalizzazione: il box model produce un conteggio veicoli-equivalenti
    # disperso, senza un limite naturale -- a differenza dell'esposizione
    # solare, gia' in [0, 1]. Il riferimento e' il 95esimo percentile
    # osservato su tutte le fasce e tutti i tratti *misurati direttamente*
    # (mai sul fallback), non il massimo: il massimo e' un singolo tratto
    # (Ponte Maggiore, di gran lunga il piu' trafficato del cordone) circa 15
    # volte piu' alto di una via trafficata tipica -- dividere per quello
    # schiacciava tutta la rete sotto 0.1, rendendo `BETA_MAX` (stesso ordine
    # di grandezza di `ALPHA_MAX`, vedi router) troppo debole per spostare un
    # percorso: uno slider al massimo che di fatto non cambiava nulla. Il
    # 95esimo percentile e' invece rappresentativo delle vie trafficate
    # ordinarie; il tratto piu' estremo si limita a saturare a 1.0 (`clip`)
    # invece di definire da solo la scala. Un riferimento unico su tutta la
    # giornata, non uno per fascia, altrimenti ogni fascia si
    # "appiattirebbe" al proprio massimo e la differenza fra ora di punta e
    # notte sparirebbe proprio nel passo che dovrebbe preservarla.
    valori_misurati = edge_traffic[:, matched_mask]
    riferimento = float(np.percentile(valori_misurati, 95)) if matched_mask.any() else 0.0
    if riferimento > 0:
        edge_traffic = np.clip(edge_traffic / riferimento, 0.0, 1.0).astype(np.float32)
    else:
        log("    ATTENZIONE: nessun tratto misurato, edge_traffic resta a zero ovunque")

    aoi.graph_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        aoi.graph_path,
        **{
            **g,
            "edge_traffic": edge_traffic,
            "traffic_slice_start_min": np.float32(fascia_inizio_min),
            "traffic_slice_step_min": np.float32(fascia_passo_min),
        },
    )

    stats = {
        "n_edges": int(n),
        "matched_edges": int(n_tratti_matched),
        "fallback_edges": int(n_fallback),
        "unmatched_edges": int(n - n_tratti_matched - n_fallback),
        "sections_matched": sorted(matched.keys()),
        "sections_total": len(righe),
        "wind_typical": vento,
        "normalization_reference": riferimento,
        "index_unit": "indice relativo 0..1 (diviso per il 95esimo percentile dei tratti misurati su tutte le fasce, poi saturato a 1.0), non microgrammi/m3",
        "fallback_method": "network_centrality: regressione log(betweenness)->traffico tarata sui tratti misurati, non piu' media per tipo OSM",
        "n_slices": n_fasce,
        "slice_start_min": fascia_inizio_min,
        "slice_step_min": fascia_passo_min,
        "slices_source": "pums_traffico_15min.csv (06:00-19:45, dato reale); fuori da questa finestra il router tiene il valore del bordo piu' vicino",
    }
    stats_path = getattr(aoi, "traffic_stats_path", aoi.dir / "traffico.json")
    stats_path.write_text(json.dumps(stats, indent=2))
    return stats
