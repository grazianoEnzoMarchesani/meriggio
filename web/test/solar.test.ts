/**
 * Il porting di `solar.py` deve dare gli stessi numeri dell'originale.
 *
 * Gli scarti ammessi sono minuscoli di proposito: le due implementazioni fanno
 * la stessa sequenza di operazioni sugli stessi float a 64 bit, quindi devono
 * differire al massimo per l'ultimo bit. Una tolleranza larga nasconderebbe
 * proprio l'errore che questo test cerca, cioe' una formula trascritta male.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clearSkyIrradiance, solarLoad, solarPosition, sunTimes } from '../src/meriggio/solar.ts'
import { carica } from './riferimenti.ts'

interface Campione {
  luogo: string
  lat: number
  lon: number
  utc: string
  elevation: number
  azimuth: number
  ghi: number
  load: number
}

interface Orario {
  giorno: string
  mezzanotte_utc: string
  lat: number
  lon: number
  sunrise: string | null
  sunset: string | null
  solar_noon: string
  max_elevation: number
}

const rif = carica<{ campioni: Campione[]; orari: Orario[] }>('solar')

test('posizione del sole identica al calcolo Python', () => {
  let peggioreElev = 0
  let peggioreAzim = 0
  for (const c of rif.campioni) {
    const p = solarPosition(c.lat, c.lon, new Date(c.utc))
    peggioreElev = Math.max(peggioreElev, Math.abs(p.elevation - c.elevation))
    // L'azimut e' un angolo: 359.9999 e 0.0001 distano un decimillesimo.
    let dAzim = Math.abs(p.azimuth - c.azimuth) % 360
    if (dAzim > 180) dAzim = 360 - dAzim
    peggioreAzim = Math.max(peggioreAzim, dAzim)
  }
  assert.ok(rif.campioni.length > 300, 'pochi campioni di riferimento')
  assert.ok(peggioreElev < 1e-9, `elevazione: scarto massimo ${peggioreElev}`)
  assert.ok(peggioreAzim < 1e-9, `azimut: scarto massimo ${peggioreAzim}`)
})

test('irradianza e carico radiativo identici', () => {
  let peggioreGhi = 0
  let peggioreLoad = 0
  for (const c of rif.campioni) {
    peggioreGhi = Math.max(peggioreGhi, Math.abs(clearSkyIrradiance(c.elevation) - c.ghi))
    peggioreLoad = Math.max(peggioreLoad, Math.abs(solarLoad(c.elevation) - c.load))
  }
  assert.ok(peggioreGhi < 1e-9, `irradianza: scarto massimo ${peggioreGhi}`)
  assert.ok(peggioreLoad < 1e-12, `carico: scarto massimo ${peggioreLoad}`)
})

test('alba, tramonto e mezzogiorno solare al millisecondo', () => {
  for (const o of rif.orari) {
    const t = sunTimes(o.lat, o.lon, new Date(o.mezzanotte_utc))
    const confronta = (nome: string, avuto: Date | null, atteso: string | null) => {
      if (atteso === null) {
        assert.equal(avuto, null, `${o.giorno} ${nome}`)
        return
      }
      assert.ok(avuto, `${o.giorno} ${nome} mancante`)
      const scarto = Math.abs(avuto.getTime() - new Date(atteso).getTime())
      assert.ok(scarto <= 1, `${o.giorno} ${nome}: ${scarto} ms di scarto`)
    }
    confronta('alba', t.sunrise, o.sunrise)
    confronta('tramonto', t.sunset, o.sunset)
    confronta('mezzogiorno', t.solarNoon, o.solar_noon)
    assert.ok(
      Math.abs(t.maxElevation - o.max_elevation) < 1e-9,
      `${o.giorno} elevazione massima: ${t.maxElevation} invece di ${o.max_elevation}`,
    )
  }
})

test('i valori noti di Ascoli restano quelli verificati sul campo', () => {
  // Gli stessi controlli citati nel README: solstizio d'estate 70,6 gradi,
  // solstizio d'inverno 23,7. Se il porting sbagliasse in modo sistematico,
  // qui si vedrebbe anche senza confronto col Python.
  const estate = sunTimes(42.8536, 13.5749, new Date('2026-06-21T00:00:00+02:00'))
  const inverno = sunTimes(42.8536, 13.5749, new Date('2026-12-21T00:00:00+01:00'))
  assert.ok(
    Math.abs(estate.maxElevation - 70.6) < 0.15,
    `solstizio d'estate: ${estate.maxElevation}`,
  )
  assert.ok(
    Math.abs(inverno.maxElevation - 23.7) < 0.15,
    `solstizio d'inverno: ${inverno.maxElevation}`,
  )
})
