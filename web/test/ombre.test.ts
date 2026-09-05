/**
 * L'immagine delle ombre deve cadere dove cadono le ombre.
 *
 * Il calcolo in se' e' gia' verificato altrove: qui si controlla il passaggio
 * che il backend faceva con `rasterio.warp`, cioe' il rimettere un raster UTM
 * dentro la griglia in Web Mercator con cui ragiona la mappa. Fra i due
 * sistemi c'e' una rotazione che ad Ascoli vale quasi un grado: se venisse
 * ignorata, o applicata al contrario, l'ombra si vedrebbe scivolata di
 * quaranta metri rispetto alla strada che la riceve, e sarebbe un errore
 * perfettamente verosimile a guardarlo.
 *
 * Il confronto e' fatto sulla stessa superficie, cosi' quello che resta di
 * diverso puo' essere solo la riproiezione.
 *
 * Il confronto non puo' essere pixel per pixel: l'immagine e' interpolata fra
 * le celle e ammorbidita sui bordi, quindi sul contorno di ogni ombra vale una
 * via di mezzo che nessuna singola cella contiene. Si chiede allora che ogni
 * pixel stia dentro l'intervallo delle celle che ha intorno: dove il modello e'
 * uniforme la richiesta e' stretta quanto prima, dove il modello cambia si
 * accetta la sfumatura. Uno scivolamento di quaranta metri, che e' l'errore da
 * cui il test difende, vale cinque celle: molto piu' in la' di quel raggio.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

import { portataOmbra } from '../src/ombra/live.ts'
import { latDaMercatore, mercatoreY, MAX_OPACITY, disegnaOmbre } from '../src/ombra/overlay.ts'
import { canopyTransmissivity, pixelDiPunti, sunFactor } from '../src/ombra/shadow.ts'
import { decodificaTassello, superficieDaVeduta } from '../src/ombra/tiles.ts'
import { apriLocale, esportata, DATI } from './area.ts'

const disponibile = esportata('ascoli-piceno')
const R_TERRA = 6378137.0

/** Quante celle intorno al campione puo' aver toccato l'interpolazione. */
const RAGGIO = 2

test(
  'le ombre disegnate stanno dove le calcola il motore',
  { skip: !disponibile && 'area non esportata' },
  async () => {
    const area = await apriLocale('ascoli-piceno')
    const griglia = area.manifesto.surface
    const veduta = decodificaTassello(
      gunzipSync(readFileSync(`${DATI}ascoli-piceno/${griglia.overview.url}`)),
    )
    const superficie = superficieDaVeduta(
      griglia,
      veduta,
      { col0: 0, row0: 0, col1: veduta.width, row1: veduta.height },
      canopyTransmissivity,
    )

    // Un riquadro interno all'area, cosi' i campioni non finiscono sul bordo
    // dove il raster si esaurisce.
    const [lo, la, LO, LA] = area.manifesto.bounds
    const bounds: [number, number, number, number] = [
      lo + (LO - lo) * 0.08,
      la + (LA - la) * 0.08,
      LO - (LO - lo) * 0.08,
      LA - (LA - la) * 0.08,
    ]

    for (const iso of [
      '2026-07-30T08:30:00+02:00', // sole basso da est
      '2026-07-30T13:00:00+02:00', // sole alto
      '2026-07-30T19:15:00+02:00', // sole radente da ovest
    ]) {
      const quando = new Date(iso)
      const { elevation, azimuth } = area.sole(quando)
      const portata = portataOmbra(elevation)
      const ombre = disegnaOmbre(
        superficie, area.fuso, bounds, azimuth, elevation, 700, portata,
      )

      const [[ovest, nord], , [est, sud]] = ombre.angoli
      const mx0 = ovest * (Math.PI / 180) * R_TERRA
      const mx1 = est * (Math.PI / 180) * R_TERRA
      const my0 = mercatoreY(sud)
      const my1 = mercatoreY(nord)

      // Le posizioni che l'immagine dichiara di rappresentare, un campione
      // ogni tanti pixel.
      const lons: number[] = []
      const lats: number[] = []
      const ombreggiatura: number[] = []
      for (let r = 3; r < ombre.altezza; r += 17) {
        for (let c = 3; c < ombre.larghezza; c += 19) {
          lons.push(((mx0 + ((c + 0.5) * (mx1 - mx0)) / ombre.larghezza) / R_TERRA) * (180 / Math.PI))
          lats.push(latDaMercatore(my1 - ((r + 0.5) * (my1 - my0)) / ombre.altezza))
          ombreggiatura.push(
            ombre.pixel[(r * ombre.larghezza + c) * 4 + 3] / (MAX_OPACITY * 255),
          )
        }
      }
      assert.ok(lons.length > 500, `${iso}: solo ${lons.length} campioni`)

      const xs = new Float64Array(lons.length)
      const ys = new Float64Array(lons.length)
      for (let i = 0; i < lons.length; i++) {
        const [x, y] = area.utm(lons[i], lats[i])
        xs[i] = x
        ys[i] = y
      }
      // La stessa maschera che il disegno ha in mano, e la cella in cui cade
      // ciascun campione.
      const atteso = sunFactor(
        superficie.dsm, superficie.width, superficie.height, superficie.pixelSize,
        azimuth, elevation, superficie.canopy, superficie.tau, portata,
      )
      const { righe, colonne } = pixelDiPunti(superficie.transform, xs, ys)

      let diversi = 0
      for (let i = 0; i < lons.length; i++) {
        // Le celle a portata di interpolazione: l'ammorbidimento arriva a una
        // cella, il campionamento bilineare a un'altra.
        let minimo = Infinity
        let massimo = -Infinity
        for (let r = righe[i] - RAGGIO; r <= righe[i] + RAGGIO; r++) {
          if (r < 0 || r >= superficie.height) continue
          for (let c = colonne[i] - RAGGIO; c <= colonne[i] + RAGGIO; c++) {
            if (c < 0 || c >= superficie.width) continue
            const v = 1 - atteso[r * superficie.width + c]
            if (v < minimo) minimo = v
            if (v > massimo) massimo = v
          }
        }
        if (minimo === Infinity) continue
        // Il canale alfa ha 255 livelli e l'ombra della chioma vale 0,4-0,05:
        // un ottavo di scala e' molto piu' largo di quell'arrotondamento e
        // molto piu' stretto della differenza fra sole e ombra.
        const scarto = Math.max(minimo - ombreggiatura[i], ombreggiatura[i] - massimo)
        if (scarto > 0.125) diversi++
      }
      const quota = (100 * diversi) / lons.length
      // Quello che resta e' il bordo dei bordi: due griglie diverse, e un
      // campione ogni tanto pesca la cella di la'.
      assert.ok(quota < 1.5, `${iso}: ${quota.toFixed(2)}% dei campioni fuori posto`)
    }
  },
)
