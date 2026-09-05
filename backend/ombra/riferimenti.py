"""Valori di riferimento per verificare il porting del calcolo nel browser.

Il calcolo delle ombre e dei percorsi e' stato riscritto in TypeScript per
girare nel browser. Riscritto, non reinventato: e' la stessa sequenza di
operazioni, e l'unico modo di saperlo e' confrontare i numeri.

Questo modulo fa girare il codice Python su casi scelti e ne scrive i
risultati dove i test del client li vanno a leggere. Se qualcuno cambia una
formula di qua senza cambiarla di la', il confronto se ne accorge.
"""

from __future__ import annotations

import base64
import gzip
import datetime as _dt
import json
import zoneinfo
from pathlib import Path

import numpy as np

from . import solar
from .shadow import canopy_transmissivity, sample_points, sun_factor

ROME = zoneinfo.ZoneInfo("Europe/Rome")

# Ascoli Piceno, l'area su cui il progetto e' stato tarato fin dall'inizio.
ASCOLI = (42.8536, 13.5749)


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


# ---------------------------------------------------------------------------
# Sole
# ---------------------------------------------------------------------------

def riferimenti_solari() -> dict:
    """Posizione del sole su istanti e luoghi scelti per essere scomodi."""
    luoghi = [
        ("ascoli", *ASCOLI),
        ("bolzano", 46.4983, 11.3548),      # il piu' a nord
        ("lampedusa", 35.4996, 12.6069),    # il piu' a sud
        ("greenwich", 51.4779, 0.0),        # longitudine nulla
        ("azzorre", 37.7412, -25.6756),     # longitudine negativa
    ]
    # Solstizi, equinozi, i due cambi d'ora e qualche giorno qualunque.
    giorni = [
        "2026-01-15", "2026-03-20", "2026-03-29", "2026-06-21", "2026-07-30",
        "2026-09-22", "2026-10-25", "2026-12-21",
    ]
    ore = [0, 3, 5, 6, 7, 9, 12, 13, 15, 17, 19, 21, 23]

    campioni = []
    for nome, lat, lon in luoghi:
        for giorno in giorni:
            d = _dt.date.fromisoformat(giorno)
            for h in ore:
                # Un minuto e un secondo non tondi: se il porting sbagliasse
                # a leggere i secondi, con orari tondi non si vedrebbe.
                t = _dt.datetime(d.year, d.month, d.day, h, 37, 23, tzinfo=ROME)
                elev, azim = solar.solar_position(lat, lon, t)
                campioni.append(
                    {
                        "luogo": nome,
                        "lat": lat,
                        "lon": lon,
                        "utc": t.astimezone(_dt.timezone.utc).isoformat(),
                        "elevation": float(elev),
                        "azimuth": float(azim),
                        "ghi": float(solar.clear_sky_irradiance(elev)),
                        "load": float(solar.solar_load(elev)),
                    }
                )

    orari = []
    for giorno in giorni:
        d = _dt.date.fromisoformat(giorno)
        t = solar.sun_times(ASCOLI[0], ASCOLI[1], d, ROME)
        mezzanotte = _dt.datetime.combine(d, _dt.time(0, 0), tzinfo=ROME)
        orari.append(
            {
                "giorno": giorno,
                "mezzanotte_utc": mezzanotte.astimezone(_dt.timezone.utc).isoformat(),
                "lat": ASCOLI[0],
                "lon": ASCOLI[1],
                "sunrise": t["sunrise"].astimezone(_dt.timezone.utc).isoformat() if t["sunrise"] else None,
                "sunset": t["sunset"].astimezone(_dt.timezone.utc).isoformat() if t["sunset"] else None,
                "solar_noon": t["solar_noon"].astimezone(_dt.timezone.utc).isoformat(),
                "max_elevation": float(t["max_elevation"]),
            }
        )

    return {"campioni": campioni, "orari": orari}


# ---------------------------------------------------------------------------
# Ombre
# ---------------------------------------------------------------------------

def _scena_sintetica(seed: int, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Una citta' finta ma difficile: torri isolate, un crinale, alberi sparsi.

    Sintetica perche' un caso piccolo si confronta pixel per pixel a mano
    quando qualcosa non torna, e difficile perche' mette insieme le tre
    situazioni che il porting potrebbe sbagliare: ostacoli isolati (i bordi
    della finestra di traslazione), un rilievo continuo (il massimo cumulato)
    e vegetazione semitrasparente sopra il suolo.
    """
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)

    terreno = 100.0 + 0.06 * x + 12.0 * np.sin(y / 11.0) * np.cos(x / 17.0)
    dsm = terreno.copy()
    for _ in range(12):
        r0, c0 = rng.integers(0, n - 6, 2)
        h, w = rng.integers(3, 7, 2)
        dsm[r0 : r0 + h, c0 : c0 + w] += float(rng.uniform(6.0, 40.0))

    canopy = np.zeros((n, n), dtype=np.float32)
    tcd = np.zeros((n, n), dtype=np.float32)
    for _ in range(20):
        r0, c0 = rng.integers(1, n - 4, 2)
        if dsm[r0, c0] > terreno[r0, c0]:
            continue  # niente alberi sui tetti, come in `surface.py`
        canopy[r0 : r0 + 3, c0 : c0 + 3] = float(rng.uniform(4.0, 14.0))
        tcd[r0 : r0 + 3, c0 : c0 + 3] = float(rng.integers(10, 100))

    return dsm.astype(np.float32), canopy.astype(np.float32), tcd.astype(np.float32)


# Angoli scelti per toccare tutti i rami del calcolo: i quattro settori di
# azimut, il confine fra settore dominante est-ovest e nord-sud, il sole alto
# e quello radente, e un caso sotto l'orizzonte.
_ANGOLI = [
    (30.0, 20.0), (44.9, 15.0), (45.1, 15.0), (90.0, 5.0), (120.0, 60.0),
    (180.0, 70.5), (225.0, 8.0), (270.0, 3.0), (315.0, 25.0), (359.0, 45.0),
    (200.0, 0.0), (200.0, -5.0),
]


def riferimenti_ombre(aoi=None) -> dict:
    """`sun_factor` su scene sintetiche e, se disponibile, su una vera."""
    casi = []

    def _aggiungi(nome, dsm, canopy, tcd, pixel_size, max_distance):
        cdsm = dsm + canopy
        usa_chiome = bool(np.any(cdsm > dsm))
        tau = canopy_transmissivity(tcd) if usa_chiome else None
        caso = {
            "nome": nome,
            "width": int(dsm.shape[1]),
            "height": int(dsm.shape[0]),
            "pixel_size": pixel_size,
            "max_distance": max_distance,
            "dsm": _b64(dsm.astype("<f4")),
            "canopy": _b64(canopy.astype("<f4")) if usa_chiome else None,
            "tcd": _b64(tcd.astype("<f4")) if usa_chiome else None,
            "attesi": [],
        }
        for azim, elev in _ANGOLI:
            f = sun_factor(
                dsm,
                pixel_size,
                azim,
                elev,
                canopy_surface=cdsm if usa_chiome else None,
                tau=tau,
                max_distance=max_distance,
            )
            caso["attesi"].append(
                {"azimuth": azim, "elevation": elev, "factor": _b64(f.astype("<f4"))}
            )
        casi.append(caso)

    dsm, canopy, tcd = _scena_sintetica(7, 64)
    _aggiungi("sintetica-64", dsm, canopy, tcd, 2.0, 1500.0)
    _aggiungi("sintetica-64-troncata", dsm, canopy, tcd, 2.0, 60.0)

    dsm, canopy, tcd = _scena_sintetica(11, 33)  # lato dispari: bordi scomodi
    _aggiungi("sintetica-33-senza-alberi", dsm, np.zeros_like(canopy), tcd, 2.0, 1500.0)

    if aoi is not None and aoi.dsm_path.exists():
        import rasterio

        # Un ritaglio del centro storico: vicoli stretti, palazzi alti e il
        # crinale del Colle San Marco a fare ombra da fuori.
        finestra = rasterio.windows.Window(1000, 1000, 192, 192)
        with rasterio.open(aoi.dsm_path) as src:
            r_dsm = src.read(1, window=finestra)
        r_canopy = np.zeros_like(r_dsm)
        r_tcd = np.zeros_like(r_dsm)
        if aoi.cdsm_path.exists():
            with rasterio.open(aoi.cdsm_path) as src:
                r_canopy = np.maximum(src.read(1, window=finestra) - r_dsm, 0.0)
        if aoi.tcd_path.exists():
            with rasterio.open(aoi.tcd_path) as src:
                r_tcd = src.read(1, window=finestra)
        _aggiungi("ascoli-centro", r_dsm, r_canopy, r_tcd, aoi.resolution, 600.0)

    return {"casi": casi}


# ---------------------------------------------------------------------------
# Proiezione
# ---------------------------------------------------------------------------

def riferimenti_proiezione() -> dict:
    """Le stesse trasformazioni che faceva pyproj, per verificarne il seguito.

    Un errore anche piccolo qui non si vedrebbe come errore: sposterebbe il
    punto cliccato sulla mappa e lo aggancerebbe a un tratto di strada vicino
    ma diverso, dando un percorso plausibile e sbagliato.
    """
    from pyproj import Transformer

    rng = np.random.default_rng(5)
    casi = []
    # Un fuso per ciascun estremo d'Italia, piu' l'emisfero sud per completezza.
    for epsg, lon0, lat0, raggio in (
        (32633, 13.5749, 42.8536, 1.5),    # Ascoli, vicino al meridiano centrale
        (32632, 7.6869, 45.0703, 1.5),     # Torino, al bordo ovest del fuso
        (32633, 18.1750, 40.3520, 1.5),    # Lecce, al bordo est
        (32632, 12.4964, 41.9028, 1.0),    # Roma, fuori fuso di quasi tre gradi
        (32723, -46.6333, -23.5505, 1.0),  # emisfero sud
    ):
        avanti = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        indietro = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
        lons = lon0 + rng.uniform(-raggio, raggio, 120)
        lats = lat0 + rng.uniform(-raggio, raggio, 120)
        xs, ys = avanti.transform(lons, lats)
        back_lon, back_lat = indietro.transform(xs, ys)
        casi.append(
            {
                "epsg": epsg,
                "lon": [float(v) for v in lons],
                "lat": [float(v) for v in lats],
                "x": [float(v) for v in xs],
                "y": [float(v) for v in ys],
                "lon_ritorno": [float(v) for v in back_lon],
                "lat_ritorno": [float(v) for v in back_lat],
            }
        )
    return {"casi": casi}


# ---------------------------------------------------------------------------
# Percorsi
# ---------------------------------------------------------------------------

_TUTTE = ("foot", "bike", "wheelchair")

_TRAGITTI = [
    # (nome, partenza lon/lat, arrivo lon/lat, modalita')
    ("centro-breve", (13.5744, 42.8542), (13.5801, 42.8556), _TUTTE),
    ("centro-ponte", (13.5700, 42.8530), (13.5850, 42.8580), _TUTTE),
    # Da un capo all'altro dell'area: il caso peggiore, quello dove il
    # corridoio finisce per coincidere con tutta la citta'. Niente carrozzina:
    # ad Ascoli i gradini spezzano la rete e i due estremi finiscono su
    # componenti diverse, che e' esattamente il caso in cui il router deve
    # rifiutare invece di inventarsi un percorso.
    ("attraversamento", (13.556062, 42.850330), (13.593122, 42.867935), ("foot", "bike")),
]
_ORARI = ["08:15", "13:40", "18:50"]


def riferimenti_percorsi(aoi, log=print) -> dict:
    """Percorsi completi calcolati dal backend, come li deve rifare il client."""
    from .graph import load_graph
    from .live import route_exposure
    from .router import RoutingError, compute_route

    graph = load_graph(aoi)
    giorno = "2026-07-30"
    casi = []

    for nome, partenza, arrivo, modalita in _TRAGITTI:
        for ora in _ORARI:
            for modo in modalita:
                when = _dt.datetime.fromisoformat(f"{giorno}T{ora}:00").replace(tzinfo=ROME)
                minuto = when.hour * 60 + when.minute
                try:
                    res = compute_route(
                        aoi,
                        graph,
                        lambda corridoio, durata: route_exposure(
                            aoi, graph, corridoio, when, durata
                        ),
                        partenza,
                        arrivo,
                        mode=modo,
                        departure_minute=minuto,
                        alpha=3.0,
                    )
                except RoutingError as exc:
                    log(f"  {nome} {ora} {modo}: {exc}")
                    continue
                casi.append(
                    {
                        "nome": f"{nome}-{ora}-{modo}",
                        "partenza": list(partenza),
                        "arrivo": list(arrivo),
                        "modalita": modo,
                        "giorno": giorno,
                        "ora": ora,
                        "utc": when.astimezone(_dt.timezone.utc).isoformat(),
                        "departure_minute": minuto,
                        "alpha": 3.0,
                        "atteso": {
                            variante: {
                                "distance_m": res[variante]["distance_m"],
                                "duration_min": res[variante]["duration_min"],
                                "shade_pct": res[variante]["shade_pct"],
                                "sun_dose_min": res[variante]["sun_dose_min"],
                                "n_segments": len(res[variante]["segments"]),
                                "coordinates": [
                                    [round(c[0], 6), round(c[1], 6)]
                                    for c in res[variante]["coordinates"]
                                ],
                            }
                            for variante in ("shaded", "fastest")
                        },
                    }
                )
                log(f"  {casi[-1]['nome']}: {res['shaded']['distance_m']:.0f} m, "
                    f"{res['shaded']['shade_pct']:.1f}% ombra")

    # Casi con l'asse traffico (Fase 4 del piano comfort-traffico), aggiunti
    # senza toccare i casi sun-only sopra: alpha=3,beta=3 esercita la somma
    # dei due termini nella stessa formula di costo; alpha=0,beta=3 esercita
    # il cambio del gate sul secondo Dijkstra (un utente che vuole *solo*
    # evitare il traffico deve ottenere un percorso ricalcolato, non quello
    # piatto). Solo due tragitti e un solo orario, a piedi: bastano a
    # verificare il porting, non serve la stessa copertura dei casi sun-only.
    for nome, partenza, arrivo, _ in _TRAGITTI[:2]:
        for alpha, beta in ((3.0, 3.0), (0.0, 3.0)):
            ora = "13:40"
            when = _dt.datetime.fromisoformat(f"{giorno}T{ora}:00").replace(tzinfo=ROME)
            minuto = when.hour * 60 + when.minute
            try:
                res = compute_route(
                    aoi,
                    graph,
                    lambda corridoio, durata: route_exposure(
                        aoi, graph, corridoio, when, durata
                    ),
                    partenza,
                    arrivo,
                    mode="foot",
                    departure_minute=minuto,
                    alpha=alpha,
                    beta=beta,
                )
            except RoutingError as exc:
                log(f"  {nome} traffico alpha={alpha} beta={beta}: {exc}")
                continue
            casi.append(
                {
                    "nome": f"{nome}-{ora}-foot-alpha{alpha:g}-beta{beta:g}",
                    "partenza": list(partenza),
                    "arrivo": list(arrivo),
                    "modalita": "foot",
                    "giorno": giorno,
                    "ora": ora,
                    "utc": when.astimezone(_dt.timezone.utc).isoformat(),
                    "departure_minute": minuto,
                    "alpha": alpha,
                    "beta": beta,
                    "atteso": {
                        variante: {
                            "distance_m": res[variante]["distance_m"],
                            "duration_min": res[variante]["duration_min"],
                            "shade_pct": res[variante]["shade_pct"],
                            "sun_dose_min": res[variante]["sun_dose_min"],
                            "avg_traffic_index": res[variante]["avg_traffic_index"],
                            "n_segments": len(res[variante]["segments"]),
                            "coordinates": [
                                [round(c[0], 6), round(c[1], 6)]
                                for c in res[variante]["coordinates"]
                            ],
                        }
                        for variante in ("shaded", "fastest")
                    },
                }
            )
            log(
                f"  {casi[-1]['nome']}: {res['shaded']['distance_m']:.0f} m, "
                f"indice traffico {res['shaded']['avg_traffic_index']:.3f}"
            )

    return {"casi": casi}


# ---------------------------------------------------------------------------
# Campionamento
# ---------------------------------------------------------------------------

def riferimenti_campioni(aoi) -> dict:
    """`sample_points` su una griglia nota, bordi e fuori raster compresi."""
    import rasterio

    finestra = rasterio.windows.Window(1000, 1000, 64, 64)
    with rasterio.open(aoi.dsm_path) as src:
        raster = src.read(1, window=finestra)
        transform = src.window_transform(finestra)

    rng = np.random.default_rng(3)
    x0, y1 = transform.c, transform.f
    res = transform.a
    # Punti dentro, esattamente sui bordi dei pixel e ben fuori dal ritaglio.
    xs = np.concatenate([
        rng.uniform(x0 - 20, x0 + 64 * res + 20, 300),
        x0 + np.arange(0, 65) * res,
        [x0 - 1000.0, x0 + 5000.0],
    ])
    ys = np.concatenate([
        rng.uniform(y1 - 64 * res - 20, y1 + 20, 300),
        y1 - np.arange(0, 65) * res,
        [y1 + 1000.0, y1 - 5000.0],
    ])
    valori = sample_points(raster, transform, xs, ys, 1.0)

    return {
        "width": int(raster.shape[1]),
        "height": int(raster.shape[0]),
        "origin": [float(transform.c), float(transform.f)],
        "resolution": float(transform.a),
        "raster": _b64(raster.astype("<f4")),
        "xs": _b64(xs.astype("<f8")),
        "ys": _b64(ys.astype("<f8")),
        "attesi": _b64(valori.astype("<f4")),
    }


# ---------------------------------------------------------------------------
# Traffico
# ---------------------------------------------------------------------------

def riferimenti_traffico(aoi=None, log=print) -> dict:
    """Valori noti di `edge_traffic` su tratti scelti, per verificare l'export.

    La calibrazione (`traffico.calibra`) gira solo in Python, mai nel
    browser: non serve rifarne l'algoritmo in TypeScript. Questa fixture
    guarda le spalle a qualcos'altro, il pacchettamento del formato v3 del
    grafo (`export.export_graph`, Fase 3/4 del piano) -- cioe' che il valore
    di `edge_traffic` che arriva al client per un dato tratto e una data
    fascia sia lo stesso che Python ha scritto in `graph.npz`, non uno
    spostato da un ordine di array sbagliato nel binario. Guarda una sola
    fascia (le 08:15, un picco: valori piu' interessanti di uno a caso), non
    tutte le 56 -- basta a coprire il pacchettamento, non serve rifare qui
    l'intera griglia oraria.
    """
    from .graph import load_graph

    if aoi is None or not aoi.graph_path.exists():
        return {"casi": []}

    g = load_graph(aoi)
    if "edge_traffic" not in g:
        return {"casi": []}

    edge_traffic_tutte = g["edge_traffic"]
    slice_start = float(g.get("traffic_slice_start_min", 0.0))
    slice_step = float(g.get("traffic_slice_step_min", 15.0))
    fascia_idx = int(round((8 * 60 + 15 - slice_start) / slice_step))
    fascia_idx = max(0, min(fascia_idx, edge_traffic_tutte.shape[0] - 1))
    edge_traffic = edge_traffic_tutte[fascia_idx]
    names = g["names"]
    edge_name = g["edge_name"]

    def _caso(i: int, tipo: str) -> dict:
        return {
            "edge_index": int(i),
            "tipo": tipo,
            "name": str(names[edge_name[i]]),
            "edge_traffic": float(edge_traffic[i]),
        }

    casi = []

    # I tratti a valore piu' alto sono quasi certamente calibrati
    # direttamente da una sezione PUMS del gruppo cordone (traffico intenso).
    per_valore = np.argsort(edge_traffic)[::-1]
    for i in per_valore[:5]:
        if edge_traffic[i] <= 0:
            break
        casi.append(_caso(int(i), "misurato-o-fallback"))

    # Alcuni tratti a valore intermedio: piu' probabile il fallback
    # tipologico (media sul tipo OSM) che una misura diretta.
    positivi = np.flatnonzero(edge_traffic > 0)
    if len(positivi) > 10:
        mediana = float(np.median(edge_traffic[positivi]))
        vicino_mediana = positivi[np.argsort(np.abs(edge_traffic[positivi] - mediana))][:3]
        for i in vicino_mediana:
            casi.append(_caso(int(i), "fallback-probabile"))

    # E alcuni tratti a zero: nessun dato, ne' misura ne' fallback tipologico.
    zeri = np.flatnonzero(edge_traffic == 0)
    for i in zeri[:3]:
        casi.append(_caso(int(i), "nessun-dato"))

    log(f"    {len(casi)} tratti di riferimento traffico (fascia 08:15, indice {fascia_idx})")
    return {"casi": casi, "fascia_idx": fascia_idx, "fascia_ora": "08:15"}


# ---------------------------------------------------------------------------

def scrivi(dest: Path, aoi=None, percorsi: bool = True, log=print) -> None:
    """Scrive tutti i file di riferimento nella cartella indicata."""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)

    def _salva(nome, payload):
        # I riferimenti delle ombre sono raster interi: in chiaro sarebbero
        # megabyte di base64 dentro il repository, compressi sono spiccioli.
        path = dest / f"{nome}.json.gz"
        path.write_bytes(gzip.compress(json.dumps(payload).encode(), 9))
        log(f"  {path.name}: {path.stat().st_size / 1024:.0f} kB")

    log("  sole")
    _salva("solar", riferimenti_solari())

    log("  proiezione")
    _salva("proiezione", riferimenti_proiezione())

    log("  ombre")
    _salva("shadow", riferimenti_ombre(aoi))

    if aoi is not None:
        log("  campionamento")
        _salva("campioni", riferimenti_campioni(aoi))
        log("  traffico")
        _salva("traffico", riferimenti_traffico(aoi, log=log))
        if percorsi:
            log("  percorsi")
            _salva("percorsi", riferimenti_percorsi(aoi, log=log))
