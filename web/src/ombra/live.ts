/**
 * Ombre calcolate al momento, sul solo pezzo di citta' e di giornata che serve.
 *
 * Traduzione di `live.py`, con una differenza di sostanza: la' il ritaglio
 * serviva a non calcolare l'ombra su tutta la citta', qui serve a non
 * *scaricare* tutta la citta'. Il calcolo vero e proprio e' diventato quasi
 * gratuito perche' avviene solo nei punti in cui il grafo chiede l'ombra
 * (`shadow.sunFactorPoints`), mentre il costo che resta e' la rete: i tasselli
 * che coprono il corridoio sono qualche centinaio di kilobyte, tutta Ascoli
 * sarebbe quattro megabyte e mezzo.
 *
 * Il ritaglio non e' gratuito in accuratezza, perche' l'ombra che cade dentro
 * un riquadro spesso e' proiettata da fuori. Due accorgimenti lo riportano a
 * coincidere con il calcolo su tutta l'area:
 *
 *   - il riquadro segue il percorso piu' rapido, non la congiungente fra
 *     partenza e arrivo, e viene allargato per lasciare spazio alle deviazioni
 *     in ombra che il router potrebbe preferire;
 *   - viene aggiunta una cornice sui soli lati da cui arriva il sole, dove
 *     stanno gli edifici e i versanti che fanno ombra dentro il riquadro. Sugli
 *     altri lati non serve nulla: l'ombra non risale mai verso il sole, e
 *     allargare anche li' quadruplicherebbe la spesa senza cambiare un pixel.
 */

import { Esposizione } from './exposure.ts'
import type { Grafo } from './graph.ts'
import { MAX_TRIP_MINUTES } from './router.ts'
import { canopyTransmissivity, sunFactorPoints } from './shadow.ts'
import { solarPosition } from './solar.ts'
import {
  componiSuperficie,
  riquadroPixel,
  tasselliDi,
  type GrigliaSuperficie,
  type Superficie,
  type Tassello,
  type TasselloDecodificato,
} from './tiles.ts'

/**
 * Quanto allargare il riquadro attorno al percorso piu' rapido. Il router puo'
 * deviare per restare in ombra, e una deviazione che uscisse dal ritaglio
 * verrebbe valutata come se fosse in pieno sole: si perderebbe proprio la
 * scorciatoia ombrosa che l'utente sta cercando.
 *
 * Il margine e' tarato su quanto le deviazioni si allontanano davvero: su 1821
 * percorsi ombreggiati di Ascoli lo scarto dal riquadro del percorso piu'
 * rapido e' zero nella meta' dei casi, 87 m al novantesimo percentile e 319 m
 * al novantanovesimo.
 */
export const CORRIDOR_MARGIN_FRACTION = 0.15
export const CORRIDOR_MARGIN_MIN = 250.0
export const CORRIDOR_MARGIN_MAX = 500.0

/**
 * Altezza di riferimento degli ostacoli appena fuori dal ritaglio, usata per
 * stimare quanto lontano puo' arrivare la loro ombra. Sessanta metri coprono
 * con abbondanza edifici e alberi; i versanti sono piu' alti, ma la loro ombra
 * conta solo con il sole radente, quando il carico radiativo e' ormai quasi
 * nullo e sbagliarla non sposta la scelta del percorso.
 */
const OCCLUDER_HEIGHT = 60.0
const SHADOW_REACH_MIN = 100.0
/**
 * Oltre questa distanza l'ombra non viene inseguita: e' lo stesso margine con
 * cui viene costruita la superficie attorno all'area.
 */
const SHADOW_REACH_MAX = 600.0

/**
 * Per quanto tempo calcolare le ombre, in rapporto alla durata del percorso
 * piu' rapido: quello in ombra puo' allungarsi, e oltre l'ultimo istante
 * calcolato il sole resterebbe fermo dov'era.
 */
const TRIP_TIME_FACTOR = 1.5
const TRIP_TIME_EXTRA = 10.0

/** Fin dove arriva l'ombra di un ostacolo di riferimento, in metri. */
export function portataOmbra(elevazione: number): number {
  if (elevazione <= 0.0) return SHADOW_REACH_MIN
  const portata = OCCLUDER_HEIGHT / Math.tan((elevazione * Math.PI) / 180)
  return Math.min(SHADOW_REACH_MAX, Math.max(SHADOW_REACH_MIN, portata))
}

/**
 * Cornice da aggiungere su ovest, sud, est e nord, in metri.
 *
 * L'azimut e' contato da nord in senso orario, quindi la componente verso est
 * del raggio solare e' il suo seno e quella verso nord il coseno: il lato da
 * allargare e' quello da cui il sole arriva. Si prende il caso peggiore fra
 * tutti gli istanti, perche' il ritaglio e' uno solo per tutto il tragitto
 * mentre il sole nel frattempo si sposta.
 */
export function marginiSole(
  posizioni: { elevation: number; azimuth: number }[],
): [number, number, number, number] {
  let ovest = 0
  let sud = 0
  let est = 0
  let nord = 0
  for (const { elevation, azimuth } of posizioni) {
    if (elevation <= 0.0) continue
    const portata = portataOmbra(elevation)
    const a = (azimuth * Math.PI) / 180
    const sin = Math.sin(a)
    const cos = Math.cos(a)
    if (sin > 0) est = Math.max(est, portata)
    if (sin < 0) ovest = Math.max(ovest, portata)
    if (cos > 0) nord = Math.max(nord, portata)
    if (cos < 0) sud = Math.max(sud, portata)
  }
  return [ovest, sud, est, nord]
}

/** Riquadro UTM attorno a un percorso, allargato per le deviazioni. */
export function riquadroCorridoio(
  puntiXY: Float64Array,
  margine?: number,
): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 0; i < puntiXY.length; i += 2) {
    if (puntiXY[i] < x0) x0 = puntiXY[i]
    if (puntiXY[i] > x1) x1 = puntiXY[i]
    if (puntiXY[i + 1] < y0) y0 = puntiXY[i + 1]
    if (puntiXY[i + 1] > y1) y1 = puntiXY[i + 1]
  }
  const m =
    margine ??
    Math.min(
      CORRIDOR_MARGIN_MAX,
      Math.max(CORRIDOR_MARGIN_MIN, CORRIDOR_MARGIN_FRACTION * Math.hypot(x1 - x0, y1 - y0)),
    )
  return [x0 - m, y0 - m, x1 + m, y1 + m]
}

/** Istanti da calcolare per un tragitto che parte a `quando`. */
export function istanti(quando: Date, durataMin: number, passoMin: number): Date[] {
  const durata = Math.min(durataMin * TRIP_TIME_FACTOR + TRIP_TIME_EXTRA, MAX_TRIP_MINUTES)
  // Almeno due istanti: con uno solo non ci sarebbe nulla fra cui interpolare.
  const n = Math.max(2, Math.ceil(durata / passoMin) + 1)
  const out: Date[] = []
  for (let i = 0; i < n; i++) out.push(new Date(quando.getTime() + i * passoMin * 60_000))
  return out
}

export interface RichiestaEsposizione {
  grafo: Grafo
  griglia: GrigliaSuperficie
  /** centro dell'area in gradi, per la posizione del sole */
  centro: [number, number]
  passoMinuti: number
  corridoioXY: Float64Array
  quando: Date
  /** mezzanotte locale del giorno di partenza, da cui si contano i minuti */
  mezzanotte: Date
  durataMin: number
  /** scarica e decodifica i tasselli richiesti */
  tasselli: (richiesti: Tassello[]) => Promise<Map<string, TasselloDecodificato>>
  registra?: (messaggio: string) => void
}

export interface EsposizioneCalcolata {
  esposizione: Esposizione
  /** la superficie usata, utile a chi vuole disegnare le stesse ombre */
  superficie: Superficie | null
  istanti: Date[]
}

/**
 * Esposizione dei tratti durante un tragitto, calcolata solo dove serve.
 */
export async function esposizioneCorridoio(
  r: RichiestaEsposizione,
): Promise<EsposizioneCalcolata> {
  const tempi = istanti(r.quando, r.durataMin, r.passoMinuti)
  const [lon, lat] = r.centro
  const posizioni = tempi.map((t) => solarPosition(lat, lon, t))

  const minuti = Float32Array.from(
    tempi.map((t) => (t.getTime() - r.mezzanotte.getTime()) / 60000),
  )
  const elevazioni = Float32Array.from(posizioni.map((p) => p.elevation))
  const azimut = Float32Array.from(posizioni.map((p) => p.azimuth))

  const nTratti = r.grafo.nTratti
  // Le righe notturne restano a zero: sotto l'orizzonte e' tutto in ombra, e
  // calcolarlo sarebbe tempo speso per un risultato noto.
  const esposizione = new Uint8Array(tempi.length * nTratti)

  const [x0, y0, x1, y1] = riquadroCorridoio(r.corridoioXY)
  const [ovest, sud, est, nord] = marginiSole(posizioni)
  const riquadro = riquadroPixel(r.griglia, x0 - ovest, y0 - sud, x1 + est, y1 + nord)

  let superficie: Superficie | null = null
  if (riquadro !== null) {
    const richiesti = tasselliDi(r.griglia, riquadro)
    const decodificati = await r.tasselli(richiesti)
    superficie = componiSuperficie(r.griglia, riquadro, decodificati, canopyTransmissivity)
  }

  const offsets = r.grafo.sampleOffset
  for (let i = 0; i < tempi.length; i++) {
    const { elevation, azimuth } = posizioni[i]
    if (elevation <= 0.0) continue
    const base = i * nTratti
    if (superficie === null) {
      // Fuori dalla superficie disponibile si assume pieno sole, la stessa
      // convenzione prudente di `samplePoints`.
      esposizione.fill(255, base, base + nTratti)
      continue
    }
    // Non ha senso inseguire ombre piu' lunghe della cornice che e' stata
    // letta: gli ostacoli che le proietterebbero sono comunque fuori dal
    // ritaglio. Troncare li' fa risparmiare le iterazioni piu' costose, quelle
    // con il sole radente.
    const valori = sunFactorPoints(
      superficie.dsm,
      superficie.width,
      superficie.height,
      superficie.pixelSize,
      superficie.transform,
      azimuth,
      elevation,
      r.grafo.sampleX,
      r.grafo.sampleY,
      superficie.canopy,
      superficie.tau,
      portataOmbra(elevation),
      1.0,
    )
    for (let e = 0; e < nTratti; e++) {
      // La somma si accumula a 32 bit come faceva numpy: un tratto ha pochi
      // campioni, ma il risultato finisce in un byte e mezzo bit di scarto
      // potrebbe cambiarlo di un'unita'.
      let somma = 0
      for (let k = offsets[e]; k < offsets[e + 1]; k++) somma = Math.fround(somma + valori[k])
      const media = Math.fround(somma / (offsets[e + 1] - offsets[e]))
      esposizione[base + e] = Math.trunc(Math.min(255, Math.max(0, Math.fround(media * 255))))
    }
  }

  r.registra?.(
    superficie === null
      ? `  ombre: ${tempi.length} istanti, corridoio fuori dall'area`
      : `  ombre: ${tempi.length} istanti su un ritaglio di ` +
          `${superficie.width}x${superficie.height} px a ${superficie.pixelSize} m`,
  )

  return {
    esposizione: new Esposizione(esposizione, minuti, elevazioni, azimut, nTratti),
    superficie,
    istanti: tempi,
  }
}
