/**
 * Il consenso ai servizi esterni (`src/lib/consenso.ts`): dura sei mesi, il
 * rifiuto della mappa trascina con se' anche la ricerca, e senza risposta non
 * si considera concesso niente.
 *
 * Il modulo legge `localStorage` quando viene caricato, quindi ogni caso lo
 * importa da capo (il `?caso` in fondo evita la cache dei moduli).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const GIORNO = 24 * 60 * 60 * 1000

function finto(contenuto?: unknown) {
  const archivio = new Map<string, string>()
  if (contenuto !== undefined) archivio.set('meriggio.consenso', JSON.stringify(contenuto))
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => archivio.get(k) ?? null,
      setItem: (k: string, v: string) => void archivio.set(k, v),
      removeItem: (k: string) => void archivio.delete(k),
    },
  }
  return archivio
}

let n = 0
const carica = () => import(`../src/lib/consenso.ts?caso=${n++}`) as Promise<typeof import('../src/lib/consenso.ts')>

test('senza risposta nessun servizio e` concesso', async () => {
  finto()
  const c = await carica()
  assert.equal(c.consensoMappa(), false)
  assert.equal(c.consensoRicerca(), false)
})

test('una risposta recente si legge dal browser', async () => {
  finto({ mappa: 'si', ricerca: 'no', at: Date.now() - 10 * GIORNO })
  const c = await carica()
  assert.equal(c.consensoMappa(), true)
  assert.equal(c.consensoRicerca(), false)
})

test('dopo sei mesi la risposta scade e viene richiesta di nuovo', async () => {
  finto({ mappa: 'si', ricerca: 'si', at: Date.now() - 184 * GIORNO })
  const c = await carica()
  assert.equal(c.consensoMappa(), false)
  assert.equal(c.consensoRicerca(), false)
})

test('un valore illeggibile equivale a nessuna risposta', async () => {
  finto({ mappa: 'forse', ricerca: 'si', at: Date.now() })
  const c = await carica()
  assert.equal(c.consensoMappa(), false)
})

test('rifiutare la mappa spegne anche la ricerca', async () => {
  const archivio = finto()
  const c = await carica()
  c.scegli('no', 'si')
  assert.equal(c.consensoMappa(), false)
  assert.equal(c.consensoRicerca(), false)
  assert.equal(JSON.parse(archivio.get('meriggio.consenso')!).ricerca, 'no')
})

test('scegli registra la data e ripensaci la cancella', async () => {
  const archivio = finto()
  const c = await carica()
  c.scegli('si', 'si')
  assert.equal(c.consensoRicerca(), true)
  assert.ok(Date.now() - JSON.parse(archivio.get('meriggio.consenso')!).at < 5000)
  c.ripensaci()
  assert.equal(archivio.has('meriggio.consenso'), false)
  assert.equal(c.consensoMappa(), false)
})
