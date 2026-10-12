/**
 * I tasselli devono restituire la superficie da cui sono stati ricavati, e
 * soprattutto le stesse ombre.
 *
 * La quantizzazione dell'esportazione (quota al centimetro, chioma a 25 cm)
 * e' invisibile su una quota, ma il calcolo delle ombre e' fatto di confronti
 * fra quote: un centimetro puo' in linea di principio far cambiare lato a un
 * pixel di bordo. Questo test misura quanto succede davvero, confrontando le
 * ombre calcolate sul mosaico con quelle calcolate dal Python sul GeoTIFF.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { canopyTransmissivity, sunFactor } from '../src/meriggio/shadow.ts'
import {
  componiSuperficie,
  decodificaTassello,
  tasselliDi,
  type GrigliaSuperficie,
  type TasselloDecodificato,
} from '../src/meriggio/tiles.ts'
import { carica, daBase64 } from './riferimenti.ts'

const DATI = fileURLToPath(new URL('../public/dati/ascoli-piceno/', import.meta.url))

// La stessa finestra da cui `riferimenti.py` ha ritagliato la scena reale.
const FINESTRA = { col0: 1000, row0: 1000, col1: 1192, row1: 1192 }

interface Caso {
  nome: string
  width: number
  height: number
  pixel_size: number
  max_distance: number
  dsm: string
  canopy: string | null
  tcd: string | null
  attesi: { azimuth: number; elevation: number; factor: string }[]
}

const disponibile = existsSync(`${DATI}manifest.json`)

test('il mosaico dei tasselli ricostruisce la superficie esportata', { skip: !disponibile && 'area non esportata' }, () => {
  const manifest = JSON.parse(readFileSync(`${DATI}manifest.json`, 'utf8'))
  const griglia: GrigliaSuperficie = manifest.surface

  const decodificati = new Map<string, TasselloDecodificato>()
  for (const t of tasselliDi(griglia, FINESTRA)) {
    decodificati.set(t.url, decodificaTassello(gunzipSync(readFileSync(DATI + t.url))))
  }
  assert.ok(decodificati.size >= 1)

  const s = componiSuperficie(griglia, FINESTRA, decodificati, canopyTransmissivity)
  const caso = carica<{ casi: Caso[] }>('shadow').casi.find((c) => c.nome === 'ascoli-centro')
  assert.ok(caso, 'manca la scena reale di riferimento')
  assert.equal(s.width, caso.width)
  assert.equal(s.height, caso.height)

  const dsm = daBase64(caso.dsm, 'f4')
  const canopy = caso.canopy === null ? null : daBase64(caso.canopy, 'f4')
  let peggioreQuota = 0
  let peggioreChioma = 0
  for (let i = 0; i < dsm.length; i++) {
    peggioreQuota = Math.max(peggioreQuota, Math.abs(s.dsm[i] - dsm[i]))
    if (canopy && s.canopy) {
      peggioreChioma = Math.max(peggioreChioma, Math.abs(s.canopy[i] - canopy[i]))
    }
  }
  // Meta' passo di quantizzazione (0,5 cm sulla quota, 12,5 cm sulla chioma),
  // piu' il pulviscolo della virgola mobile a 32 bit su quote di centinaia di
  // metri, che vale qualche centesimo di millimetro.
  assert.ok(peggioreQuota <= 0.0051, `quota: ${peggioreQuota * 100} cm di scarto`)
  assert.ok(peggioreChioma <= 0.1251, `chioma: ${peggioreChioma * 100} cm di scarto`)

  // ---- e adesso quello che conta davvero: le ombre ----
  let diversiTotali = 0
  let pixelTotali = 0
  for (const atteso of caso.attesi) {
    if (atteso.elevation <= 0) continue
    const avuto = sunFactor(
      s.dsm, s.width, s.height, s.pixelSize,
      atteso.azimuth, atteso.elevation,
      s.canopy, s.tau, caso.max_distance,
    )
    const voluto = daBase64(atteso.factor, 'f4')
    let diversi = 0
    for (let i = 0; i < voluto.length; i++) {
      if (Math.abs(avuto[i] - voluto[i]) > 1e-6) diversi++
    }
    diversiTotali += diversi
    pixelTotali += voluto.length
    // Misurato sul centro di Ascoli: nessun pixel di scarto con il sole alto,
    // un pixel su duemila nel caso peggiore (sole a 3-8 gradi, quando le ombre
    // sono lunghe e un centimetro di quota sposta il loro bordo di qualche
    // decimetro). Sono una decina di pixel su trentaseimila.
    const quota = (100 * diversi) / voluto.length
    assert.ok(
      quota < 0.1,
      `az ${atteso.azimuth} elev ${atteso.elevation}: ${quota.toFixed(3)}% di pixel diversi`,
    )
  }
  const quota = (100 * diversiTotali) / pixelTotali
  assert.ok(quota < 0.03, `nel complesso ${quota.toFixed(4)}% di pixel diversi`)
})

/**
 * Un'area esportata prima del piano del costruito deve restare leggibile.
 *
 * I dati di un'area sono file statici messi online una volta: puo' benissimo
 * capitare che l'applicazione venga aggiornata e la cartella dei dati no. In
 * quel caso le ombre devono continuare a funzionare come funzionavano, senza
 * terreno separato e quindi con gli edifici che tornano a passare dal raster.
 */
test('i tasselli di versione 1 si leggono ancora', () => {
  const w = 4
  const h = 3
  const intestazione = new DataView(new ArrayBuffer(24))
  const testo = new TextEncoder().encode('OMBT')
  for (let i = 0; i < 4; i++) intestazione.setUint8(i, testo[i])
  intestazione.setUint16(4, 1, true) // versione
  intestazione.setUint16(6, 0, true) // nessun piano oltre la quota
  intestazione.setUint16(8, w, true)
  intestazione.setUint16(10, h, true)
  intestazione.setFloat32(12, 100, true) // quota di base
  intestazione.setFloat32(16, 0.01, true) // passo
  intestazione.setFloat32(20, 0.25, true) // passo della chioma

  // Quote crescenti di un centimetro, gia' differenziate per riga come le
  // scrive l'esportazione.
  const quote = new Uint16Array(w * h)
  for (let r = 0; r < h; r++) {
    quote[r * w] = r * 100
    for (let c = 1; c < w; c++) quote[r * w + c] = 1
  }

  const bytes = new Uint8Array(24 + quote.byteLength)
  bytes.set(new Uint8Array(intestazione.buffer), 0)
  bytes.set(new Uint8Array(quote.buffer), 24)

  const tassello = decodificaTassello(bytes)
  assert.equal(tassello.width, w)
  assert.equal(tassello.height, h)
  assert.equal(tassello.built, null, 'la versione 1 non porta il costruito')
  assert.ok(Math.abs(tassello.dsm[0] - 100) < 1e-4, `quota ${tassello.dsm[0]}`)
  assert.ok(Math.abs(tassello.dsm[3] - 100.03) < 1e-4, `quota ${tassello.dsm[3]}`)
  assert.ok(Math.abs(tassello.dsm[2 * w] - 102) < 1e-4, `quota ${tassello.dsm[2 * w]}`)
})
