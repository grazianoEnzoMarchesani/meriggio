"""Motore di calcolo delle ombre su modello digitale di superficie.

Implementa lo shadow casting iterativo di Ratti & Richens nella formulazione
di Lindberg (SOLWEIG/UMEP): invece di tracciare un raggio per ogni pixel, la
superficie viene traslata ripetutamente lungo la direzione del sole e
abbassata della quota corrispondente. Il massimo cumulato di queste traslazioni
descrive l'orizzonte visto da ogni pixel; dove supera la quota del pixel,
il pixel e' in ombra.

Il costo e' O(n_passi) operazioni vettoriali sull'intero raster,
indipendentemente dal numero di ostacoli.

La vegetazione e' trattata a parte perche' non e' opaca: una chioma lascia
passare una frazione di radiazione che dipende dalla densita' fogliare.
"""

from __future__ import annotations

import numpy as np

# Trasmissivita' della chioma: frazione di radiazione che filtra attraverso
# gli alberi. Gli estremi corrispondono a chioma molto densa e molto rada.
TAU_DENSE = 0.05
TAU_SPARSE = 0.40
TAU_DEFAULT = 0.18


def shadow_mask(
    occluder, pixel_size, azimuth_deg, elevation_deg, max_distance=None, receiver=None
):
    """Maschera di soleggiamento proiettando gli ostacoli su una superficie.

    Args:
        occluder: array 2D di quote degli ostacoli, in metri, orientato a
            nord (riga 0 = nord)
        pixel_size: dimensione del pixel in metri
        azimuth_deg: azimut solare in gradi da nord, orario
        elevation_deg: elevazione solare in gradi
        max_distance: lunghezza massima d'ombra da considerare, in metri.
            Limita il numero di iterazioni quando il sole e' molto basso.
        receiver: superficie che riceve l'ombra. Se omessa coincide con
            `occluder`, che e' il caso degli edifici: un tetto non fa ombra
            a se' stesso. Va invece distinta per la vegetazione, dove il
            suolo sotto la chioma e' in ombra pur avendo la chioma sopra di
            se' nello stesso pixel.

    Returns:
        array float32 con 1.0 = pixel al sole, 0.0 = pixel in ombra.
    """
    occluder = np.ascontiguousarray(occluder, dtype=np.float32)
    surface = occluder if receiver is None else np.ascontiguousarray(
        receiver, dtype=np.float32
    )
    rows, cols = occluder.shape

    # Sotto l'orizzonte non c'e' luce diretta: tutto in ombra.
    if elevation_deg <= 0.0:
        return np.zeros((rows, cols), dtype=np.float32)

    azimuth = np.radians(float(azimuth_deg) % 360.0)
    altitude = np.radians(float(elevation_deg))

    # Dislivello massimo presente nella scena: oltre questa quota nessun
    # ostacolo puo' piu' proiettare ombra su nulla.
    finite = occluder[np.isfinite(occluder)]
    if finite.size == 0:
        return np.ones((rows, cols), dtype=np.float32)
    relief = float(finite.max() - finite.min())
    if relief <= 0.0 and receiver is None:
        return np.ones((rows, cols), dtype=np.float32)

    if max_distance is not None:
        relief = min(relief, float(max_distance) * np.tan(altitude))

    # Il passo iniziale, senza traslazione, mette in ombra il suolo che ha
    # un ostacolo esattamente sopra di se': e' il caso di chi cammina sotto
    # un albero con il sole allo zenit.
    horizon = occluder.copy()
    shifted = np.empty_like(occluder)

    sin_az, cos_az = np.sin(azimuth), np.cos(azimuth)
    sign_sin, sign_cos = np.sign(sin_az), np.sign(cos_az)
    tan_alt_by_scale = np.tan(altitude) * pixel_size

    pi4 = np.pi / 4.0
    # Nei settori dove domina la componente est-ovest si avanza di un pixel
    # per colonna, altrimenti di un pixel per riga: cosi' il passo di
    # campionamento resta sempre <= 1 pixel e non si "bucano" ostacoli.
    east_west_dominant = (pi4 <= azimuth < 3 * pi4) or (5 * pi4 <= azimuth < 7 * pi4)
    step_len = abs(1.0 / sin_az) if east_west_dominant else abs(1.0 / cos_az)

    dz = 0.0
    drow = dcol = 0.0
    index = 1

    while dz < relief and abs(drow) < rows and abs(dcol) < cols:
        if east_west_dominant:
            dcol = sign_sin * index
            drow = -sign_cos * abs(round(index / np.tan(azimuth)))
        else:
            dcol = sign_sin * abs(round(index * np.tan(azimuth)))
            drow = -sign_cos * index

        # Quota persa percorrendo questa distanza lungo il raggio solare
        dz = step_len * index * tan_alt_by_scale

        adrow, adcol = abs(drow), abs(dcol)
        # Finestra sorgente (da dove si legge) e destinazione (dove si scrive)
        src_r0 = int((drow + adrow) / 2.0)
        src_r1 = int(rows + (drow - adrow) / 2.0)
        src_c0 = int((dcol + adcol) / 2.0)
        src_c1 = int(cols + (dcol - adcol) / 2.0)
        dst_r0 = int(-((drow - adrow) / 2.0))
        dst_r1 = int(rows - (drow + adrow) / 2.0)
        dst_c0 = int(-((dcol - adcol) / 2.0))
        dst_c1 = int(cols - (dcol + adcol) / 2.0)

        shifted[:] = -np.inf
        shifted[dst_r0:dst_r1, dst_c0:dst_c1] = (
            occluder[src_r0:src_r1, src_c0:src_c1] - dz
        )
        np.maximum(horizon, shifted, out=horizon)
        index += 1

    # Un pixel e' in ombra se l'orizzonte proiettato supera la sua quota
    return (horizon <= surface).astype(np.float32)


def canopy_transmissivity(tcd_percent):
    """Trasmissivita' della chioma a partire dalla densita' di copertura.

    `tcd_percent` e' la Tree Cover Density Copernicus (0-100). Chioma densa
    lascia passare poca luce, chioma rada molta.
    """
    if tcd_percent is None:
        return None
    tcd = np.clip(np.asarray(tcd_percent, dtype=np.float32), 0.0, 100.0) / 100.0
    return (TAU_SPARSE + (TAU_DENSE - TAU_SPARSE) * tcd).astype(np.float32)


def sun_factor(
    dsm,
    pixel_size,
    azimuth_deg,
    elevation_deg,
    canopy_surface=None,
    tau=None,
    max_distance=1500.0,
):
    """Frazione di radiazione diretta che raggiunge ogni pixel, in [0, 1].

    Args:
        dsm: superficie opaca (terreno + edifici), in metri
        pixel_size: lato del pixel in metri
        azimuth_deg, elevation_deg: posizione del sole
        canopy_surface: superficie della vegetazione (terreno + chioma).
            Se assente si considera solo l'ombra opaca.
        tau: trasmissivita' della chioma, scalare o array della stessa forma
            del raster. Se None si usa TAU_DEFAULT.
        max_distance: distanza massima di proiezione dell'ombra, in metri

    Returns:
        array float32: 1.0 pieno sole, 0.0 ombra piena di edifici o terreno,
        valori intermedi sotto le chiome.
    """
    # Edifici e terreno: ostacolo e ricevitore coincidono, un tetto non fa
    # ombra a se' stesso.
    built = shadow_mask(dsm, pixel_size, azimuth_deg, elevation_deg, max_distance)

    if canopy_surface is None:
        return built

    # Chiome: l'ostacolo comprende anche la vegetazione, ma l'ombra va
    # proiettata sul suolo. Cosi' chi cammina sotto un albero risulta in
    # ombra anche con il sole allo zenit.
    occluder = np.maximum(dsm, canopy_surface)
    total = shadow_mask(
        occluder, pixel_size, azimuth_deg, elevation_deg, max_distance, receiver=dsm
    )

    # Pixel al sole rispetto al costruito ma in ombra considerando le chiome:
    # sono quelli ombreggiati soltanto dagli alberi.
    veg_only = (built > 0.5) & (total < 0.5)
    if tau is None:
        tau = TAU_DEFAULT
    return np.where(veg_only, np.asarray(tau, dtype=np.float32), built).astype(
        np.float32
    )


def sample_points(raster, transform, xs, ys, default=1.0):
    """Campiona un raster su coordinate proiettate, con nearest neighbour.

    `transform` e' un affine di rasterio. I punti fuori dal raster ricevono
    `default` (assunzione prudente: fuori dall'area coperta si sta al sole).
    """
    inv = ~transform
    cols, rows = inv * (np.asarray(xs), np.asarray(ys))
    cols = np.floor(cols).astype(np.int64)
    rows = np.floor(rows).astype(np.int64)

    h, w = raster.shape
    inside = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)

    out = np.full(rows.shape, default, dtype=np.float32)
    out[inside] = raster[rows[inside], cols[inside]]
    return out
