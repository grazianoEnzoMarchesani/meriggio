/**
 * Conversione fra gradi e coordinate metriche UTM.
 *
 * Nel backend la faceva `pyproj`, che nel browser non c'e'. Non serve pero'
 * una libreria di proiezioni generale: l'area lavora sempre in un solo fuso
 * UTM WGS84, scelto una volta per tutte quando l'area viene preparata e
 * scritto nel manifesto. Restano le formule di Snyder, una trentina di righe,
 * esatte al millimetro dentro il fuso.
 *
 * `proiezione.test.ts` le confronta con quelle di pyproj sull'area di Ascoli.
 */

const A = 6378137.0 // semiasse maggiore WGS84
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)
const K0 = 0.9996
const FALSE_EASTING = 500000.0
const FALSE_NORTHING = 10000000.0 // solo nell'emisfero sud

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export interface Fuso {
  /** numero del fuso, 1-60 */
  zone: number
  /** vero se a nord dell'equatore */
  nord: boolean
}

/** Scompone un codice EPSG UTM WGS84 (326xx a nord, 327xx a sud). */
export function fusoDaEpsg(epsg: number): Fuso {
  const nord = epsg >= 32600 && epsg < 32700
  const zone = epsg - (nord ? 32600 : 32700)
  if (zone < 1 || zone > 60) throw new Error(`EPSG ${epsg} non e' un fuso UTM WGS84`)
  return { zone, nord }
}

function meridianoCentrale(zone: number): number {
  return (zone - 1) * 6 - 180 + 3
}

/** Distanza dall'equatore lungo il meridiano, in metri. */
function arcoMeridiano(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  )
}

/** Da gradi a metri UTM. */
export function versoUtm(lon: number, lat: number, fuso: Fuso): [number, number] {
  const phi = lat * RAD

  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const tanPhi = Math.tan(phi)

  const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const T = tanPhi * tanPhi
  const C = EP2 * cosPhi * cosPhi
  // Differenza di longitudine riportata in (-180, 180]: senza questo, un'area
  // a cavallo dell'antimeridiano darebbe una serie divergente.
  let dLon = lon - meridianoCentrale(fuso.zone)
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  const Aa = dLon * RAD * cosPhi
  const M = arcoMeridiano(phi)

  const x =
    K0 *
      N *
      (Aa +
        ((1 - T + C) * Aa ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) +
    FALSE_EASTING
  let y =
    K0 *
    (M +
      N *
        tanPhi *
        ((Aa * Aa) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720))
  if (!fuso.nord) y += FALSE_NORTHING
  return [x, y]
}

/** Da metri UTM a gradi. */
export function versoGradi(x: number, y: number, fuso: Fuso): [number, number] {
  const xx = x - FALSE_EASTING
  const yy = fuso.nord ? y : y - FALSE_NORTHING

  const M = yy / K0
  const mu =
    M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))

  // Latitudine del piede della perpendicolare
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

  const sinPhi1 = Math.sin(phi1)
  const cosPhi1 = Math.cos(phi1)
  const tanPhi1 = Math.tan(phi1)

  const C1 = EP2 * cosPhi1 * cosPhi1
  const T1 = tanPhi1 * tanPhi1
  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1)
  const R1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5
  const D = xx / (N1 * K0)

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720)

  const lon =
    meridianoCentrale(fuso.zone) * RAD +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) /
      cosPhi1

  return [lon * DEG, lat * DEG]
}
