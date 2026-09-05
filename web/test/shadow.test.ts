/**
 * Il porting di `shadow.py` deve dare gli stessi raster, pixel per pixel.
 *
 * Qui la tolleranza e' zero e non e' un vezzo: `sun_factor` restituisce solo
 * 0, 1 e la trasmissivita' della chioma, quindi un pixel diverso significa che
 * l'ombra e' finita in un posto diverso, non che un'ultima cifra ha ballato.
 * L'unico confronto con tolleranza e' quello sulla trasmissivita', che e' un
 * numero calcolato e non una decisione.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  affineDaOrigine,
  canopyTransmissivity,
  samplePoints,
  sunFactor,
  sunFactorPoints,
} from '../src/ombra/shadow.ts'
import { carica, daBase64, scartoMax } from './riferimenti.ts'

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

const rif = carica<{ casi: Caso[] }>('shadow')

test('sun_factor identico al calcolo Python su ogni scena e ogni angolo', () => {
  assert.ok(rif.casi.length >= 3, 'mancano le scene di riferimento')

  for (const caso of rif.casi) {
    const dsm = daBase64(caso.dsm, 'f4')
    const canopy = caso.canopy === null ? null : daBase64(caso.canopy, 'f4')
    const tau = caso.tcd === null ? null : canopyTransmissivity(daBase64(caso.tcd, 'f4'))

    for (const atteso of caso.attesi) {
      const avuto = sunFactor(
        dsm,
        caso.width,
        caso.height,
        caso.pixel_size,
        atteso.azimuth,
        atteso.elevation,
        canopy,
        tau,
        caso.max_distance,
      )
      const voluto = daBase64(atteso.factor, 'f4')

      let diversi = 0
      let primo = -1
      for (let i = 0; i < voluto.length; i++) {
        if (avuto[i] !== voluto[i]) {
          if (primo < 0) primo = i
          diversi++
        }
      }
      const dove =
        primo < 0
          ? ''
          : ` primo scarto a riga ${Math.floor(primo / caso.width)} colonna ` +
            `${primo % caso.width}: ${avuto[primo]} invece di ${voluto[primo]}`
      assert.equal(
        diversi,
        0,
        `${caso.nome} az ${atteso.azimuth} elev ${atteso.elevation}: ` +
          `${diversi} pixel su ${voluto.length} diversi.${dove}`,
      )
    }
  }
})

test('il calcolo per punti da gli stessi valori di quello su tutto il raster', () => {
  // E' la scorciatoia su cui si regge il routing nel browser: invece di
  // proiettare l'ombra su tutto il ritaglio si valuta il raggio solare nei
  // soli punti che servono. Deve dare gli stessi numeri, non numeri simili,
  // quindi il confronto e' su ogni pixel di ogni scena.
  for (const caso of rif.casi) {
    const dsm = daBase64(caso.dsm, 'f4')
    const canopy = caso.canopy === null ? null : daBase64(caso.canopy, 'f4')
    const tau = caso.tcd === null ? null : canopyTransmissivity(daBase64(caso.tcd, 'f4'))
    // Origine arbitraria ma non tonda: se il calcolo dei pixel fosse sbagliato
    // di mezzo pixel, con un'origine tonda potrebbe non vedersi.
    const transform = affineDaOrigine(361234.5, 4750987.5, caso.pixel_size)

    // I centri di tutti i pixel, piu' una cornice di punti fuori dal raster.
    const xs: number[] = []
    const ys: number[] = []
    for (let r = -1; r <= caso.height; r++) {
      for (let c = -1; c <= caso.width; c++) {
        xs.push(transform.c + (c + 0.5) * caso.pixel_size)
        ys.push(transform.f - (r + 0.5) * caso.pixel_size)
      }
    }

    for (const atteso of caso.attesi) {
      const raster = sunFactor(
        dsm, caso.width, caso.height, caso.pixel_size,
        atteso.azimuth, atteso.elevation, canopy, tau, caso.max_distance,
      )
      const daRaster = samplePoints(
        raster, caso.width, caso.height, transform, xs, ys, 1.0,
      )
      const perPunti = sunFactorPoints(
        dsm, caso.width, caso.height, caso.pixel_size, transform,
        atteso.azimuth, atteso.elevation, xs, ys, canopy, tau, caso.max_distance, 1.0,
      )
      const { max, indice } = scartoMax(perPunti, daRaster)
      assert.equal(
        max,
        0,
        `${caso.nome} az ${atteso.azimuth} elev ${atteso.elevation}: punto ${indice} ` +
          `vale ${perPunti[indice]} invece di ${daRaster[indice]}`,
      )
    }
  }
})

test('la trasmissivita della chioma segue la densita come in Python', () => {
  const caso = rif.casi.find((c) => c.tcd !== null)
  assert.ok(caso, 'nessuna scena con vegetazione')
  const tcd = daBase64(caso.tcd as string, 'f4')
  const tau = canopyTransmissivity(tcd)
  // Gli estremi della tabella: densita' nulla lascia passare tutto quello che
  // una chioma rada lascia passare, densita' piena il minimo.
  for (let i = 0; i < tcd.length; i++) {
    const atteso = 0.4 + (0.05 - 0.4) * Math.min(1, Math.max(0, tcd[i] / 100))
    assert.ok(Math.abs(tau[i] - atteso) < 1e-6, `tcd ${tcd[i]} -> tau ${tau[i]}`)
  }
})

interface Campioni {
  width: number
  height: number
  origin: [number, number]
  resolution: number
  raster: string
  xs: string
  ys: string
  attesi: string
}

const camp = carica<Campioni>('campioni')

test('sample_points sceglie gli stessi pixel, bordi e fuori area compresi', () => {
  const raster = daBase64(camp.raster, 'f4')
  const xs = daBase64(camp.xs, 'f8')
  const ys = daBase64(camp.ys, 'f8')
  const attesi = daBase64(camp.attesi, 'f4')
  const transform = affineDaOrigine(camp.origin[0], camp.origin[1], camp.resolution)

  const avuti = samplePoints(raster, camp.width, camp.height, transform, xs, ys, 1.0)
  const { max, indice } = scartoMax(avuti, attesi)
  assert.equal(
    max,
    0,
    `campione ${indice} in (${xs[indice]}, ${ys[indice]}): ` +
      `${avuti[indice]} invece di ${attesi[indice]}`,
  )
})
