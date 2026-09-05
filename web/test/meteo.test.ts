/**
 * Il widget meteo non deve mai far esplodere il resto della UI.
 *
 * `meteoPer` e' l'unico punto dove questo modulo tocca la rete (Open-Meteo,
 * come `vento.ts` ma per la sola visualizzazione, e per l'istante scelto
 * invece che per "adesso"): deve garantire di non propagare mai un rifiuto,
 * qualunque cosa succeda alla `fetch`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { descriviCodiceMeteo, meteoPer } from '../src/ombra/meteo.ts'

// Europe/Rome e' UTC+1 a gennaio (nessun'ora legale): le 08:00 UTC sono le
// 09:00 locali, l'ora che i fixture qui sotto si aspettano di trovare.
const QUANDO = new Date('2026-01-15T08:00:00Z')
const FUSO = 'Europe/Rome'

test('meteoPer non lancia mai: rete irraggiungibile risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('rete assente'))) as typeof fetch
  try {
    const r = await meteoPer(13.5749, 42.8536, QUANDO, FUSO)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('meteoPer non lancia mai: risposta non ok risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response('errore', { status: 503 }))) as typeof fetch
  try {
    const r = await meteoPer(13.5749, 42.8536, QUANDO, FUSO)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('meteoPer non lancia mai: serie oraria assente risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ hourly: {} }), { status: 200 }))) as typeof fetch
  try {
    const r = await meteoPer(13.5749, 42.8536, QUANDO, FUSO)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('meteoPer non lancia mai: ora richiesta assente dalla serie risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          hourly: {
            time: ['2026-01-15T00:00', '2026-01-15T01:00'], // manca le 09:00
            temperature_2m: [5, 5],
            apparent_temperature: [3, 3],
            relative_humidity_2m: [80, 80],
            precipitation: [0, 0],
            weather_code: [3, 3],
            wind_speed_10m: [10, 10],
          },
        }),
        { status: 200 },
      ),
    )) as typeof fetch
  try {
    const r = await meteoPer(13.5749, 42.8536, QUANDO, FUSO)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('meteoPer legge il valore dell ora richiesta dalla serie oraria', async () => {
  const fetchOriginale = globalThis.fetch
  let urlChiamato = ''
  globalThis.fetch = ((url: string) => {
    urlChiamato = url
    return Promise.resolve(
      new Response(
        JSON.stringify({
          hourly: {
            time: ['2026-01-15T08:00', '2026-01-15T09:00', '2026-01-15T10:00'],
            temperature_2m: [4.1, 5.3, 6.0],
            apparent_temperature: [2.0, 3.1, 4.0],
            relative_humidity_2m: [82, 80, 78],
            precipitation: [0, 0.2, 0],
            weather_code: [3, 61, 3],
            wind_speed_10m: [8, 10, 9],
          },
        }),
        { status: 200 },
      ),
    )
  }) as typeof fetch
  try {
    const r = await meteoPer(13.5749, 42.8536, QUANDO, FUSO)
    assert.ok(r)
    assert.equal(r.temperatura, 5.3)
    assert.equal(r.descrizione, 'pioggia debole')
    // Un giorno di gennaio nel passato: deve usare l'API storica, non quella
    // di previsione -- e' il comportamento che l'utente si aspetta (il
    // meteo dell'ora scelta, non quello di adesso).
    assert.ok(urlChiamato.startsWith('https://archive-api.open-meteo.com/'), urlChiamato)
    assert.ok(urlChiamato.includes('start_date=2026-01-15'), urlChiamato)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('meteoPer usa la API di previsione per una data vicina a oggi', async () => {
  const fetchOriginale = globalThis.fetch
  let urlChiamato = ''
  globalThis.fetch = ((url: string) => {
    urlChiamato = url
    return Promise.resolve(new Response(JSON.stringify({ hourly: {} }), { status: 200 }))
  }) as typeof fetch
  try {
    await meteoPer(13.5749, 42.8536, new Date(), FUSO)
    assert.ok(urlChiamato.startsWith('https://api.open-meteo.com/'), urlChiamato)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('descriviCodiceMeteo: codice non elencato non lancia, cade sul default prudente', () => {
  assert.equal(descriviCodiceMeteo(0), 'sereno')
  assert.equal(descriviCodiceMeteo(9999), 'condizioni non note')
})
