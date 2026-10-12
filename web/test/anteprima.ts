/**
 * Come si vedono le ombre, senza aprire il browser.
 *
 *     npm run anteprima -- [ora] [larghezza in metri] [file.png]
 *     npm run anteprima -- 19:00 220 /tmp/sera.png
 *
 * Non e' un test: e' l'occhio. Le ombre si possono misurare quanto si vuole --
 * e i test lo fanno -- ma la domanda "e' venuta bene?" si risponde solo
 * guardandola, e guardarla nel browser vuol dire un giro di dev server, una
 * finestra e uno zoom messo a mano ogni volta che si cambia una costante.
 *
 * L'immagine viene ingrandita a 900 px con la stessa interpolazione bilineare
 * che userebbe la scheda grafica, cosi' quello che si vede qui e' quello che si
 * vedrebbe sulla mappa, sfocature comprese, e non una versione piu' bella al
 * naturale.
 */

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

import type { Ombre } from '../src/meriggio/overlay.ts'
import { apriLocale } from './area.ts'

const LATO = 900
const FONDO: [number, number, number] = [242, 242, 242]
const OMBRA: [number, number, number] = [28, 42, 84]

/** PNG minimo: RGB a 8 bit, nessun filtro, una sola immagine. */
function png(larghezza: number, altezza: number, rgb: Uint8Array): Buffer {
  const tabella = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tabella[n] = c
  }
  const crc = (b: Buffer) => {
    let c = ~0
    for (const v of b) c = tabella[(c ^ v) & 0xff] ^ (c >>> 8)
    return ~c >>> 0
  }
  const blocco = (tipo: string, dati: Buffer) => {
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dati])
    const lunghezza = Buffer.alloc(4)
    lunghezza.writeUInt32BE(dati.length)
    const somma = Buffer.alloc(4)
    somma.writeUInt32BE(crc(corpo))
    return Buffer.concat([lunghezza, corpo, somma])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(larghezza, 0)
  ihdr.writeUInt32BE(altezza, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const righe = Buffer.alloc(altezza * (larghezza * 3 + 1))
  for (let r = 0; r < altezza; r++) {
    Buffer.from(rgb.buffer, r * larghezza * 3, larghezza * 3).copy(
      righe,
      r * (larghezza * 3 + 1) + 1,
    )
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    blocco('IHDR', ihdr),
    blocco('IDAT', deflateSync(righe)),
    blocco('IEND', Buffer.alloc(0)),
  ])
}

/** L'ingrandimento che fa la mappa: bilineare, sopra un fondo chiaro. */
function suSchermo(o: Ombre, lato: number): Uint8Array {
  const out = new Uint8Array(lato * lato * 3)
  const alfa = (r: number, c: number) => o.pixel[(r * o.larghezza + c) * 4 + 3] / 255

  for (let r = 0; r < lato; r++) {
    const sy = ((r + 0.5) / lato) * o.altezza - 0.5
    const r0 = Math.max(0, Math.min(o.altezza - 1, Math.floor(sy)))
    const r1 = Math.min(o.altezza - 1, r0 + 1)
    const fy = Math.max(0, Math.min(1, sy - r0))
    for (let c = 0; c < lato; c++) {
      const sx = ((c + 0.5) / lato) * o.larghezza - 0.5
      const c0 = Math.max(0, Math.min(o.larghezza - 1, Math.floor(sx)))
      const c1 = Math.min(o.larghezza - 1, c0 + 1)
      const fx = Math.max(0, Math.min(1, sx - c0))
      const sopra = alfa(r0, c0) + fx * (alfa(r0, c1) - alfa(r0, c0))
      const sotto = alfa(r1, c0) + fx * (alfa(r1, c1) - alfa(r1, c0))
      const a = sopra + fy * (sotto - sopra)
      const i = (r * lato + c) * 3
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(FONDO[k] * (1 - a) + OMBRA[k] * a)
    }
  }
  return out
}

const ora = process.argv[2] ?? '19:00'
const metri = Number(process.argv[3] ?? 220)
const file = process.argv[4] ?? 'anteprima.png'

const area = await apriLocale('ascoli-piceno')
const [lon0, lat0, lon1, lat1] = area.manifesto.bounds
const cx = (lon0 + lon1) / 2
const cy = (lat0 + lat1) / 2
// Da metri a gradi al centro dell'area: basta per inquadrare, non e' geodesia.
const mezzoLat = metri / 2 / 111320
const mezzoLon = mezzoLat / Math.cos(cy * (Math.PI / 180))
const quando = new Date(`${area.orariSole(new Date()).giorno}T${ora}:00`)

const inizio = performance.now()
const ombre = await area.ombre({
  bounds: [cx - mezzoLon, cy - mezzoLat, cx + mezzoLon, cy + mezzoLat],
  quando,
  latoMax: LATO,
})
if (!ombre) {
  console.log(`${ora}: nessuna ombra da disegnare (sole sotto l'orizzonte?)`)
} else {
  const { elevation, azimuth } = area.sole(quando)
  writeFileSync(file, png(LATO, LATO, suSchermo(ombre, LATO)))
  console.log(
    `${ora} — sole a ${elevation.toFixed(1)} gradi da ${azimuth.toFixed(0)}, ` +
      `${metri} m di larghezza, immagine ${ombre.larghezza}x${ombre.altezza} ` +
      `in ${(performance.now() - inizio).toFixed(0)} ms -> ${file}`,
  )
}
