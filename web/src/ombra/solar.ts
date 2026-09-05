/**
 * Posizione solare e carico radiativo.
 *
 * Traduzione dell'algoritmo NOAA Solar Calculator che stava in `solar.py`,
 * riga per riga: sono formule scalari, non c'e' nulla di geografico da
 * riscrivere e ogni scostamento sarebbe un errore di trascrizione, non una
 * scelta diversa. La verifica sta in `solar.test.ts`, che confronta i valori
 * con quelli calcolati dal Python originale.
 *
 * Convenzioni, identiche a prima:
 *   - elevazione: gradi sopra l'orizzonte, negativa di notte
 *   - azimut: gradi da Nord in senso orario (E=90, S=180, O=270)
 *   - gli istanti sono `Date`, cioe' sempre assoluti: il fuso serve solo a
 *     decidere quale istante corrisponde a un'ora di orologio.
 */

/** Costante solare al di fuori dell'atmosfera (W/m2) */
export const SOLAR_CONSTANT = 1361.0

const RAD = Math.PI / 180.0
const DEG = 180.0 / Math.PI

/** Resto sempre positivo, come `%` di Python e `np.mod`. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/** Secoli giuliani dall'epoca J2000.0 per un istante UTC. */
function julianCentury(d: Date): number {
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth() + 1
  if (m <= 2) {
    y -= 1
    m += 12
  }
  const a = Math.floor(y / 100)
  const b = 2 - a + Math.floor(a / 4)
  const dayFrac =
    d.getUTCDate() +
    (d.getUTCHours() +
      (d.getUTCMinutes() + (d.getUTCSeconds() + d.getUTCMilliseconds() / 1000) / 60) / 60) /
      24
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    dayFrac +
    b -
    1524.5
  return (jd - 2451545.0) / 36525.0
}

export interface PosizioneSole {
  /** gradi sopra l'orizzonte */
  elevation: number
  /** gradi da nord, orario */
  azimuth: number
}

/** Elevazione e azimut solare secondo NOAA. */
export function solarPosition(lat: number, lon: number, when: Date): PosizioneSole {
  const jc = julianCentury(when)
  const minutes =
    when.getUTCHours() * 60 +
    when.getUTCMinutes() +
    (when.getUTCSeconds() + when.getUTCMilliseconds() / 1000) / 60

  // Longitudine media e anomalia media del Sole
  const geomMeanLong = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360.0)
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)

  const anomRad = geomMeanAnom * RAD
  const sunEqCtr =
    Math.sin(anomRad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * anomRad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * anomRad) * 0.000289
  const sunTrueLong = geomMeanLong + sunEqCtr

  // Longitudine apparente (corretta per nutazione e aberrazione)
  const omega = (125.04 - 1934.136 * jc) * RAD
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(omega)

  const meanObliq =
    23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega)

  const declin = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(sunAppLong * RAD)) * DEG

  // Equazione del tempo (minuti)
  const vary = Math.tan((obliqCorr / 2.0) * RAD) ** 2
  const l0 = geomMeanLong * RAD
  const eqTime =
    4.0 *
    DEG *
    (vary * Math.sin(2 * l0) -
      2 * eccent * Math.sin(anomRad) +
      4 * eccent * vary * Math.sin(anomRad) * Math.cos(2 * l0) -
      0.5 * vary * vary * Math.sin(4 * l0) -
      1.25 * eccent * eccent * Math.sin(2 * anomRad))

  // Tempo solare vero: si parte da UTC, quindi la correzione di longitudine
  // e' semplicemente 4 minuti per grado a est di Greenwich.
  const trueSolarTime = mod(minutes + eqTime + 4.0 * lon, 1440.0)
  const hourAngle =
    trueSolarTime / 4.0 < 0.0 ? trueSolarTime / 4.0 + 180.0 : trueSolarTime / 4.0 - 180.0

  const latRad = lat * RAD
  const declRad = declin * RAD
  const haRad = hourAngle * RAD

  const cosZenith = Math.max(
    -1.0,
    Math.min(
      1.0,
      Math.sin(latRad) * Math.sin(declRad) +
        Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad),
    ),
  )
  const zenith = Math.acos(cosZenith) * DEG
  let elevation = 90.0 - zenith

  // Rifrazione atmosferica (approssimazione NOAA)
  const elevRad = Math.max(-5.0, Math.min(90.0, elevation)) * RAD
  const tanE = Math.tan(elevRad)
  let refraction: number
  if (elevation > 85.0) {
    refraction = 0.0
  } else if (elevation > 5.0) {
    refraction = 58.1 / tanE - 0.07 / tanE ** 3 + 0.000086 / tanE ** 5
  } else if (elevation > -0.575) {
    refraction =
      1735.0 +
      elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
  } else {
    refraction = tanE === 0 ? 0.0 : -20.772 / tanE
  }
  if (!Number.isFinite(refraction)) refraction = 0.0
  elevation += refraction / 3600.0

  // Azimut
  let sinZen = Math.sin(zenith * RAD)
  if (Math.abs(sinZen) < 1e-9) sinZen = 1e-9
  const cosAz = Math.max(
    -1.0,
    Math.min(
      1.0,
      (Math.sin(latRad) * Math.cos(zenith * RAD) - Math.sin(declRad)) /
        (Math.cos(latRad) * sinZen),
    ),
  )
  const azCore = Math.acos(cosAz) * DEG
  const azimuth = hourAngle > 0.0 ? mod(azCore + 180.0, 360.0) : mod(540.0 - azCore, 360.0)

  return { elevation, azimuth }
}

/**
 * Irradianza globale su piano orizzontale con cielo sereno (W/m2).
 *
 * Modello di Meinel: attenua la costante solare in funzione della massa
 * d'aria attraversata. Serve a pesare quanto "costa" stare al sole a una
 * certa ora: il sole radente di mattina scalda molto meno di quello di
 * mezzogiorno.
 */
export function clearSkyIrradiance(elevationDeg: number, elevationM = 0.0): number {
  const elev = Math.max(0.0, Math.min(90.0, elevationDeg))
  const sinH = Math.sin(elev * RAD)
  // Massa d'aria relativa (Kasten-Young), stabile anche a bassa elevazione
  let am = 1.0 / (sinH + 0.50572 * Math.pow(elev + 6.07995, -1.6364))
  if (!Number.isFinite(am)) am = 40.0
  // Correzione per quota (pressione ridotta)
  am *= Math.exp(-elevationM / 8434.0)

  const directNormal = SOLAR_CONSTANT * Math.pow(0.7, Math.pow(am, 0.678))
  const beamHorizontal = directNormal * sinH
  const diffuse = 0.1 * beamHorizontal + 20.0 * sinH
  return elevationDeg > 0.0 ? beamHorizontal + diffuse : 0.0
}

/**
 * Carico radiativo normalizzato in [0, 1].
 *
 * 1.0 corrisponde grosso modo al sole di mezzogiorno d'estate. Il router lo
 * usa per modulare la penalita' di esposizione: camminare al sole alle 7 del
 * mattino pesa molto meno che alle 14.
 */
export function solarLoad(elevationDeg: number): number {
  return Math.max(0.0, Math.min(1.0, clearSkyIrradiance(elevationDeg) / 950.0))
}

// Elevazione apparente del centro del disco solare all'alba/tramonto.
// Convenzione standard: il lembo superiore tocca l'orizzonte, e il centro si
// trova quindi un semidiametro solare (~16') piu' in basso.
const SUNRISE_ELEVATION = -0.267

export interface OrariSole {
  sunrise: Date | null
  sunset: Date | null
  solarNoon: Date
  maxElevation: number
}

/**
 * Alba, tramonto e mezzogiorno solare per le 24 ore che iniziano a `dayStart`.
 *
 * `dayStart` e' l'istante assoluto della mezzanotte locale dell'area, che il
 * chiamante ricava dal fuso con `fusi.ts`: qui dentro non c'e' piu' nessuna
 * nozione di ora locale.
 */
export function sunTimes(
  lat: number,
  lon: number,
  dayStart: Date,
  stepMinutes = 2,
): OrariSole {
  const steps = Math.floor((24 * 60) / stepMinutes) + 1
  const times: Date[] = []
  const elev: number[] = []
  for (let i = 0; i < steps; i++) {
    const t = new Date(dayStart.getTime() + i * stepMinutes * 60_000)
    times.push(t)
    elev.push(solarPosition(lat, lon, t).elevation)
  }

  /** Interpola linearmente l'istante di attraversamento della soglia. */
  const cross = (i: number): Date => {
    const e0 = elev[i - 1] - SUNRISE_ELEVATION
    const e1 = elev[i] - SUNRISE_ELEVATION
    const frac = e1 === e0 ? 0.0 : e0 / (e0 - e1)
    return new Date(times[i - 1].getTime() + frac * stepMinutes * 60_000)
  }

  let sunrise: Date | null = null
  let sunset: Date | null = null
  for (let i = 1; i < steps; i++) {
    const prev = elev[i - 1]
    const cur = elev[i]
    if (prev < SUNRISE_ELEVATION && cur >= SUNRISE_ELEVATION && sunrise === null) {
      sunrise = cross(i)
    }
    if (prev >= SUNRISE_ELEVATION && cur < SUNRISE_ELEVATION && sunset === null) {
      sunset = cross(i)
    }
  }

  // Il mezzogiorno solare cade sul massimo di una curva molto piatta: il
  // campione piu' alto sbaglia di diversi minuti. Si raffina con il vertice
  // della parabola passante per i tre campioni centrali.
  let noonIdx = 0
  for (let i = 1; i < steps; i++) if (elev[i] > elev[noonIdx]) noonIdx = i
  let noon = times[noonIdx]
  let maxElevation = elev[noonIdx]
  if (noonIdx > 0 && noonIdx < steps - 1) {
    const y0 = elev[noonIdx - 1]
    const y1 = maxElevation
    const y2 = elev[noonIdx + 1]
    const denom = y0 - 2.0 * y1 + y2
    if (denom !== 0.0) {
      const offset = (0.5 * (y0 - y2)) / denom // in unita' di passo, in [-0.5, 0.5]
      noon = new Date(noon.getTime() + offset * stepMinutes * 60_000)
      maxElevation = y1 - 0.25 * (y0 - y2) * offset
    }
  }

  return { sunrise, sunset, solarNoon: noon, maxElevation }
}
