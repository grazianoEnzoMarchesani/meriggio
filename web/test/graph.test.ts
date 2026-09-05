/**
 * I grafi di versione 1 e 2 devono continuare a leggersi dopo l'introduzione
 * della versione 3 (traffico a fasce orarie): un utente di ritorno con un
 * `graph.bin.gz` v1/v2 gia' in Cache Storage (vedi `rete.ts`, la cui versione
 * di cache segue i tasselli, non il grafo) non deve rompersi. Rispecchia lo
 * stesso test di `tiles.test.ts` ("i tasselli di versione 1 si leggono
 * ancora"), costruendo a mano blob binari minimali con `DataView`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { leggiGrafo, VERSIONE_GRAFO } from '../src/ombra/graph.ts'

/** Concatena un array tipizzato al buffer, paddato a 4 byte come `export.py`. */
function aggiungi(parti: Uint8Array[], arr: ArrayBufferView): void {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  parti.push(bytes.slice())
  const resto = bytes.byteLength % 4
  if (resto) parti.push(new Uint8Array(4 - resto))
}

function concat(parti: Uint8Array[]): Uint8Array {
  const totale = parti.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(totale)
  let off = 0
  for (const p of parti) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

/** Costruisce un grafo minimale: 3 nodi, 2 tratti in linea, bidirezionale. */
function grafoMinimale(versione: 1 | 2 | 3): Uint8Array {
  const nNodi = 3
  const nTratti = 2
  const adjTarget = new Int32Array([1, 0, 2, 1])
  const nAdiacenze = adjTarget.length
  const counts = new Uint16Array([2, 2])
  const nCampioni = counts.reduce((a, b) => a + b, 0)

  const header = new DataView(new ArrayBuffer(40))
  const testo = new TextEncoder().encode('OMBG')
  for (let i = 0; i < 4; i++) header.setUint8(i, testo[i])
  header.setUint32(4, versione, true)
  header.setUint32(8, nNodi, true)
  header.setUint32(12, nTratti, true)
  header.setUint32(16, nAdiacenze, true)
  header.setUint32(20, nCampioni, true)
  header.setFloat64(24, 0.0, true) // origine x
  header.setFloat64(32, 0.0, true) // origine y

  const parti: Uint8Array[] = [new Uint8Array(header.buffer)]
  aggiungi(parti, new Int32Array([0, 10000, 20000])) // node_mm_x (10 m e 20 m in mm)
  aggiungi(parti, new Int32Array([0, 0, 0])) // node_mm_y
  aggiungi(parti, new Float32Array([13.0, 13.0001, 13.0002])) // node_lon
  aggiungi(parti, new Float32Array([42.0, 42.0, 42.0])) // node_lat
  aggiungi(parti, new Int32Array([0, 1])) // edge_u
  aggiungi(parti, new Int32Array([1, 2])) // edge_v
  aggiungi(parti, new Float32Array([10, 10])) // edge_len
  aggiungi(parti, new Float32Array([0, 0])) // edge_slope
  aggiungi(parti, new Float32Array([0, 0])) // edge_rough
  aggiungi(parti, new Int32Array([0, 1, 3, 4])) // adj_start
  aggiungi(parti, adjTarget) // adj_target
  aggiungi(parti, new Int32Array([0, 0, 1, 1])) // adj_edge
  aggiungi(parti, new Uint16Array([0, 0])) // edge_name
  aggiungi(parti, counts) // sample count
  aggiungi(parti, new Uint8Array([1, 1])) // edge_flags
  if (versione === 2) {
    aggiungi(parti, new Float32Array([2.5, 7.25])) // edge_traffic, una sola fascia implicita
  } else if (versione === 3) {
    const header2 = new DataView(new ArrayBuffer(12))
    header2.setUint32(0, 2, true) // trafficNFasce
    header2.setFloat32(4, 360.0, true) // trafficFasciaInizio: 06:00
    header2.setFloat32(8, 15.0, true) // trafficFasciaPasso
    aggiungi(parti, new Uint8Array(header2.buffer))
    // [fasce x tratti]: fascia 0 (06:00) = [2.5, 7.25], fascia 1 (06:15) = [1.0, 3.0]
    aggiungi(parti, new Float32Array([2.5, 7.25, 1.0, 3.0]))
  }
  return concat(parti)
}

test('il grafo di versione 1 si legge ancora, senza asse traffico', () => {
  const bytes = grafoMinimale(1)
  const grafo = leggiGrafo(bytes, ['via-test'])

  assert.equal(grafo.nNodi, 3)
  assert.equal(grafo.nTratti, 2)
  assert.equal(grafo.trafficNFasce, 1)
  assert.equal(grafo.edgeTraffic.length, 2)
  assert.deepEqual(Array.from(grafo.edgeTraffic), [0, 0], 'v1 non porta traffico: zero, mai un\'ipotesi')
  assert.ok(Math.abs(grafo.edgeLen[0] - 10) < 1e-4)
})

test('il grafo di versione 2 porta edgeTraffic, una sola fascia', () => {
  const bytes = grafoMinimale(2)
  const grafo = leggiGrafo(bytes, ['via-test'])

  assert.equal(grafo.trafficNFasce, 1)
  assert.equal(grafo.edgeTraffic.length, 2)
  assert.ok(Math.abs(grafo.edgeTraffic[0] - 2.5) < 1e-4)
  assert.ok(Math.abs(grafo.edgeTraffic[1] - 7.25) < 1e-4)
})

test('il grafo di versione 3 porta edgeTraffic a piu\' fasce', () => {
  const bytes = grafoMinimale(3)
  const grafo = leggiGrafo(bytes, ['via-test'])

  assert.equal(VERSIONE_GRAFO, 3)
  assert.equal(grafo.trafficNFasce, 2)
  assert.equal(grafo.trafficFasciaInizio, 360)
  assert.equal(grafo.trafficFasciaPasso, 15)
  assert.equal(grafo.edgeTraffic.length, 4)
  assert.deepEqual(Array.from(grafo.edgeTraffic), [2.5, 7.25, 1.0, 3.0])
})

test('una versione ne\' 1, 2 ne\' 3 viene rifiutata', () => {
  const bytes = grafoMinimale(2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(4, 4, true)
  assert.throws(() => leggiGrafo(bytes, ['via-test']), /versione 4/)
})
