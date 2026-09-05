"""Ombre calcolate al momento, sul solo pezzo di citta' e di giornata che serve.

Precalcolare un giorno intero costa minuti: una sessantina di istanti su un
raster di milioni di pixel, quasi tutti lontani da qualunque percorso venga
poi chiesto. Un tragitto usa invece una striscia stretta di citta' e una
manciata di minuti. Calcolare le ombre solo li' costa qualche decimo di
secondo, cioe' abbastanza poco da stare dentro la richiesta HTTP: niente
precalcolo, niente attesa, niente file da tenere aggiornati.

Il ritaglio non e' pero' gratuito in accuratezza, perche' l'ombra che cade
dentro un riquadro spesso e' proiettata da fuori. Due accorgimenti lo
riportano a coincidere con il calcolo su tutta l'area:

  - il riquadro segue il percorso piu' rapido, non la congiungente fra
    partenza e arrivo, e viene allargato per lasciare spazio alle deviazioni
    in ombra che il router potrebbe preferire;
  - viene aggiunta una cornice sui soli lati da cui arriva il sole, dove
    stanno gli edifici e i versanti che fanno ombra dentro il riquadro. Sugli
    altri lati non serve nulla: l'ombra non risale mai verso il sole, e
    allargare anche li' quadruplicherebbe la spesa senza cambiare un pixel.
"""

from __future__ import annotations

import datetime as _dt

import numpy as np

from . import solar
from .exposure import Exposure
from .router import MAX_TRIP_MINUTES
from .shadow import canopy_transmissivity, sample_points, sun_factor

# Quanto allargare il riquadro attorno al percorso piu' rapido. Il router puo'
# deviare per restare in ombra, e una deviazione che uscisse dal ritaglio
# verrebbe valutata come se fosse in pieno sole: si perderebbe proprio la
# scorciatoia ombrosa che l'utente sta cercando.
#
# Il margine e' tarato su quanto le deviazioni si allontanano davvero: su 1821
# percorsi ombreggiati di Ascoli lo scarto dal riquadro del percorso piu'
# rapido e' zero nella meta' dei casi, 87 m al novantesimo percentile e 319 m
# al novantanovesimo. Allargare oltre non compra nulla e costa molto, perche'
# il calcolo delle ombre cresce col quadrato del lato del ritaglio.
CORRIDOR_MARGIN_FRACTION = 0.15
CORRIDOR_MARGIN_MIN = 250.0
CORRIDOR_MARGIN_MAX = 500.0

# Risoluzione a cui calcolare le ombre per il routing. Sottocampiare a 4 m
# costerebbe otto volte meno, ed e' quello che si fa per l'immagine di sfondo
# (render.PREVIEW_RESOLUTION), dove uno scarto di due metri non si vede. Qui
# no: sulle prove di Ascoli a 4 m il percorso scelto cambiava in un quarto
# dei casi, perche' i vicoli stretti del centro sono larghi pochi pixel e
# sottocampiare ne perde l'ombra. Il routing resta quindi alla risoluzione
# piena della superficie.
ROUTING_RESOLUTION = 2.0

# Altezza di riferimento degli ostacoli appena fuori dal ritaglio, usata per
# stimare quanto lontano puo' arrivare la loro ombra. Sessanta metri coprono
# con abbondanza edifici e alberi; i versanti sono piu' alti, ma la loro
# ombra conta solo con il sole radente, quando il carico radiativo e' ormai
# quasi nullo e sbagliarla non sposta la scelta del percorso.
OCCLUDER_HEIGHT = 60.0
SHADOW_REACH_MIN = 100.0
# Oltre questa distanza l'ombra non viene inseguita: e' lo stesso margine con
# cui viene costruita la superficie attorno all'area (AOI.buffer_m).
SHADOW_REACH_MAX = 600.0

# Per quanto tempo calcolare le ombre, in rapporto alla durata del percorso
# piu' rapido: quello in ombra puo' allungarsi, e oltre l'ultimo istante
# calcolato il sole resterebbe fermo dov'era. Sulle prove di Ascoli
# l'allungamento non ha mai superato i due minuti e mezzo, quindi meta'
# durata in piu' e' gia' un margine largo.
TRIP_TIME_FACTOR = 1.5
TRIP_TIME_EXTRA = 10.0


def _shadow_reach(elevation_deg: float) -> float:
    """Fin dove arriva l'ombra di un ostacolo di riferimento, in metri."""
    if elevation_deg <= 0.0:
        return SHADOW_REACH_MIN
    reach = OCCLUDER_HEIGHT / np.tan(np.radians(elevation_deg))
    return float(np.clip(reach, SHADOW_REACH_MIN, SHADOW_REACH_MAX))


def _sun_margins(positions) -> tuple[float, float, float, float]:
    """Cornice da aggiungere su ovest, sud, est e nord, in metri.

    L'azimut e' contato da nord in senso orario, quindi la componente verso
    est del raggio solare e' il suo seno e quella verso nord il coseno: il
    lato da allargare e' quello da cui il sole arriva. Si prende il caso
    peggiore fra tutti gli istanti, perche' il ritaglio e' uno solo per tutto
    il tragitto mentre il sole nel frattempo si sposta.
    """
    west = south = east = north = 0.0
    for elev, azim in positions:
        if elev <= 0.0:
            continue
        reach = _shadow_reach(elev)
        a = np.radians(azim)
        if np.sin(a) > 0:
            east = max(east, reach)
        if np.sin(a) < 0:
            west = max(west, reach)
        if np.cos(a) > 0:
            north = max(north, reach)
        if np.cos(a) < 0:
            south = max(south, reach)
    return west, south, east, north


def corridor_bounds(points_xy, margin=None) -> tuple[float, float, float, float]:
    """Riquadro UTM attorno a un percorso, allargato per le deviazioni."""
    xs, ys = points_xy[:, 0], points_xy[:, 1]
    x0, x1 = float(xs.min()), float(xs.max())
    y0, y1 = float(ys.min()), float(ys.max())
    if margin is None:
        diagonale = float(np.hypot(x1 - x0, y1 - y0))
        margin = float(
            np.clip(
                CORRIDOR_MARGIN_FRACTION * diagonale,
                CORRIDOR_MARGIN_MIN,
                CORRIDOR_MARGIN_MAX,
            )
        )
    return (x0 - margin, y0 - margin, x1 + margin, y1 + margin)


def _read_window(aoi, bounds_utm, step: int = 1):
    """Legge dalle superfici su disco il solo riquadro richiesto.

    I GeoTIFF sono scritti a tasselli, quindi leggere una finestra costa in
    proporzione alla finestra e non al file: qualche decina di millisecondi
    invece di riportare in memoria l'intera citta' a ogni richiesta.

    `step` sottocampiona la griglia prendendo un pixel ogni `step`. Si prende
    il pixel invece di mediarlo perche' su un modello di superficie la media
    smusserebbe gli spigoli dei tetti, che sono proprio cio' che fa l'ombra.

    Ritorna (dsm, cdsm, tau, transform, pixel_size), oppure None se il
    riquadro cade fuori dalla superficie disponibile.
    """
    import rasterio
    from rasterio.windows import Window, from_bounds

    def _ritaglia(src) -> Window | None:
        w = from_bounds(*bounds_utm, transform=src.transform)
        col0 = max(0, int(np.floor(w.col_off)))
        row0 = max(0, int(np.floor(w.row_off)))
        col1 = min(src.width, int(np.ceil(w.col_off + w.width)))
        row1 = min(src.height, int(np.ceil(w.row_off + w.height)))
        if col1 <= col0 or row1 <= row0:
            return None
        return Window(col0, row0, col1 - col0, row1 - row0)

    with rasterio.open(aoi.dsm_path) as src:
        window = _ritaglia(src)
        if window is None:
            return None
        dsm = src.read(1, window=window)[::step, ::step]
        transform = src.window_transform(window) * rasterio.Affine.scale(step, step)

    # Le tre superfici stanno sulla stessa griglia: la finestra e' la stessa.
    cdsm = None
    if aoi.cdsm_path.exists():
        with rasterio.open(aoi.cdsm_path) as src:
            cdsm = src.read(1, window=window)[::step, ::step]
        # Se qui la vegetazione non sopravanza il terreno non serve il
        # secondo passaggio di shadow casting, che costa quanto il primo.
        if not np.any(cdsm > dsm):
            cdsm = None

    tau = None
    if cdsm is not None and aoi.tcd_path.exists():
        with rasterio.open(aoi.tcd_path) as src:
            tau = canopy_transmissivity(src.read(1, window=window)[::step, ::step])

    return dsm, cdsm, tau, transform, aoi.resolution * step


def timesteps(when: _dt.datetime, duration_min: float, step_min: float) -> list:
    """Istanti da calcolare per un tragitto che parte a `when`."""
    durata = min(duration_min * TRIP_TIME_FACTOR + TRIP_TIME_EXTRA, MAX_TRIP_MINUTES)
    # Almeno due istanti: con uno solo non ci sarebbe nulla fra cui interpolare.
    n = max(2, int(np.ceil(durata / step_min)) + 1)
    step = _dt.timedelta(minutes=step_min)
    return [when + i * step for i in range(n)]


def route_exposure(aoi, graph, corridor_xy, when, duration_min, log=None) -> Exposure:
    """Esposizione dei tratti durante un tragitto, calcolata solo dove serve.

    Args:
        corridor_xy: punti UTM che il tragitto attraversa, tipicamente i nodi
            del percorso piu' rapido
        when: istante di partenza, con fuso orario
        duration_min: durata del percorso piu' rapido, in minuti

    Returns:
        Exposure con la stessa interfaccia di una giornata precalcolata.
    """
    times = timesteps(when, duration_min, aoi.step_minutes)
    lon, lat = aoi.center
    positions = [solar.solar_position(lat, lon, t) for t in times]

    midnight = when.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes = np.array(
        [(t - midnight).total_seconds() / 60.0 for t in times], dtype=np.float32
    )
    elevations = np.array([e for e, _ in positions], dtype=np.float32)
    azimuths = np.array([a for _, a in positions], dtype=np.float32)

    n_edges = len(graph["edge_len"])
    # Le righe notturne restano a zero: sotto l'orizzonte e' tutto in ombra,
    # e calcolarlo sarebbe tempo speso per un risultato noto.
    exposure = np.zeros((len(times), n_edges), dtype=np.uint8)

    x0, y0, x1, y1 = corridor_bounds(corridor_xy)
    west, south, east, north = _sun_margins(positions)
    step = max(1, int(round(ROUTING_RESOLUTION / aoi.resolution)))
    surfaces = _read_window(aoi, (x0 - west, y0 - south, x1 + east, y1 + north), step)

    offsets = graph["sample_offset"]
    counts = np.diff(offsets).astype(np.float32)
    xs, ys = graph["sample_xy"][:, 0], graph["sample_xy"][:, 1]

    for i, (elev, azim) in enumerate(positions):
        if elev <= 0.0:
            continue
        if surfaces is None:
            # Fuori dalla superficie disponibile si assume pieno sole, la
            # stessa convenzione prudente di `sample_points`.
            exposure[i] = 255
            continue
        dsm, cdsm, tau, transform, pixel_size = surfaces
        # Non ha senso inseguire ombre piu' lunghe della cornice che e' stata
        # letta: gli ostacoli che le proietterebbero sono comunque fuori dal
        # ritaglio. Troncare li' fa risparmiare le iterazioni piu' costose,
        # quelle con il sole radente.
        factor = sun_factor(
            dsm,
            pixel_size,
            azim,
            elev,
            canopy_surface=cdsm,
            tau=tau,
            max_distance=_shadow_reach(elev),
        )
        values = sample_points(factor, transform, xs, ys, 1.0)
        per_edge = np.add.reduceat(values, offsets[:-1]) / counts
        exposure[i] = np.clip(per_edge * 255.0, 0, 255).astype(np.uint8)

    if log is not None:
        forma = (
            "fuori area"
            if surfaces is None
            else f"{surfaces[0].shape[1]}x{surfaces[0].shape[0]} px a {surfaces[4]:.0f} m"
        )
        log(
            f"  ombre live: {len(times)} istanti da {times[0]:%H:%M} a "
            f"{times[-1]:%H:%M} su un ritaglio di {forma}"
        )

    return Exposure(exposure, minutes, elevations, azimuths, str(when.date()))
