/**
 * Quanto costa calcolare un istante di ombre nel browser.
 *
 *     npm run prestazioni
 *
 * Non e' un test: e' la misura da confrontare con quella del backend Python
 * (10-100 ms per istante su ritagli fra 500x500 e 1500x1500 px, portatile).
 * Se il porting fosse molto piu' lento di cosi', l'idea di far calcolare le
 * ombre al telefono non starebbe in piedi e si dovrebbe passare a WebGL.
 *
 * Il numero da guardare e' il tempo per istante moltiplicato per il numero di
 * istanti di un tragitto: sono quelli i secondi che l'utente aspetta.
 */

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { canopyTransmissivity, sunFactor, sunFactorPoints } from '../src/ombra/shadow.ts'
import {
  componiSuperficie,
  decodificaTassello,
  tasselliDi,
  type TasselloDecodificato,
} from '../src/ombra/tiles.ts'

const DATI = fileURLToPath(new URL('../public/dati/ascoli-piceno/', import.meta.url))
const manifest = JSON.parse(readFileSync(`${DATI}manifest.json`, 'utf8'))
const griglia = manifest.surface

// Gli stessi tre momenti su cui erano stati misurati i tempi del Python:
// mattina e sera con il sole radente, mezzogiorno con il sole alto.
const ISTANTI: [string, number, number][] = [
  ['mattina  elev 16.9', 100.0, 16.9],
  ['mezzodi  elev 57.8', 180.0, 57.8],
  ['sera     elev  8.7', 265.0, 8.7],
]

const LATI = [250, 500, 750, 1000, 1500]

function cronometra(f: () => void, ripetizioni: number): number {
  f() // un giro a vuoto: la prima volta il codice non e' ancora compilato
  const t0 = performance.now()
  for (let i = 0; i < ripetizioni; i++) f()
  return (performance.now() - t0) / ripetizioni
}

const cache = new Map<string, TasselloDecodificato>()

console.log(`ritaglio        ${ISTANTI.map((i) => i[0].slice(0, 8).padStart(9)).join('')}`)
for (const lato of LATI) {
  // Centrato sul centro storico, come i ritagli veri di un tragitto
  const c0 = Math.max(0, Math.min(griglia.width - lato, 1170 - lato / 2))
  const r0 = Math.max(0, Math.min(griglia.height - lato, 1170 - lato / 2))
  const riquadro = { col0: c0, row0: r0, col1: c0 + lato, row1: r0 + lato }

  const decodificati = new Map<string, TasselloDecodificato>()
  let scaricati = 0
  for (const t of tasselliDi(griglia, riquadro)) {
    if (!cache.has(t.url)) {
      cache.set(t.url, decodificaTassello(gunzipSync(readFileSync(DATI + t.url))))
      scaricati += t.bytes
    }
    decodificati.set(t.url, cache.get(t.url) as TasselloDecodificato)
  }

  const s = componiSuperficie(griglia, riquadro, decodificati, canopyTransmissivity)

  // Quanti punti chiede davvero il grafo: circa un campione ogni 8 metri di
  // strada, e in una citta' come Ascoli sono ~4 km di rete per km quadrato.
  const nPunti = Math.round(((lato * s.pixelSize) / 1000) ** 2 * 500)
  const xs = new Float64Array(nPunti)
  const ys = new Float64Array(nPunti)
  for (let i = 0; i < nPunti; i++) {
    xs[i] = s.transform.c + Math.random() * lato * s.pixelSize
    ys[i] = s.transform.f - Math.random() * lato * s.pixelSize
  }

  const raster = ISTANTI.map(([, azim, elev]) =>
    cronometra(
      () => sunFactor(s.dsm, s.width, s.height, s.pixelSize, azim, elev, s.canopy, s.tau, 600),
      3,
    ),
  )
  const punti = ISTANTI.map(([, azim, elev]) =>
    cronometra(
      () =>
        sunFactorPoints(
          s.dsm, s.width, s.height, s.pixelSize, s.transform,
          azim, elev, xs, ys, s.canopy, s.tau, 600,
        ),
      3,
    ),
  )

  const riga = (etichetta: string, t: number[]) =>
    console.log(
      `${etichetta.padEnd(10)} ${String(decodificati.size).padStart(2)} tass. ` +
        t.map((v) => `${v.toFixed(1).padStart(7)} ms`).join(' '),
    )
  riga(`${lato}x${lato}`, raster)
  riga(`  ${nPunti} punti`, punti)
  if (scaricati) console.log(`           (+${(scaricati / 1024).toFixed(0)} kB scaricati)`)
}
