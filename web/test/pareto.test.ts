/**
 * Prova che la frontiera di Pareto (tempo, sole) trova percorsi che la somma
 * pesata di `router.ts` non puo' trovare per nessun valore di alpha.
 *
 * Il grafo e' costruito a mano (stesso spirito di `graphMinimale()` in
 * `graph.test.ts`, ma qui bastano i campi tipizzati diretti: non serve
 * passare dal formato binario) con tre percorsi alternativi fra A e D:
 *
 *   A-B-D  veloce, pieno sole      (tempo 2.0, dose 2.0)
 *   A-E-F-D  intermedio, "in tacca" (tempo 2.5, dose 1.7)  <- il punto in questione
 *   A-C-D  lento, ombra totale     (tempo 4.0, dose 0.0)
 *
 * Il punto intermedio e' geometricamente sopra il segmento che unisce gli
 * altri due nello spazio (tempo, dose): nessuna somma pesata `tempo + alpha *
 * dose` con alpha >= 0 puo' preferirlo a entrambi gli altri contemporaneamente
 * (per costruzione: batte il primo solo con alpha > 1.667, batte il terzo solo
 * con alpha < 0.882 -- le due condizioni non si sovrappongono mai). Un
 * Dijkstra multi-etichetta invece lo trova, perche' non collassa i due assi.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FOOT, type Grafo, type Modalita } from '../src/ombra/graph.ts'
import { Esposizione } from '../src/ombra/exposure.ts'
import { mezzanotteLocale, minutiDelGiorno } from '../src/ombra/fusi.ts'
import { esposizioneCorridoio } from '../src/ombra/live.ts'
import { dijkstra, preparaRicerca } from '../src/ombra/router.ts'
import {
  calcolaFrontieraParetoTempoSole,
  domina,
  frontieraParetoTempoSole,
  ricostruisciCammino,
  scegliDallaFrontiera,
} from '../src/ombra/pareto.ts'
import { apriLocale, esportata } from './area.ts'
import { carica } from './riferimenti.ts'

const disponibile = esportata('ascoli-piceno')

/** Nodi: 0=A (partenza), 1=B, 2=C, 3=D (arrivo), 4=E, 5=F. */
function grafoSintetico(): Grafo {
  return {
    nNodi: 6,
    nTratti: 7,
    nodeX: Float64Array.from([0, 50, 50, 100, 40, 70]),
    nodeY: Float64Array.from([0, 10, -10, 0, 20, 20]),
    nodeLon: Float32Array.from([13.0, 13.001, 13.001, 13.002, 13.0005, 13.0015]),
    nodeLat: Float32Array.from([42.0, 42.0, 42.0, 42.0, 42.0, 42.0]),
    // e0 A-B, e1 B-D, e2 A-C, e3 C-D, e4 A-E, e5 E-F, e6 F-D
    edgeU: Int32Array.from([0, 1, 0, 2, 0, 4, 5]),
    edgeV: Int32Array.from([1, 3, 2, 3, 4, 5, 3]),
    edgeLen: Float32Array.from([60, 60, 120, 120, 54, 48, 48]),
    edgeSlope: new Float32Array(7),
    edgeRough: new Float32Array(7),
    edgeFlags: new Uint8Array(7).fill(FOOT),
    edgeName: new Uint16Array(7),
    edgeTraffic: new Float32Array(7),
    trafficNFasce: 1,
    trafficFasciaInizio: 0,
    trafficFasciaPasso: 1440,
    sampleCount: new Uint16Array(7),
    sampleOffset: new Int32Array(7),
    sampleX: new Float64Array(0),
    sampleY: new Float64Array(0),
    adjStart: Int32Array.from([0, 3, 5, 7, 10, 12, 14]),
    adjTarget: Int32Array.from([1, 2, 4, 0, 3, 0, 3, 1, 2, 5, 0, 5, 4, 3]),
    adjEdge: Int32Array.from([0, 2, 4, 0, 1, 2, 3, 1, 3, 6, 4, 5, 5, 6]),
    nomi: ['via-test'],
  }
}

const TEMPO = Float64Array.from([1.0, 1.0, 2.0, 2.0, 0.9, 0.8, 0.8])
const DOSE_RATE = Float32Array.from([1.0, 1.0, 0.0, 0.0, 0.68, 0.68, 0.68])

test('la frontiera Pareto trova i tre percorsi non dominati, incluso quello in tacca', () => {
  const g = grafoSintetico()
  const ammessi = new Uint8Array(7).fill(1)

  const frontiera = frontieraParetoTempoSole(g, TEMPO, ammessi, DOSE_RATE, 1, 0, 3, 1.0, 100)

  assert.equal(frontiera.length, 3, 'devono esistere esattamente tre percorsi non dominati')

  const [veloce, tacca, ombreggiato] = frontiera
  assert.ok(Math.abs(veloce.tempo - 2.0) < 1e-9)
  assert.ok(Math.abs(veloce.sunDose - 2.0) < 1e-6)
  assert.ok(Math.abs(tacca.tempo - 2.5) < 1e-9)
  assert.ok(Math.abs(tacca.sunDose - 1.7) < 1e-5)
  assert.ok(Math.abs(ombreggiato.tempo - 4.0) < 1e-9)
  assert.ok(Math.abs(ombreggiato.sunDose - 0.0) < 1e-9)

  // Invariante: nessuna etichetta della frontiera ne domina un'altra.
  for (const a of frontiera) {
    for (const b of frontiera) {
      if (a === b) continue
      assert.equal(domina(a, b), false, 'due punti della stessa frontiera non possono dominarsi')
    }
  }

  assert.deepEqual(ricostruisciCammino(veloce).tratti, [0, 1], 'A-B-D')
  assert.deepEqual(ricostruisciCammino(tacca).tratti, [4, 5, 6], 'A-E-F-D, il percorso in tacca')
  assert.deepEqual(ricostruisciCammino(ombreggiato).tratti, [2, 3], 'A-C-D')
})

test(
  'nessun alpha della somma pesata attuale seleziona mai il percorso in tacca',
  () => {
    const g = grafoSintetico()
    const ammessi = new Uint8Array(7).fill(1)

    const eTacca = (tratti: number[]): boolean =>
      tratti.length === 3 && tratti[0] === 4 && tratti[1] === 5 && tratti[2] === 6

    let vistoVeloce = false
    let vistoOmbreggiato = false

    // 0..5 copre ampiamente ALPHA_MAX (5.0) usato dall'app; il passo fine
    // esclude che il percorso in tacca vinca solo in un intervallo stretto
    // che un campionamento piu' grosso salterebbe per caso.
    for (let alpha = 0; alpha <= 5; alpha += 0.005) {
      const mult = new Float32Array(7)
      for (let e = 0; e < 7; e++) mult[e] = 1.0 + alpha * DOSE_RATE[e]

      const cammino = dijkstra(g, TEMPO, ammessi, mult, 1, 0, 3, 1.0)
      assert.ok(cammino !== null, `alpha=${alpha}: nessun percorso trovato`)
      assert.ok(
        !eTacca(cammino!.tratti),
        `alpha=${alpha}: la somma pesata ha scelto il percorso in tacca, non dovrebbe mai succedere`,
      )
      if (cammino!.tratti.length === 2 && cammino!.tratti[0] === 0) vistoVeloce = true
      if (cammino!.tratti.length === 2 && cammino!.tratti[0] === 2) vistoOmbreggiato = true
    }

    // Non e' un test vacuo: nello sweep la somma pesata sceglie davvero
    // entrambi gli altri due percorsi, il problema e' specifico del terzo.
    assert.ok(vistoVeloce, 'lo sweep dovrebbe scegliere A-B-D per alpha piccoli')
    assert.ok(vistoOmbreggiato, 'lo sweep dovrebbe scegliere A-C-D per alpha grandi')
  },
)

test('API di alto livello: Percorso, fastest e scelta dalla frontiera', () => {
  const g = grafoSintetico()
  // Elevazione 90 satura solarLoad a 1.0 esatto (clearSkyIrradiance > 950),
  // cosi' la dose per tratto e' esattamente l'esposizione quantizzata a byte.
  const bytes = Uint8Array.from(
    [...DOSE_RATE, ...DOSE_RATE].map((v) => Math.round(v * 255)),
  )
  const esposizione = new Esposizione(
    bytes,
    Float32Array.from([0, 10]),
    Float32Array.from([90, 90]),
    Float32Array.from([0, 0]),
    7,
  )

  const risultato = calcolaFrontieraParetoTempoSole({
    grafo: g,
    esposizione,
    origineUtm: [0, 0],
    destinazioneUtm: [100, 0],
    mode: 'foot',
    minutoPartenza: 0,
  })

  assert.equal(risultato.frontiera.length, 3)
  assert.equal(
    risultato.fastest.duration_min,
    risultato.frontiera[0].duration_min,
    'il piu rapido in assoluto e sempre il primo punto della frontiera',
  )

  const durate = risultato.frontiera.map((p) => p.duration_min)
  assert.deepEqual(durate, [...durate].sort((a, b) => a - b), 'la frontiera resta ordinata per durata')

  const veloce = scegliDallaFrontiera(risultato.frontiera, 0)
  assert.equal(veloce.duration_min, durate[0])

  const ombreggiato = scegliDallaFrontiera(risultato.frontiera, 1)
  assert.equal(ombreggiato.duration_min, durate[durate.length - 1])

  // A meta' cursore, il punto piu' vicino al tempo intermedio e' proprio
  // quello in tacca: la UI potrebbe finalmente mostrarlo.
  const medio = scegliDallaFrontiera(risultato.frontiera, 0.5)
  assert.ok(
    Math.abs(medio.duration_min - durate[1]) < 1e-6,
    'a meta cursore dovrebbe emergere il percorso in tacca, prima irraggiungibile',
  )
})

/**
 * Validazione su dati reali: non e' un confronto byte-per-byte come
 * `percorsi.test.ts` (la frontiera non e' un solo percorso), ma due
 * proprieta' che devono valere comunque -- la frontiera contiene il vero
 * percorso piu' rapido come primo punto, e resta internamente non dominata --
 * piu' un report di quanto cresce la frontiera su tragitti reali, la domanda
 * aperta prima di collegare questo prototipo all'app.
 */
test(
  'sui dati reali la frontiera resta non dominata ed e tracciabile in tempi ragionevoli',
  { skip: !disponibile && 'area non esportata' },
  async () => {
    const area = await apriLocale('ascoli-piceno')

    interface CasoMinimo {
      nome: string
      partenza: [number, number]
      arrivo: [number, number]
      modalita: Modalita
      utc: string
    }
    const rif = carica<{ casi: CasoMinimo[] }>('percorsi')

    // Un caso per lunghezza di tragitto, a piedi: e' l'asse su cui la
    // frontiera puo' allargarsi di piu' (velocita' bassa, ombra rilevante).
    const visti = new Set<string>()
    const casi: CasoMinimo[] = []
    for (const c of rif.casi) {
      if (c.modalita !== 'foot') continue
      const chiave = c.nome.replace(/\d+.*$/, '').trim()
      if (visti.has(chiave)) continue
      visti.add(chiave)
      casi.push(c)
    }
    assert.ok(casi.length >= 1, 'nessun caso a piedi nei riferimenti')

    for (const caso of casi) {
      const origineUtm = area.utm(caso.partenza[0], caso.partenza[1])
      const destinazioneUtm = area.utm(caso.arrivo[0], caso.arrivo[1])
      const quando = new Date(caso.utc)
      const mezzanotte = mezzanotteLocale(quando, area.fusoOrario)
      const minutoPartenza = minutiDelGiorno(quando, area.fusoOrario)

      // Corridoio del percorso piu' rapido: stesso identico procedimento di
      // `Area.percorso()` (area.ts:358-376) per ottenere un'Esposizione vera.
      const prep = preparaRicerca(area.grafo, caso.modalita, origineUtm, destinazioneUtm)
      const piatto = new Float32Array(area.grafo.nTratti).fill(1.0)
      const rapido = dijkstra(
        area.grafo, prep.tempoPercorrenza, prep.ammessi, piatto, 1,
        prep.partenza.nodo, prep.arrivo.nodo, prep.velocitaMax,
      )
      assert.ok(rapido !== null, `${caso.nome}: nessun percorso piu rapido trovato`)

      const corridoio = new Float64Array(rapido!.nodi.length * 2)
      for (let i = 0; i < rapido!.nodi.length; i++) {
        corridoio[i * 2] = area.grafo.nodeX[rapido!.nodi[i]]
        corridoio[i * 2 + 1] = area.grafo.nodeY[rapido!.nodi[i]]
      }

      const { esposizione } = await esposizioneCorridoio({
        grafo: area.grafo,
        griglia: area.manifesto.surface,
        centro: area.manifesto.center,
        passoMinuti: area.manifesto.step_minutes,
        corridoioXY: corridoio,
        quando,
        mezzanotte,
        durataMin: rapido!.tempo,
        tasselli: (t) => area.caricaTasselli(t),
      })

      const inizio = performance.now()
      const risultato = calcolaFrontieraParetoTempoSole({
        grafo: area.grafo,
        esposizione,
        origineUtm,
        destinazioneUtm,
        mode: caso.modalita,
        minutoPartenza,
      })
      const ms = performance.now() - inizio

      assert.ok(risultato.frontiera.length >= 1, `${caso.nome}: frontiera vuota`)
      assert.ok(
        Math.abs(risultato.frontiera[0].duration_min - risultato.fastest.duration_min) < 1e-6,
        `${caso.nome}: il primo punto della frontiera deve essere il percorso piu rapido in assoluto`,
      )
      for (let i = 1; i < risultato.frontiera.length; i++) {
        assert.ok(
          risultato.frontiera[i].duration_min >= risultato.frontiera[i - 1].duration_min - 1e-9,
          `${caso.nome}: la frontiera deve restare ordinata per durata`,
        )
      }
      for (const a of risultato.frontiera) {
        for (const b of risultato.frontiera) {
          if (a === b) continue
          const aDomina =
            a.duration_min <= b.duration_min &&
            a.sun_dose_min <= b.sun_dose_min &&
            (a.duration_min < b.duration_min || a.sun_dose_min < b.sun_dose_min)
          assert.ok(!aDomina, `${caso.nome}: due punti della frontiera reale si dominano a vicenda`)
        }
      }

      console.log(
        `[pareto] ${caso.nome} (${caso.modalita}): ${risultato.frontiera.length} percorsi ` +
          `non dominati in ${ms.toFixed(1)} ms (piu' rapido: ${rapido!.tempo.toFixed(1)} min)`,
      )
    }
  },
)
