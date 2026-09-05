"""Posizione solare e carico radiativo.

Implementa l'algoritmo NOAA Solar Calculator in forma vettorizzata (numpy),
senza dipendenze esterne. Tutte le funzioni accettano scalari o array.

Convenzioni:
  - elevation (altitudine solare): gradi sopra l'orizzonte, negativa di notte
  - azimuth: gradi da Nord, in senso orario (E=90, S=180, W=270)
  - i datetime devono essere timezone-aware; vengono convertiti in UTC
"""

from __future__ import annotations

import datetime as _dt
import math

import numpy as np

# Costante solare al di fuori dell'atmosfera (W/m2)
SOLAR_CONSTANT = 1361.0


def _to_utc_array(when):
    """Normalizza uno o piu' datetime tz-aware in array di timestamp UTC."""
    scalar = isinstance(when, _dt.datetime)
    items = [when] if scalar else list(when)
    out = []
    for t in items:
        if t.tzinfo is None:
            raise ValueError("I datetime devono essere timezone-aware")
        out.append(t.astimezone(_dt.timezone.utc))
    return out, scalar


def _julian_century(times_utc):
    """Secoli giuliani dall'epoca J2000.0 per una lista di datetime UTC."""
    jd = np.empty(len(times_utc), dtype=np.float64)
    for i, t in enumerate(times_utc):
        y, m = t.year, t.month
        if m <= 2:
            y -= 1
            m += 12
        a = y // 100
        b = 2 - a + a // 4
        day_frac = (
            t.day
            + (t.hour + (t.minute + (t.second + t.microsecond / 1e6) / 60.0) / 60.0)
            / 24.0
        )
        jd[i] = (
            math.floor(365.25 * (y + 4716))
            + math.floor(30.6001 * (m + 1))
            + day_frac
            + b
            - 1524.5
        )
    return (jd - 2451545.0) / 36525.0, jd


def solar_position(lat, lon, when):
    """Elevazione e azimut solare secondo NOAA.

    Args:
        lat: latitudine in gradi (nord positiva)
        lon: longitudine in gradi (est positiva)
        when: datetime tz-aware, oppure sequenza di datetime

    Returns:
        (elevation_deg, azimuth_deg) come float se `when` e' scalare,
        altrimenti come array numpy.
    """
    times, scalar = _to_utc_array(when)
    jc, _ = _julian_century(times)

    minutes = np.array(
        [
            t.hour * 60.0 + t.minute + (t.second + t.microsecond / 1e6) / 60.0
            for t in times
        ],
        dtype=np.float64,
    )

    # Longitudine media e anomalia media del Sole
    geom_mean_long = np.mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360.0)
    geom_mean_anom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)

    anom_rad = np.radians(geom_mean_anom)
    sun_eq_ctr = (
        np.sin(anom_rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        + np.sin(2 * anom_rad) * (0.019993 - 0.000101 * jc)
        + np.sin(3 * anom_rad) * 0.000289
    )
    sun_true_long = geom_mean_long + sun_eq_ctr

    # Longitudine apparente (corretta per nutazione e aberrazione)
    omega = np.radians(125.04 - 1934.136 * jc)
    sun_app_long = sun_true_long - 0.00569 - 0.00478 * np.sin(omega)

    mean_obliq = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0
    obliq_corr = mean_obliq + 0.00256 * np.cos(omega)

    declin = np.degrees(
        np.arcsin(np.sin(np.radians(obliq_corr)) * np.sin(np.radians(sun_app_long)))
    )

    # Equazione del tempo (minuti)
    vary = np.tan(np.radians(obliq_corr / 2.0)) ** 2
    l0_rad = np.radians(geom_mean_long)
    eq_time = 4.0 * np.degrees(
        vary * np.sin(2 * l0_rad)
        - 2 * eccent * np.sin(anom_rad)
        + 4 * eccent * vary * np.sin(anom_rad) * np.cos(2 * l0_rad)
        - 0.5 * vary * vary * np.sin(4 * l0_rad)
        - 1.25 * eccent * eccent * np.sin(2 * anom_rad)
    )

    # Tempo solare vero: partiamo da UTC, quindi la correzione di
    # longitudine e' semplicemente 4 minuti per grado a est di Greenwich.
    true_solar_time = np.mod(minutes + eq_time + 4.0 * lon, 1440.0)
    hour_angle = np.where(
        true_solar_time / 4.0 < 0.0,
        true_solar_time / 4.0 + 180.0,
        true_solar_time / 4.0 - 180.0,
    )

    lat_rad = np.radians(lat)
    decl_rad = np.radians(declin)
    ha_rad = np.radians(hour_angle)

    cos_zenith = np.clip(
        np.sin(lat_rad) * np.sin(decl_rad)
        + np.cos(lat_rad) * np.cos(decl_rad) * np.cos(ha_rad),
        -1.0,
        1.0,
    )
    zenith = np.degrees(np.arccos(cos_zenith))
    elevation = 90.0 - zenith

    # Rifrazione atmosferica (approssimazione NOAA), trascurabile sotto -1 grado
    elev_rad = np.radians(np.clip(elevation, -5.0, 90.0))
    tan_e = np.tan(elev_rad)
    with np.errstate(divide="ignore", invalid="ignore"):
        refraction = np.where(
            elevation > 85.0,
            0.0,
            np.where(
                elevation > 5.0,
                58.1 / tan_e - 0.07 / tan_e**3 + 0.000086 / tan_e**5,
                np.where(
                    elevation > -0.575,
                    1735.0
                    + elevation
                    * (
                        -518.2
                        + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711))
                    ),
                    -20.772 / np.where(tan_e == 0, np.nan, tan_e),
                ),
            ),
        )
    refraction = np.nan_to_num(refraction) / 3600.0
    elevation = elevation + refraction

    # Azimut
    sin_zen = np.sin(np.radians(zenith))
    sin_zen = np.where(np.abs(sin_zen) < 1e-9, 1e-9, sin_zen)
    cos_az = np.clip(
        (np.sin(lat_rad) * np.cos(np.radians(zenith)) - np.sin(decl_rad))
        / (np.cos(lat_rad) * sin_zen),
        -1.0,
        1.0,
    )
    az_core = np.degrees(np.arccos(cos_az))
    azimuth = np.where(
        hour_angle > 0.0,
        np.mod(az_core + 180.0, 360.0),
        np.mod(540.0 - az_core, 360.0),
    )

    if scalar:
        return float(elevation[0]), float(azimuth[0])
    return elevation, azimuth


def clear_sky_irradiance(elevation_deg, elevation_m=0.0):
    """Irradianza globale su piano orizzontale con cielo sereno (W/m2).

    Modello di Meinel: attenua la costante solare in funzione della massa
    d'aria attraversata. Serve a pesare quanto "costa" stare al sole a una
    certa ora: il sole radente di mattina scalda molto meno di quello di
    mezzogiorno.
    """
    elev = np.asarray(elevation_deg, dtype=np.float64)
    sin_h = np.sin(np.radians(np.clip(elev, 0.0, 90.0)))
    # Massa d'aria relativa (Kasten-Young), stabile anche a bassa elevazione
    with np.errstate(divide="ignore", invalid="ignore"):
        am = 1.0 / (
            sin_h + 0.50572 * np.power(np.clip(elev, 0.0, 90.0) + 6.07995, -1.6364)
        )
    am = np.nan_to_num(am, nan=40.0, posinf=40.0)
    # Correzione per quota (pressione ridotta)
    am = am * np.exp(-np.asarray(elevation_m, dtype=np.float64) / 8434.0)

    direct_normal = SOLAR_CONSTANT * np.power(0.7, np.power(am, 0.678))
    beam_horizontal = direct_normal * sin_h
    diffuse = 0.10 * beam_horizontal + 20.0 * sin_h
    ghi = np.where(elev > 0.0, beam_horizontal + diffuse, 0.0)
    return ghi


def solar_load(elevation_deg):
    """Carico radiativo normalizzato in [0, 1].

    1.0 corrisponde grosso modo al sole di mezzogiorno d'estate. Usato dal
    router per modulare la penalita' di esposizione: camminare al sole alle
    7 del mattino pesa molto meno che alle 14.
    """
    ghi = clear_sky_irradiance(elevation_deg)
    return np.clip(ghi / 950.0, 0.0, 1.0)


# Elevazione apparente del centro del disco solare all'alba/tramonto.
# Convenzione standard: il lembo superiore tocca l'orizzonte, e il centro
# si trova quindi un semidiametro solare (~16') piu' in basso.
_SUNRISE_ELEVATION = -0.267


def sun_times(lat, lon, day, tz, step_minutes=2):
    """Alba, tramonto e mezzogiorno solare per un dato giorno locale.

    Ritorna un dict con datetime tz-aware, oppure None per i campi non
    definiti (sole sempre sopra/sotto l'orizzonte).
    """
    start = _dt.datetime.combine(day, _dt.time(0, 0), tzinfo=tz)
    steps = int(24 * 60 / step_minutes) + 1
    times = [start + _dt.timedelta(minutes=step_minutes * i) for i in range(steps)]
    elev, _ = solar_position(lat, lon, times)

    def _cross(i, rising):
        """Interpola linearmente l'istante di attraversamento della soglia."""
        e0, e1 = elev[i - 1] - _SUNRISE_ELEVATION, elev[i] - _SUNRISE_ELEVATION
        frac = 0.0 if e1 == e0 else e0 / (e0 - e1)
        return times[i - 1] + _dt.timedelta(minutes=step_minutes * float(frac))

    sunrise = sunset = None
    for i in range(1, len(times)):
        prev, cur = elev[i - 1], elev[i]
        if prev < _SUNRISE_ELEVATION <= cur and sunrise is None:
            sunrise = _cross(i, True)
        if prev >= _SUNRISE_ELEVATION > cur and sunset is None:
            sunset = _cross(i, False)

    # Il mezzogiorno solare cade sul massimo di una curva molto piatta:
    # argmax sulla griglia sbaglia di diversi minuti. Raffiniamo con il
    # vertice della parabola passante per i tre campioni centrali.
    noon_idx = int(np.argmax(elev))
    noon = times[noon_idx]
    max_elev = float(elev[noon_idx])
    if 0 < noon_idx < len(times) - 1:
        y0, y1, y2 = float(elev[noon_idx - 1]), max_elev, float(elev[noon_idx + 1])
        denom = y0 - 2.0 * y1 + y2
        if denom != 0.0:
            offset = 0.5 * (y0 - y2) / denom  # in unita' di passo, in [-0.5, 0.5]
            noon = noon + _dt.timedelta(minutes=step_minutes * offset)
            max_elev = y1 - 0.25 * (y0 - y2) * offset

    return {
        "sunrise": sunrise,
        "sunset": sunset,
        "solar_noon": noon,
        "max_elevation": max_elev,
    }
