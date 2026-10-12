/**
 * Il routing non deve mai bloccarsi per un'API esterna irraggiungibile.
 *
 * `ventoCorrente` e' l'unico punto dove questo progetto tocca una rete che
 * non e' la propria (Open-Meteo, non i dati statici dell'area): deve quindi
 * essere quello con la garanzia piu' esplicita di non propagare mai un
 * rifiuto, qualunque cosa succeda alla `fetch`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ventoCorrente } from '../src/meriggio/vento.ts'
import { fattoreVento } from '../src/meriggio/traffico.ts'

test('ventoCorrente non lancia mai: rete irraggiungibile risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('rete assente'))) as typeof fetch
  try {
    const r = await ventoCorrente(13.5749, 42.8536)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('ventoCorrente non lancia mai: risposta non ok risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response('errore', { status: 503 }))) as typeof fetch
  try {
    const r = await ventoCorrente(13.5749, 42.8536)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('ventoCorrente non lancia mai: JSON malformato risolve a undefined', async () => {
  const fetchOriginale = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ current: { temperature: 20 } }), { status: 200 }),
    )) as typeof fetch
  try {
    const r = await ventoCorrente(13.5749, 42.8536)
    assert.equal(r, undefined)
  } finally {
    globalThis.fetch = fetchOriginale
  }
})

test('fattoreVento(tipico, undefined) === 1.0 esattamente', () => {
  const tipico = { speed_ms: 1.57, direction_deg: 240.8 }
  assert.equal(fattoreVento(tipico, undefined), 1.0)
  // Indipendentemente da quanto sia insolito il vento tipico: undefined
  // vuol dire "nessuna lettura live", mai un'altra ipotesi.
  assert.equal(fattoreVento({ speed_ms: 0, direction_deg: null }, undefined), 1.0)
})

test('fattoreVento scala con il rapporto dei venti, mai sotto zero', () => {
  const tipico = { speed_ms: 1.57, direction_deg: 240.8 }
  // Vento live piu' forte del tipico -> piu' dispersione -> fattore < 1.
  const conVentoForte = fattoreVento(tipico, { velocita: 8, direzione: 90 })
  assert.ok(conVentoForte < 1.0, `atteso < 1.0, avuto ${conVentoForte}`)
  assert.ok(conVentoForte > 0, `atteso > 0, avuto ${conVentoForte}`)

  // Vento live piu' calmo del tipico -> meno dispersione -> fattore > 1.
  const conVentoCalmo = fattoreVento(tipico, { velocita: 0.1, direzione: 90 })
  assert.ok(conVentoCalmo > 1.0, `atteso > 1.0, avuto ${conVentoCalmo}`)
})
