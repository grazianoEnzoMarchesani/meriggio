/**
 * Quello che prima era il client dell'API.
 *
 * Le firme sono rimaste quelle di `api.ts`, perche' i componenti non hanno
 * motivo di sapere che dall'altra parte non c'e' piu' un server: chiedono un
 * percorso e ne ricevono uno. Cambia solo da dove arriva.
 *
 * La divisione del lavoro e' questa: qui sul filo dell'interfaccia restano le
 * cose che costano niente e servono subito (l'elenco delle aree, la posizione
 * del sole, alba e tramonto), mentre grafo, tasselli, ombre e Dijkstra stanno
 * nel worker. L'unica cosa che continua a passare dalla rete e' la ricerca
 * degli indirizzi, che e' un servizio di OpenStreetMap e non nostro.
 */

import type { Risultato } from '../ombra/area.ts'
import type { Modalita } from '../ombra/graph.ts'
import { giornoLocale, istanteLocale, mezzanotteLocale, oraLocale } from '../ombra/fusi.ts'
import type { QuattroAngoli } from '../ombra/overlay.ts'
import { solarLoad, solarPosition, sunTimes } from '../ombra/solar.ts'
import type { Manifesto, VoceIndice } from '../ombra/area.ts'
import type { Domanda } from '../ombra/worker.ts'

export type { Modalita }
export type { Percorso, Segmento } from '../ombra/router.ts'
export type { QuattroAngoli }

/** Dove stanno i dati esportati, rispetto alla radice del sito. */
const RADICE = `${import.meta.env.BASE_URL}dati/`

/**
 * Lo stesso indirizzo in forma assoluta.
 *
 * Serve al worker, che risolve i percorsi dei file con `new URL(x, base)`: la
 * base dev'essere un indirizzo completo, e `/ombra/dati/` da solo non lo e'.
 */
const RADICE_ASSOLUTA = new URL(RADICE, location.href).toString()

export interface Area {
  slug: string
  name: string
  bounds: [number, number, number, number]
  center: [number, number]
  size_km: [number, number]
  timezone: string
  url: string
}

export interface DettaglioArea extends Area {
  day: string
  sunrise: string | null
  sunset: string | null
  solar_noon: string
  max_elevation: number
  /** null se l'area non ha l'asse traffico (oggi solo Ascoli Piceno lo ha). */
  traffic: Manifesto['traffic']
}

export interface Sole {
  instant: string
  elevation: number
  azimuth: number
  solar_load: number
  is_daylight: boolean
}

export interface Ombre {
  larghezza: number
  altezza: number
  pixel: Uint8ClampedArray<ArrayBuffer>
  angoli: QuattroAngoli
  elevation: number
  azimuth: number
}

export interface ReteTraffico {
  nodeLon: Float32Array
  nodeLat: Float32Array
  edgeU: Int32Array
  edgeV: Int32Array
  valori: Float32Array
}

export interface Luogo {
  name: string
  full_name: string
  lon: number
  lat: number
  in_area: boolean
}

export class ErroreMotore extends Error {}

// ---------------------------------------------------------------------------
// Il worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let prossimoId = 1
const inAttesa = new Map<number, { risolvi: (v: unknown) => void; rifiuta: (e: Error) => void }>()

function avvia(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../ombra/worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; esito?: unknown; errore?: string }>) => {
    const attesa = inAttesa.get(e.data.id)
    if (!attesa) return
    inAttesa.delete(e.data.id)
    if (e.data.errore) attesa.rifiuta(new ErroreMotore(e.data.errore))
    else attesa.risolvi(e.data.esito)
  }
  return worker
}

/** `Omit` su un'unione va distribuito, altrimenti resta solo cio' che i rami hanno in comune. */
type SenzaId<T> = T extends unknown ? Omit<T, 'id'> : never

function chiedi<T>(d: SenzaId<Domanda>): Promise<T> {
  const w = avvia()
  const id = prossimoId++
  return new Promise<T>((risolvi, rifiuta) => {
    inAttesa.set(id, { risolvi: risolvi as (v: unknown) => void, rifiuta })
    w.postMessage({ ...d, id })
  })
}

// ---------------------------------------------------------------------------
// Aree
// ---------------------------------------------------------------------------

let manifesti = new Map<string, Manifesto>()

async function manifesto(slug: string): Promise<Manifesto> {
  let m = manifesti.get(slug)
  if (!m) {
    const res = await fetch(`${RADICE}${slug}/manifest.json`)
    if (!res.ok) throw new ErroreMotore(`area '${slug}' non disponibile`)
    m = (await res.json()) as Manifesto
    manifesti.set(slug, m)
  }
  return m
}

export const motore = {
  /** Le aree disponibili, dall'indice scritto dall'esportazione. */
  async aree(): Promise<Area[]> {
    const res = await fetch(`${RADICE}aree.json`)
    if (!res.ok) throw new ErroreMotore('elenco delle aree non disponibile')
    return (await res.json()) as VoceIndice[]
  },

  /** Dettagli di un'area, con alba e tramonto del giorno richiesto. */
  async area(slug: string, giorno?: string): Promise<DettaglioArea> {
    const m = await manifesto(slug)
    const [lon, lat] = m.center
    const quando = giorno
      ? istanteLocale(m.timezone, ...(giorno.split('-').map(Number) as [number, number, number]), 12)
      : new Date()
    const mezzanotte = mezzanotteLocale(quando, m.timezone)
    const t = sunTimes(lat, lon, mezzanotte)
    return {
      slug: m.slug,
      name: m.name,
      bounds: m.bounds,
      center: m.center,
      size_km: m.size_km,
      timezone: m.timezone,
      url: `${slug}/manifest.json`,
      day: giornoLocale(quando, m.timezone),
      sunrise: t.sunrise ? t.sunrise.toISOString() : null,
      sunset: t.sunset ? t.sunset.toISOString() : null,
      solar_noon: t.solarNoon.toISOString(),
      max_elevation: Math.round(t.maxElevation * 10) / 10,
      traffic: m.traffic,
    }
  },

  /** Il fuso orario di un'area, gia' scaricato. */
  fuso(slug: string): string {
    return manifesti.get(slug)?.timezone ?? 'Europe/Rome'
  },

  /**
   * Costruisce l'istante assoluto corrispondente a un giorno e a un'ora
   * dell'orologio dell'area.
   */
  istante(slug: string, giorno: string, minuti: number): Date {
    const [a, m, g] = giorno.split('-').map(Number)
    return istanteLocale(this.fuso(slug), a, m, g, Math.floor(minuti / 60), Math.round(minuti % 60))
  },

  /** Che ora e' adesso nell'area, in minuti dalla mezzanotte. */
  adesso(slug: string): { giorno: string; minuti: number } {
    const fuso = this.fuso(slug)
    const ora = new Date()
    const l = oraLocale(ora, fuso)
    return { giorno: giornoLocale(ora, fuso), minuti: l.ore * 60 + l.minuti }
  },

  /** Posizione del sole e carico radiativo a un istante. */
  async sole(slug: string, istante: Date): Promise<Sole> {
    const m = await manifesto(slug)
    const [lon, lat] = m.center
    const p = solarPosition(lat, lon, istante)
    return {
      instant: istante.toISOString(),
      elevation: Math.round(p.elevation * 100) / 100,
      azimuth: Math.round(p.azimuth * 100) / 100,
      solar_load: Math.round(solarLoad(p.elevation) * 1000) / 1000,
      is_daylight: p.elevation > 0,
    }
  },

  /** Gli edifici da estrudere sulla mappa: un file statico, come prima. */
  edificiUrl(slug: string): string {
    return `${RADICE}${slug}/buildings.geojson`
  },

  /**
   * Sorgente `raster-dem` del rilievo, se l'area l'ha esportato.
   *
   * Il manifesto porta gia' il template dei tasselli (`terrain/{z}/{x}/{y}.png`,
   * relativo alla cartella dell'area): qui si aggiunge solo la radice del sito.
   */
  async terreno(slug: string): Promise<{
    tiles: string[]
    tileSize: number
    minzoom: number
    maxzoom: number
    encoding: 'terrarium' | 'mapbox'
  } | null> {
    const m = await manifesto(slug)
    if (!m.terrain) return null
    return {
      tiles: [`${RADICE}${slug}/${m.terrain.tiles}`],
      tileSize: m.terrain.tile_size,
      minzoom: m.terrain.minzoom,
      maxzoom: m.terrain.maxzoom,
      encoding: m.terrain.encoding as 'terrarium' | 'mapbox',
    }
  },

  /** Prepara il worker con l'area scelta: scarica manifesto e grafo. */
  async preparaArea(slug: string): Promise<void> {
    await manifesto(slug)
    await chiedi<{ pronta: boolean }>({ tipo: 'apri', base: `${RADICE_ASSOLUTA}${slug}/` })
  },

  /** Le ombre di un istante, come immagine da sovrapporre alla mappa. */
  ombre(
    bounds: [number, number, number, number],
    istante: Date,
    latoMax = 1400,
  ): Promise<Ombre | null> {
    return chiedi<Ombre | null>({
      tipo: 'ombre',
      bounds,
      quando: istante.getTime(),
      latoMax,
    })
  },

  /** Il percorso piu' fresco e quello piu' rapido. */
  percorso(richiesta: {
    partenza: { lon: number; lat: number }
    arrivo: { lon: number; lat: number }
    modalita: Modalita
    istante: Date
    preferenzaOmbra: number
    preferenzaTraffico: number
  }): Promise<Risultato> {
    return chiedi<Risultato>({
      tipo: 'percorso',
      partenza: richiesta.partenza,
      arrivo: richiesta.arrivo,
      modalita: richiesta.modalita,
      quando: richiesta.istante.getTime(),
      preferenzaOmbra: richiesta.preferenzaOmbra,
      preferenzaTraffico: richiesta.preferenzaTraffico,
    })
  },

  /**
   * Grado di traffico atteso all'istante indicato, mediato su tutta l'area
   * aperta nel worker. `null` se l'area non porta l'asse traffico (oggi solo
   * Ascoli Piceno) o se a quell'ora nessun tratto ha un dato sopra zero.
   */
  livelloTraffico(istante: Date): Promise<{ indice: number; copertura: number } | null> {
    return chiedi<{ indice: number; copertura: number } | null>({
      tipo: 'traffico',
      quando: istante.getTime(),
    })
  },

  /**
   * Geometria e indice di traffico di tutti i tratti dell'area, per lo
   * strato opzionale sulla mappa (a differenza di `livelloTraffico`, un
   * solo numero riassuntivo). `null` se l'area non porta l'asse traffico.
   */
  reteTraffico(istante: Date): Promise<ReteTraffico | null> {
    return chiedi<ReteTraffico | null>({
      tipo: 'rete-traffico',
      quando: istante.getTime(),
    })
  },

  /**
   * Ricerca di indirizzi e luoghi.
   *
   * E' l'unica cosa che esce ancora in rete verso un servizio: Nominatim di
   * OpenStreetMap, interrogato direttamente dal browser. Se non risponde,
   * restano il clic sulla mappa e il pulsante della posizione.
   */
  async cerca(q: string, slug: string, signal?: AbortSignal): Promise<Luogo[]> {
    const m = await manifesto(slug)
    const [lon0, lat0, lon1, lat1] = m.bounds
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=it' +
      `&q=${encodeURIComponent(q)}` +
      // Il riquadro non esclude, ordina: i risultati dentro l'area vengono
      // prima, gli altri restano visibili ma segnalati.
      `&viewbox=${lon0},${lat1},${lon1},${lat0}`
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new ErroreMotore('ricerca non disponibile')
    const grezzi = (await res.json()) as {
      display_name: string
      name?: string
      lon: string
      lat: string
    }[]
    const luoghi = grezzi.map((r) => {
      const lon = Number(r.lon)
      const lat = Number(r.lat)
      return {
        name: r.name || r.display_name.split(',')[0],
        full_name: r.display_name,
        lon,
        lat,
        in_area: lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1,
      }
    })
    return [...luoghi.filter((l) => l.in_area), ...luoghi.filter((l) => !l.in_area)]
  },
}

export type RisultatoPercorso = Risultato
