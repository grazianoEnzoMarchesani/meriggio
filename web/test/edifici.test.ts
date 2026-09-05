/**
 * Le ombre disegnate in geometria devono dire quello che dice il motore.
 *
 * Sulla mappa gli edifici non fanno piu' ombra attraverso il raster ma
 * attraverso i loro poligoni, proiettati sul terreno vertice per vertice. E' un
 * secondo modo di rispondere alla stessa domanda, e il rischio di un secondo
 * modo e' che risponda un'altra cosa: chi guarda la mappa vedrebbe un'ombra
 * dove il calcolo del percorso ne vede un'altra.
 *
 * Qui si confronta l'immagine con `sunFactor`, che e' verificato contro il
 * Python. Il confronto si ferma dove le due cose hanno il diritto di
 * discostarsi:
 *
 * - **sugli edifici**, dove il raster descrive il tetto e la mappa il suolo: li'
 *   l'ombra a terra viene apposta ritagliata via, tanto la copre il volume;
 * - **sul contorno delle ombre**, dove una griglia da due metri e una geometria
 *   continua non possono cadere sullo stesso pixel;
 * - **dove il terreno cambia**, perche' la punta dell'ombra segue il rilievo e
 *   il bordo si sposta di conseguenza.
 *
 * Quello che resta -- il pieno sole e la piena ombra su suolo aperto, che e' poi
 * cio' su cui si cammina -- deve coincidere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { leggiEdifici } from '../src/ombra/edifici.ts'
import { marginiSole, portataOmbra } from '../src/ombra/live.ts'
import { disegnaOmbre, latDaMercatore, mercatoreY, MAX_OPACITY } from '../src/ombra/overlay.ts'
import { canopyTransmissivity, pixelDiPunti, sunFactor } from '../src/ombra/shadow.ts'
import { componiSuperficie, riquadroPixel, tasselliDi } from '../src/ombra/tiles.ts'
import { apriLocale, esportata, DATI } from './area.ts'

const disponibile = esportata('ascoli-piceno')
const R_TERRA = 6378137.0
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** Celle intorno al campione che l'interpolazione o la geometria puo' toccare. */
const RAGGIO = 2

test(
  'le ombre geometriche degli edifici concordano con il motore',
  { skip: !disponibile && 'area non esportata' },
  async () => {
    const area = await apriLocale('ascoli-piceno')
    const griglia = area.manifesto.surface
    const edifici = leggiEdifici(
      readFileSync(`${DATI}ascoli-piceno/buildings.geojson`),
      area.fuso,
    )
    assert.ok(edifici.length > 1000, `solo ${edifici.length} edifici letti`)

    // Un isolato al centro dell'area, dove i tasselli sono a piena risoluzione.
    const [lo, la, LO, LA] = area.manifesto.bounds
    const cx = (lo + LO) / 2
    const cy = (la + LA) / 2
    const bounds: [number, number, number, number] = [
      cx - 0.00135, cy - 0.001, cx + 0.00135, cy + 0.001,
    ]

    for (const iso of [
      '2026-07-30T09:00:00+02:00', // sole basso da est
      '2026-07-30T13:30:00+02:00', // sole alto
      '2026-07-30T19:00:00+02:00', // sole radente da ovest
    ]) {
      const { elevation, azimuth } = area.sole(new Date(iso))
      const portata = portataOmbra(elevation)

      // La stessa superficie che userebbe il disegno, con la cornice da cui
      // arrivano gli ostacoli.
      const [ovest, sud, est, nord] = marginiSole([{ elevation, azimuth }])
      const [x0, y0] = area.utm(bounds[0], bounds[1])
      const [x1, y1] = area.utm(bounds[2], bounds[3])
      const rq = riquadroPixel(
        griglia,
        Math.min(x0, x1) - ovest, Math.min(y0, y1) - sud,
        Math.max(x0, x1) + est, Math.max(y0, y1) + nord,
      )
      assert.ok(rq !== null, `${iso}: riquadro fuori dall'area`)
      const superficie = componiSuperficie(
        griglia, rq, await area.caricaTasselli(tasselliDi(griglia, rq)), canopyTransmissivity,
      )
      assert.ok(superficie.built !== null, 'la superficie deve portare il costruito')

      const ombre = disegnaOmbre(
        superficie, area.fuso, bounds, azimuth, elevation, 700, portata, edifici,
      )

      // Il riferimento: la maschera del motore sulla superficie intera.
      const atteso = sunFactor(
        superficie.dsm, superficie.width, superficie.height, superficie.pixelSize,
        azimuth, elevation, superficie.canopy, superficie.tau, portata,
      )

      const mx0 = bounds[0] * RAD * R_TERRA
      const mx1 = bounds[2] * RAD * R_TERRA
      const my0 = mercatoreY(bounds[1])
      const my1 = mercatoreY(bounds[3])

      const lons: number[] = []
      const lats: number[] = []
      const disegnata: number[] = []
      for (let r = 3; r < ombre.altezza; r += 3) {
        for (let c = 3; c < ombre.larghezza; c += 3) {
          lons.push(((mx0 + ((c + 0.5) * (mx1 - mx0)) / ombre.larghezza) / R_TERRA) * DEG)
          lats.push(latDaMercatore(my1 - ((r + 0.5) * (my1 - my0)) / ombre.altezza))
          disegnata.push(ombre.pixel[(r * ombre.larghezza + c) * 4 + 3] / (MAX_OPACITY * 255))
        }
      }

      const xs = new Float64Array(lons.length)
      const ys = new Float64Array(lons.length)
      for (let i = 0; i < lons.length; i++) {
        const [x, y] = area.utm(lons[i], lats[i])
        xs[i] = x
        ys[i] = y
      }
      const { righe, colonne } = pixelDiPunti(superficie.transform, xs, ys)
      const costruito = superficie.built as Float32Array

      let confrontati = 0
      let diversi = 0
      for (let i = 0; i < lons.length; i++) {
        let minimo = Infinity
        let massimo = -Infinity
        let suEdificio = false
        let terrenoMin = Infinity
        let terrenoMax = -Infinity

        for (let r = righe[i] - RAGGIO; r <= righe[i] + RAGGIO; r++) {
          if (r < 0 || r >= superficie.height) continue
          for (let c = colonne[i] - RAGGIO; c <= colonne[i] + RAGGIO; c++) {
            if (c < 0 || c >= superficie.width) continue
            const k = r * superficie.width + c
            if (costruito[k] > 0.5) suEdificio = true
            const v = 1 - atteso[k]
            if (v < minimo) minimo = v
            if (v > massimo) massimo = v
            const suolo = superficie.dsm[k] - costruito[k]
            if (suolo < terrenoMin) terrenoMin = suolo
            if (suolo > terrenoMax) terrenoMax = suolo
          }
        }
        if (minimo === Infinity) continue
        // Fuori: gli edifici e i loro dintorni, il contorno delle ombre, e i
        // punti dove il terreno non e' piano.
        if (suEdificio) continue
        if (massimo - minimo > 0.05) continue
        if (terrenoMax - terrenoMin > 1.0) continue

        confrontati++
        if (Math.abs(disegnata[i] - minimo) > 0.125) diversi++
      }

      assert.ok(confrontati > 300, `${iso}: solo ${confrontati} campioni utili`)
      const quota = (100 * diversi) / confrontati
      // Quello che resta e' il gioco fra due descrizioni dello stesso edificio:
      // il poligono ha lo spigolo dove il raster ha il centro della cella.
      assert.ok(
        quota < 6,
        `${iso}: ${quota.toFixed(1)}% di ${confrontati} campioni in disaccordo`,
      )
    }
  },
)
