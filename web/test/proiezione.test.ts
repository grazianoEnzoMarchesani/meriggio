/**
 * Le formule UTM devono dare gli stessi metri di pyproj.
 *
 * La tolleranza e' un centimetro, non perche' serva quella precisione ma
 * perche' un errore piu' grande non sarebbe un arrotondamento: vorrebbe dire
 * che un termine della serie e' sbagliato, e allora crescerebbe verso il bordo
 * del fuso fino a spostare il punto di parecchi metri. I casi coprono apposta
 * il meridiano centrale, i due bordi, un'area che sconfina nel fuso accanto e
 * l'emisfero sud.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fusoDaEpsg, versoGradi, versoUtm } from '../src/meriggio/utm.ts'
import { carica } from './riferimenti.ts'

interface Caso {
  epsg: number
  lon: number[]
  lat: number[]
  x: number[]
  y: number[]
  lon_ritorno: number[]
  lat_ritorno: number[]
}

const rif = carica<{ casi: Caso[] }>('proiezione')

test('da gradi a UTM come pyproj, al centimetro', () => {
  for (const caso of rif.casi) {
    const fuso = fusoDaEpsg(caso.epsg)
    let peggiore = 0
    let dove = -1
    for (let i = 0; i < caso.lon.length; i++) {
      const [x, y] = versoUtm(caso.lon[i], caso.lat[i], fuso)
      const d = Math.hypot(x - caso.x[i], y - caso.y[i])
      if (d > peggiore) {
        peggiore = d
        dove = i
      }
    }
    assert.ok(
      peggiore < 0.01,
      `EPSG ${caso.epsg}: ${(peggiore * 100).toFixed(2)} cm di scarto a ` +
        `${caso.lon[dove]}, ${caso.lat[dove]}`,
    )
  }
})

test('da UTM a gradi come pyproj', () => {
  for (const caso of rif.casi) {
    const fuso = fusoDaEpsg(caso.epsg)
    let peggiore = 0
    for (let i = 0; i < caso.x.length; i++) {
      const [lon, lat] = versoGradi(caso.x[i], caso.y[i], fuso)
      // Un centimetro di arco: un decimilionesimo di grado circa.
      peggiore = Math.max(
        peggiore,
        Math.abs(lon - caso.lon_ritorno[i]) * 111320 * Math.cos(caso.lat[i] * (Math.PI / 180)),
        Math.abs(lat - caso.lat_ritorno[i]) * 110574,
      )
    }
    assert.ok(peggiore < 0.01, `EPSG ${caso.epsg}: ${(peggiore * 100).toFixed(2)} cm di scarto`)
  }
})

test('andata e ritorno tornano al punto di partenza', () => {
  const fuso = fusoDaEpsg(32633)
  for (let lon = 12.5; lon <= 18.5; lon += 0.5) {
    for (let lat = 36.0; lat <= 47.0; lat += 0.5) {
      const [x, y] = versoUtm(lon, lat, fuso)
      const [lon2, lat2] = versoGradi(x, y, fuso)
      const scarto = Math.hypot((lon2 - lon) * 82000, (lat2 - lat) * 110574)
      assert.ok(scarto < 0.01, `${lon}, ${lat}: ${(scarto * 100).toFixed(2)} cm`)
    }
  }
})
