/**
 * Il percorso calcolato nel browser deve essere quello che calcolava il backend.
 *
 * E' la verifica che tiene insieme tutte le altre: se il sole, le ombre, la
 * proiezione, i tasselli o il Dijkstra fossero portati male anche di poco, qui
 * uscirebbe una strada diversa. Il confronto e' sulla geometria del percorso,
 * non solo sui totali, perche' due strade diverse possono per caso essere
 * lunghe uguale.
 *
 * Casi: tre tragitti (seicento metri nel centro storico, due chilometri e
 * mezzo attraverso il fiume, cinque chilometri da un capo all'altro della
 * citta'), tre orari, le modalita' che li percorrono.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Modalita } from '../src/meriggio/graph.ts'
import { ALPHA_MAX, BETA_MAX } from '../src/meriggio/area.ts'
import { apriLocale, esportata } from './area.ts'
import { carica } from './riferimenti.ts'

interface Atteso {
  distance_m: number
  duration_min: number
  shade_pct: number
  sun_dose_min: number
  n_segments: number
  coordinates: [number, number][]
  /** presente solo sui casi con l'asse traffico (Fase 4) */
  avg_traffic_index?: number
}

interface Caso {
  nome: string
  partenza: [number, number]
  arrivo: [number, number]
  modalita: Modalita
  giorno: string
  ora: string
  utc: string
  departure_minute: number
  alpha: number
  /** assente sui casi sun-only preesistenti: equivale a 0 */
  beta?: number
  atteso: { shaded: Atteso; fastest: Atteso }
}

const rif = carica<{ casi: Caso[] }>('percorsi')
const disponibile = esportata('ascoli-piceno')

test(
  'gli stessi percorsi del backend, geometria compresa',
  { skip: !disponibile && 'area non esportata' },
  async () => {
    const area = await apriLocale('ascoli-piceno')
    assert.ok(rif.casi.length >= 20, `solo ${rif.casi.length} casi di riferimento`)

    // I casi di riferimento con beta>0 sono stati generati in Python senza
    // un concetto di vento live (quello e' un raffinamento solo lato client,
    // vedi vento.ts): equivalgono a fattoreVento=1.0. Il vero fetch di rete
    // qui renderebbe il confronto non deterministico -- dipenderebbe dal
    // vento reale al momento in cui gira il test, non dai dati del backend.
    const fetchOriginale = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('rete disabilitata nel test'))) as typeof fetch
    try {
      for (const caso of rif.casi) {
        const risultato = await area.percorso({
          partenza: { lon: caso.partenza[0], lat: caso.partenza[1] },
          arrivo: { lon: caso.arrivo[0], lat: caso.arrivo[1] },
          modalita: caso.modalita,
          quando: new Date(caso.utc),
          preferenzaOmbra: caso.alpha / ALPHA_MAX,
          preferenzaTraffico: (caso.beta ?? 0) / BETA_MAX,
        })

        assert.equal(
          risultato.departure_minute,
          caso.departure_minute,
          `${caso.nome}: minuto di partenza`,
        )

        for (const variante of ['shaded', 'fastest'] as const) {
          const avuto = risultato[variante]
          const atteso = caso.atteso[variante]
          const dove = `${caso.nome} (${variante})`

          // Prima la strada: se e' la stessa, i numeri lo saranno di conseguenza.
          assert.equal(
            avuto.coordinates.length,
            atteso.coordinates.length,
            `${dove}: ${avuto.coordinates.length} vertici invece di ${atteso.coordinates.length}`,
          )
          let peggiore = 0
          for (let i = 0; i < atteso.coordinates.length; i++) {
            peggiore = Math.max(
              peggiore,
              Math.abs(avuto.coordinates[i][0] - atteso.coordinates[i][0]),
              Math.abs(avuto.coordinates[i][1] - atteso.coordinates[i][1]),
            )
          }
          // I riferimenti sono arrotondati alla sesta cifra, cioe' a un decimetro.
          assert.ok(peggiore <= 1e-6, `${dove}: vertici spostati di ${peggiore} gradi`)

          assert.equal(avuto.segments.length, atteso.n_segments, `${dove}: numero di tratti`)
          assert.ok(
            Math.abs(avuto.distance_m - atteso.distance_m) <= 0.2,
            `${dove}: ${avuto.distance_m} m invece di ${atteso.distance_m}`,
          )
          assert.ok(
            Math.abs(avuto.duration_min - atteso.duration_min) <= 0.02,
            `${dove}: ${avuto.duration_min} min invece di ${atteso.duration_min}`,
          )
          // L'ombra passa da un byte per tratto: mezzo punto percentuale e' gia'
          // molto piu' della quantizzazione.
          assert.ok(
            Math.abs(avuto.shade_pct - atteso.shade_pct) <= 0.2,
            `${dove}: ${avuto.shade_pct}% di ombra invece di ${atteso.shade_pct}%`,
          )
          assert.ok(
            Math.abs(avuto.sun_dose_min - atteso.sun_dose_min) <=
              0.02 * Math.max(1, atteso.sun_dose_min),
            `${dove}: dose ${avuto.sun_dose_min} invece di ${atteso.sun_dose_min}`,
          )
          if (atteso.avg_traffic_index !== undefined) {
            assert.ok(
              Math.abs(avuto.avg_traffic_index - atteso.avg_traffic_index) <= 0.01,
              `${dove}: indice traffico ${avuto.avg_traffic_index} invece di ${atteso.avg_traffic_index}`,
            )
          }
        }
      }
    } finally {
      globalThis.fetch = fetchOriginale
    }
  },
)

test(
  'beta=0 e\' un no-op: stesso risultato che ometterlo del tutto',
  { skip: !disponibile && 'area non esportata' },
  async () => {
    const area = await apriLocale('ascoli-piceno')
    const richiesta = {
      partenza: { lon: 13.5744, lat: 42.8542 },
      arrivo: { lon: 13.5801, lat: 42.8556 },
      modalita: 'foot' as const,
      quando: new Date('2026-07-30T11:40:00Z'),
      preferenzaOmbra: 0.6,
    }

    const omesso = await area.percorso(richiesta)
    const esplicito = await area.percorso({ ...richiesta, preferenzaTraffico: 0 })

    assert.deepEqual(
      omesso.shaded.coordinates,
      esplicito.shaded.coordinates,
      'preferenzaTraffico omessa vs 0 esplicito: stessa strada',
    )
    assert.equal(omesso.shaded.duration_min, esplicito.shaded.duration_min)
    assert.equal(omesso.shaded.avg_traffic_index, esplicito.shaded.avg_traffic_index)
  },
)
