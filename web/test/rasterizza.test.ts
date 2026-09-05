/**
 * Il riempimento dei poligoni deve coprire esattamente l'area che dichiara.
 *
 * E' la parte su cui poggia la nettezza delle ombre degli edifici: se la
 * copertura di un bordo obliquo non e' quella giusta, il bordo si vede
 * sfilacciato invece che dritto, ed e' proprio il difetto che si voleva
 * togliere. Le prove sono su figure di cui l'area si sa a mente.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { areaSegnata, riempi } from '../src/ombra/rasterizza.ts'

const LATO = 200

function copertura(pezzi: { xy: Float64Array; verso: number }[]): number {
  const m = new Float32Array(LATO * LATO)
  riempi(pezzi, LATO, LATO, m)
  let somma = 0
  for (let i = 0; i < m.length; i++) somma += m[i]
  return somma
}

const quadrato = (x0: number, y0: number, lato: number) =>
  Float64Array.of(x0, y0, x0 + lato, y0, x0 + lato, y0 + lato, x0, y0 + lato)

test('un quadrato copre esattamente la sua area', () => {
  assert.equal(copertura([{ xy: quadrato(50, 50, 100), verso: 1 }]), 10000)
})

test('il verso dei vertici non cambia il risultato', () => {
  const rovescio = Float64Array.of(50, 150, 150, 150, 150, 50, 50, 50)
  assert.ok(areaSegnata(rovescio) < 0, 'il quadrato di prova deve girare al contrario')
  assert.equal(copertura([{ xy: rovescio, verso: 1 }]), 10000)
})

test('due pezzi sovrapposti si fondono invece di sommarsi', () => {
  // 100x100 e 80x80 con 50x50 in comune.
  const somma = copertura([
    { xy: quadrato(50, 50, 100), verso: 1 },
    { xy: quadrato(100, 100, 80), verso: 1 },
  ])
  assert.equal(somma, 10000 + 6400 - 2500)
})

test('un anello al contrario ritaglia un vuoto', () => {
  const somma = copertura([
    { xy: quadrato(50, 50, 100), verso: 1 },
    { xy: quadrato(80, 80, 40), verso: -1 },
  ])
  assert.equal(somma, 10000 - 1600)
})

test('un bordo a meta pixel si divide fra i due pixel', () => {
  // Nessun vertice cade su un intero: l'area giusta si ottiene solo se il
  // bordo e' sfumato in proporzione a quanto entra in ciascun pixel.
  const somma = copertura([{ xy: quadrato(50.5, 50.25, 49.5), verso: 1 }])
  assert.ok(Math.abs(somma - 49.5 * 49.5) < 0.5, `coperti ${somma}, attesi ${49.5 * 49.5}`)

  // E il pixel tagliato a meta' deve valere davvero meta'.
  const m = new Float32Array(LATO * LATO)
  riempi([{ xy: quadrato(50.5, 50, 50) , verso: 1 }], LATO, LATO, m)
  assert.ok(Math.abs(m[60 * LATO + 50] - 0.5) < 1e-6, `bordo a ${m[60 * LATO + 50]}`)
  assert.equal(m[60 * LATO + 51], 1)
})

test('un triangolo obliquo copre meta del suo rettangolo', () => {
  const somma = copertura([
    { xy: Float64Array.of(40, 40, 140, 40, 40, 140), verso: 1 },
  ])
  assert.ok(Math.abs(somma - 5000) < 10, `coperti ${somma}, attesi circa 5000`)
})

test('quello che esce dall immagine viene tagliato, non ripiegato', () => {
  const somma = copertura([{ xy: quadrato(-50, -50, 100), verso: 1 }])
  assert.equal(somma, 2500)
})
