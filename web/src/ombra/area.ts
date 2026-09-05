/**
 * Un'area preparata, con tutto quello che serve a calcolarci sopra un percorso.
 *
 * Prende il posto di `api.py`: le stesse domande, ma le risposte non arrivano
 * piu' da un server. Il manifesto e il grafo si scaricano una volta all'apertura
 * della citta' (qualche centinaio di kilobyte, che poi restano in cache); i
 * tasselli della superficie si scaricano solo quando un tragitto li attraversa,
 * e restano anche loro.
 *
 * Da dove arrivino i byte non e' affar suo: glieli passa una `Sorgente`, che
 * nel browser e' una `fetch` e nei collaudi una lettura da disco.
 */

import { leggiEdifici, type Edificio } from './edifici.ts'
import { leggiGrafo, type Grafo, type Modalita } from './graph.ts'
import { giornoLocale, mezzanotteLocale, minutiDelGiorno } from './fusi.ts'
import { esposizioneCorridoio, marginiSole, portataOmbra } from './live.ts'
import { disegnaOmbre, type Ombre } from './overlay.ts'
import {
  calcolaPercorso,
  trafficoAggregato,
  trafficoRiga,
  type Percorso,
  type RisultatoPercorso,
} from './router.ts'
import { canopyTransmissivity } from './shadow.ts'
import { solarLoad, solarPosition, sunTimes, type OrariSole } from './solar.ts'
import {
  componiSuperficie,
  decodificaTassello,
  riquadroPixel,
  superficieDaVeduta,
  tasselliDi,
  type GrigliaSuperficie,
  type Superficie,
  type Tassello,
  type TasselloDecodificato,
} from './tiles.ts'
import { fattoreVento } from './traffico.ts'
import { fusoDaEpsg, versoGradi, versoUtm, type Fuso } from './utm.ts'
import { ventoCorrente } from './vento.ts'

export interface Manifesto {
  version: number
  slug: string
  name: string
  bounds: [number, number, number, number]
  center: [number, number]
  size_km: [number, number]
  timezone: string
  utm_epsg: number
  resolution: number
  segment_length: number
  step_minutes: number
  buffer_m: number
  surface: GrigliaSuperficie
  graph: { url: string; bytes: number; nodes: number; edges: number; names: string[] }
  buildings: { url: string; bytes: number } | null
  terrain: {
    tiles: string
    encoding: string
    tile_size: number
    minzoom: number
    maxzoom: number
  } | null
  /**
   * Riepilogo della calibrazione traffico (`traffico.calibra`), presente
   * solo per le aree che hanno un CSV PUMS -- oggi solo Ascoli Piceno.
   * Nessun campo booleano separato tipo `hasTraffic`: la UI (Fase 6) usa
   * questo stesso `null` per nascondere/disabilitare lo slider traffico.
   */
  traffic: {
    wind_typical: { speed_ms: number; direction_deg: number | null; source: string }
    normalization_reference: number
    matched_edges: number
    fallback_edges: number
    unmatched_edges: number
  } | null
}

export interface VoceIndice {
  slug: string
  name: string
  bounds: [number, number, number, number]
  center: [number, number]
  size_km: [number, number]
  timezone: string
  url: string
}

/** Restituisce il contenuto di un file dell'area, gia' decompresso. */
export type Sorgente = (percorso: string) => Promise<Uint8Array>

export interface RichiestaPercorso {
  partenza: { lon: number; lat: number }
  arrivo: { lon: number; lat: number }
  modalita: Modalita
  /** istante di partenza; l'ora e' quella dell'orologio dell'area */
  quando: Date
  /** 0 = il piu' rapido, 1 = la massima ombra */
  preferenzaOmbra: number
  /**
   * 0 = nessuna deviazione per il traffico, 1 = massima. Ignorata se l'area
   * non porta l'asse traffico (`manifesto.traffic === null`): resta 0, come
   * un'area v1 senza `edgeTraffic`. Opzionale per non rompere i chiamanti
   * che non conoscono ancora questo asse (default 0 dentro `percorso()`).
   */
  preferenzaTraffico?: number
}

/** Quanto puo' pesare al massimo l'avversione al sole nel costo di un tratto. */
export const ALPHA_MAX = 5.0
/**
 * Quanto puo' pesare al massimo l'avversione al traffico nel costo di un
 * tratto. Stesso ordine di grandezza di `ALPHA_MAX`: dopo la normalizzazione
 * in `traffico.calibra` (Fase 1), `edgeTraffic` vive nella stessa scala
 * [0, 1] di `esposizione`, quindi i due slider hanno la stessa "portata" sul
 * costo -- una scelta simmetrica, non misurata (Fase 9 del piano la
 * lasciava aperta).
 */
export const BETA_MAX = 5.0

export class Area {
  readonly manifesto: Manifesto
  readonly grafo: Grafo
  readonly fuso: Fuso
  private sorgente: Sorgente
  private tasselli = new Map<string, TasselloDecodificato>()
  private veduta: TasselloDecodificato | null = null
  private edifici: Promise<Edificio[]> | null = null

  private constructor(manifesto: Manifesto, grafo: Grafo, sorgente: Sorgente) {
    this.manifesto = manifesto
    this.grafo = grafo
    this.sorgente = sorgente
    this.fuso = fusoDaEpsg(manifesto.utm_epsg)
  }

  /** Scarica manifesto e grafo di un'area e la rende pronta al calcolo. */
  static async apri(sorgente: Sorgente): Promise<Area> {
    const manifesto: Manifesto = JSON.parse(
      new TextDecoder().decode(await sorgente('manifest.json')),
    )
    const grafo = leggiGrafo(await sorgente(manifesto.graph.url), manifesto.graph.names)
    return new Area(manifesto, grafo, sorgente)
  }

  get slug(): string {
    return this.manifesto.slug
  }

  get fusoOrario(): string {
    return this.manifesto.timezone
  }

  /** Quanti tasselli sono gia' in memoria, sui totali dell'area. */
  get tasselliInMemoria(): { presenti: number; totali: number } {
    return { presenti: this.tasselli.size, totali: this.manifesto.surface.tiles.length }
  }

  /** Da gradi a metri UTM dell'area. */
  utm(lon: number, lat: number): [number, number] {
    return versoUtm(lon, lat, this.fuso)
  }

  /** Posizione del sole e carico radiativo a un istante. */
  sole(quando: Date): {
    elevation: number
    azimuth: number
    solar_load: number
    is_daylight: boolean
  } {
    const [lon, lat] = this.manifesto.center
    const p = solarPosition(lat, lon, quando)
    return {
      ...p,
      solar_load: solarLoad(p.elevation),
      is_daylight: p.elevation > 0,
    }
  }

  /** Alba, tramonto e mezzogiorno solare del giorno in cui cade un istante. */
  orariSole(quando: Date): OrariSole & { giorno: string } {
    const [lon, lat] = this.manifesto.center
    const mezzanotte = mezzanotteLocale(quando, this.fusoOrario)
    return {
      ...sunTimes(lat, lon, mezzanotte),
      giorno: giornoLocale(quando, this.fusoOrario),
    }
  }

  /** Scarica i tasselli che mancano e restituisce quelli richiesti. */
  async caricaTasselli(richiesti: Tassello[]): Promise<Map<string, TasselloDecodificato>> {
    const mancanti = richiesti.filter((t) => !this.tasselli.has(t.url))
    // In parallelo: sono richieste indipendenti, e su rete mobile la latenza
    // pesa piu' della banda.
    await Promise.all(
      mancanti.map(async (t) => {
        this.tasselli.set(t.url, decodificaTassello(await this.sorgente(t.url)))
      }),
    )
    const out = new Map<string, TasselloDecodificato>()
    for (const t of richiesti) out.set(t.url, this.tasselli.get(t.url) as TasselloDecodificato)
    return out
  }

  /**
   * Le impronte degli edifici in UTM, scaricate una volta sola.
   *
   * E' lo stesso file che la mappa carica per le estrusioni, quindi la seconda
   * richiesta la serve la cache del browser. La promessa si tiene com'e': due
   * disegni ravvicinati non devono scaricarlo due volte.
   */
  private impronte(): Promise<Edificio[]> {
    if (this.edifici) return this.edifici
    const voce = this.manifesto.buildings
    this.edifici = voce
      ? this.sorgente(voce.url).then((b) => leggiEdifici(b, this.fuso))
      : Promise.resolve([])
    return this.edifici
  }

  /**
   * Le ombre di un istante come immagine da sovrapporre alla mappa.
   *
   * Il riquadro chiesto e' quello che si vede: se sta dentro pochi tasselli si
   * usa la superficie a piena risoluzione, se invece si sta guardando tutta la
   * citta' si usa la veduta d'insieme. Non e' solo una questione di velocita':
   * a quello zoom un pixel dello schermo vale una ventina di metri, e scaricare
   * quattro megabyte di tasselli per mostrare un dettaglio che non si vede
   * sarebbe uno spreco di rete pagato dall'utente.
   */
  async ombre(r: {
    bounds: [number, number, number, number]
    quando: Date
    latoMax?: number
  }): Promise<Ombre | null> {
    const latoMax = r.latoMax ?? 1400
    const griglia = this.manifesto.surface
    const { elevation, azimuth } = this.sole(r.quando)

    // Riquadro da coprire, ristretto a quello che l'area conosce davvero.
    const [ax0, ay0, ax1, ay1] = this.riquadroSuperficieGradi()
    const bounds: [number, number, number, number] = [
      Math.max(r.bounds[0], ax0),
      Math.max(r.bounds[1], ay0),
      Math.min(r.bounds[2], ax1),
      Math.min(r.bounds[3], ay1),
    ]
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return null
    if (elevation <= 0) {
      // Di notte non c'e' nulla da disegnare: l'ombra e' ovunque, che sulla
      // mappa vorrebbe dire una lastra uniforme senza informazione.
      return null
    }

    // La cornice da cui arrivano gli ostacoli che fanno ombra dentro il
    // riquadro, come per il routing.
    const portata = portataOmbra(elevation)
    const [ovest, sud, est, nord] = marginiSole([{ elevation, azimuth }])
    const angoli = [
      this.utm(bounds[0], bounds[1]), this.utm(bounds[2], bounds[1]),
      this.utm(bounds[0], bounds[3]), this.utm(bounds[2], bounds[3]),
    ]
    const xs = angoli.map((p) => p[0])
    const ys = angoli.map((p) => p[1])
    const rettangolo: [number, number, number, number] = [
      Math.min(...xs) - ovest,
      Math.min(...ys) - sud,
      Math.max(...xs) + est,
      Math.max(...ys) + nord,
    ]

    // Quanti metri di terreno per pixel di schermo: sotto la risoluzione dei
    // tasselli non ha senso scendere, sopra quella della veduta non ha senso
    // scaricare.
    const larghezzaM = Math.max(...xs) - Math.min(...xs)
    const altezzaM = Math.max(...ys) - Math.min(...ys)
    const perPixel = Math.max(larghezzaM, altezzaM) / latoMax
    const usaVeduta = perPixel >= griglia.overview.resolution

    // Le impronte partono insieme alla superficie: sono due richieste
    // indipendenti, e aspettarle in fila raddoppierebbe l'attesa del primo
    // disegno.
    const impronte = this.impronte()

    let superficie: Superficie | null
    if (usaVeduta) {
      const veduta = await this.vedutaInsieme()
      const rq = riquadroPixel(
        { ...griglia, resolution: griglia.overview.resolution,
          width: griglia.overview.width, height: griglia.overview.height },
        ...rettangolo,
      )
      superficie = rq && superficieDaVeduta(griglia, veduta, rq, canopyTransmissivity)
    } else {
      const rq = riquadroPixel(griglia, ...rettangolo)
      if (rq === null) return null
      const decodificati = await this.caricaTasselli(tasselliDi(griglia, rq))
      superficie = componiSuperficie(griglia, rq, decodificati, canopyTransmissivity)
    }
    if (superficie === null) return null

    return disegnaOmbre(
      superficie, this.fuso, bounds, azimuth, elevation, latoMax, portata,
      await impronte,
    )
  }

  /** Riquadro coperto dalla superficie, in gradi. */
  private riquadroSuperficieGradi(): [number, number, number, number] {
    const g = this.manifesto.surface
    const [ox, oy] = g.origin
    const x1 = ox + g.width * g.resolution
    const y0 = oy - g.height * g.resolution
    const a = versoGradi(ox, y0, this.fuso)
    const b = versoGradi(x1, y0, this.fuso)
    const c = versoGradi(ox, oy, this.fuso)
    const d = versoGradi(x1, oy, this.fuso)
    return [
      Math.max(a[0], c[0]),
      Math.max(a[1], b[1]),
      Math.min(b[0], d[0]),
      Math.min(c[1], d[1]),
    ]
  }

  /** La veduta d'insieme, scaricata alla prima richiesta e poi tenuta. */
  private async vedutaInsieme(): Promise<TasselloDecodificato> {
    if (!this.veduta) {
      this.veduta = decodificaTassello(
        await this.sorgente(this.manifesto.surface.overview.url),
      )
    }
    return this.veduta
  }

  /**
   * Calcola il percorso piu' fresco e quello piu' rapido per confronto.
   *
   * E' l'equivalente di `POST /api/percorso`, senza il POST.
   */
  async percorso(r: RichiestaPercorso): Promise<Risultato> {
    const mezzanotte = mezzanotteLocale(r.quando, this.fusoOrario)
    const minutoPartenza = minutiDelGiorno(r.quando, this.fusoOrario)

    const beta = Math.min(1, Math.max(0, r.preferenzaTraffico ?? 0)) * BETA_MAX
    // Il raffinamento vento live serve solo se lo slider traffico ha un
    // effetto reale: risparmia una richiesta di rete quando beta=0 (il
    // fattore verrebbe comunque moltiplicato per zero nel router).
    let fv = 1.0
    if (beta > 0 && this.manifesto.traffic) {
      const [lon, lat] = this.manifesto.center
      const ventoLive = await ventoCorrente(lon, lat).catch(() => undefined)
      fv = fattoreVento(this.manifesto.traffic.wind_typical, ventoLive)
    }

    const risultato = await calcolaPercorso({
      grafo: this.grafo,
      // Le ombre si calcolano dentro la richiesta, ma solo sul corridoio del
      // tragitto e sui minuti in cui lo si percorre: il router le chiede
      // quando sa da dove passare e per quanto.
      esposizione: async (corridoio, durata) =>
        (
          await esposizioneCorridoio({
            grafo: this.grafo,
            griglia: this.manifesto.surface,
            centro: this.manifesto.center,
            passoMinuti: this.manifesto.step_minutes,
            corridoioXY: corridoio,
            quando: r.quando,
            mezzanotte,
            durataMin: durata,
            tasselli: (t) => this.caricaTasselli(t),
          })
        ).esposizione,
      origineUtm: this.utm(r.partenza.lon, r.partenza.lat),
      destinazioneUtm: this.utm(r.arrivo.lon, r.arrivo.lat),
      mode: r.modalita,
      minutoPartenza,
      alpha: Math.min(1, Math.max(0, r.preferenzaOmbra)) * ALPHA_MAX,
      beta,
      fattoreVento: fv,
    })

    // Posizione del sole alla partenza e all'arrivo: e' il modo piu' diretto
    // per mostrare che il sole si e' spostato durante il tragitto.
    const [lon, lat] = this.manifesto.center
    const partenza = solarPosition(lat, lon, r.quando)
    const completo = (p: Percorso) => {
      const arrivo = new Date(mezzanotte.getTime() + p.arrival_minute * 60_000)
      return {
        ...p,
        arrival_instant: arrivo.toISOString(),
        sun_start: {
          elevation: Math.round(partenza.elevation * 10) / 10,
          azimuth: Math.round(partenza.azimuth * 10) / 10,
        },
        sun_end: (({ elevation, azimuth }) => ({
          elevation: Math.round(elevation * 10) / 10,
          azimuth: Math.round(azimuth * 10) / 10,
        }))(solarPosition(lat, lon, arrivo)),
      }
    }

    return {
      ...risultato,
      departure_instant: r.quando.toISOString(),
      shaded: completo(risultato.shaded),
      fastest: completo(risultato.fastest),
    }
  }

  /**
   * Grado di traffico atteso all'istante indicato, mediato su tutta l'area:
   * un indicatore generale per la Timeline, non il costo di un percorso
   * specifico -- quello resta dentro `percorso()`. `null` se l'area non
   * porta l'asse traffico (stesso gate dello slider in Panel).
   */
  livelloTraffico(quando: Date): { indice: number; copertura: number } | null {
    if (!this.manifesto.traffic) return null
    const minuto = minutiDelGiorno(quando, this.fusoOrario)
    return trafficoAggregato(this.grafo, minuto)
  }

  /**
   * Geometria e indice di traffico di ogni tratto dell'area all'istante
   * indicato -- per lo strato opzionale sulla mappa che mostra tutta la
   * rete, non un solo numero riassuntivo (quello resta `livelloTraffico`).
   * `null` se l'area non porta l'asse traffico.
   *
   * Le coordinate dei nodi sono quelle intere del grafo (condivise da tutti
   * i tratti, `edgeU`/`edgeV` vi puntano per indice): tornano per valore,
   * mai per trasferimento, perche' lo stesso `Grafo` resta in uso nel
   * worker per i percorsi successivi.
   */
  reteTraffico(
    quando: Date,
  ): { nodeLon: Float32Array; nodeLat: Float32Array; edgeU: Int32Array; edgeV: Int32Array; valori: Float32Array } | null {
    if (!this.manifesto.traffic) return null
    const minuto = minutiDelGiorno(quando, this.fusoOrario)
    return {
      nodeLon: this.grafo.nodeLon,
      nodeLat: this.grafo.nodeLat,
      edgeU: this.grafo.edgeU,
      edgeV: this.grafo.edgeV,
      valori: trafficoRiga(this.grafo, minuto),
    }
  }
}

export interface PercorsoCompleto extends Percorso {
  arrival_instant: string
  sun_start: { elevation: number; azimuth: number }
  sun_end: { elevation: number; azimuth: number }
}

export interface Risultato extends Omit<RisultatoPercorso, 'shaded' | 'fastest'> {
  departure_instant: string
  shaded: PercorsoCompleto
  fastest: PercorsoCompleto
}
