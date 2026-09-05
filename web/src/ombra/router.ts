/**
 * Calcolo del percorso piu' fresco, con il sole che si sposta durante il tragitto.
 *
 * Traduzione di `router.py`. Il problema non e' il cammino minimo classico: il
 * costo di un tratto dipende da quando ci si passa. Un vicolo che alle 9 e' in
 * ombra alle 15 e' una fornace, e mentre si cammina il sole continua a
 * spostarsi.
 *
 * L'algoritmo e' un Dijkstra dipendente dal tempo. Ogni etichetta porta con se'
 * sia il costo accumulato sia il tempo di percorrenza accumulato; il tempo
 * determina quale riga della matrice di esposizione usare per valutare il
 * tratto successivo. Poiche' il tempo di percorrenza di un tratto non dipende
 * dall'orario (si cammina alla stessa velocita' tutto il giorno), vale la
 * proprieta' FIFO e Dijkstra resta corretto.
 *
 * Il costo di un tratto e':
 *
 *     tempo_percorrenza x (1 + alpha x esposizione x carico_solare)
 *
 * Delle due dipendenze scientifiche del Python qui non resta nulla: le
 * componenti connesse si trovano con un union-find di venti righe e il nodo
 * piu' vicino a un punto con una scansione lineare. Un albero kd si ripaga da
 * qualche centinaio di migliaia di punti in su; qui i nodi sono quindicimila e
 * le interrogazioni una manciata per percorso, quindi la scansione costa meno
 * di quanto costerebbe costruire l'albero.
 */

import { MODE_BITS, type Grafo, type Modalita } from './graph.ts'
import type { Esposizione } from './exposure.ts'
import { solarLoad } from './solar.ts'

/** Velocita' di base in km/h su terreno pianeggiante */
export const BASE_SPEED: Record<Modalita, number> = {
  foot: 5.0,
  bike: 16.0,
  wheelchair: 3.6,
}

/**
 * Il passo temporale con cui si discretizza il costo durante il tragitto.
 * Piu' fine di cosi' non cambia nulla: in 2 minuti il sole si sposta di mezzo grado.
 */
export const COST_BIN_MINUTES = 2.0

/** Durata massima ammessa per un tragitto, oltre la quale si rinuncia */
export const MAX_TRIP_MINUTES = 240.0

/** Quanto la scomodita' del fondo rallenta ciascuna modalita' */
const ROUGHNESS_PENALTY: Record<Modalita, number> = {
  foot: 0.18,
  bike: 0.45,
  wheelchair: 0.7,
}

/**
 * Sotto questa dimensione una componente e' un troncone senza sbocco, non una
 * rete su cui abbia senso calcolare un percorso.
 */
const MIN_COMPONENT_NODES = 40

export class ErroreRouting extends Error {}

/**
 * Velocita' di percorrenza in m/s per ogni tratto, data pendenza e fondo.
 *
 * A piedi si usa la funzione di Tobler, che descrive bene sia la fatica in
 * salita sia il rallentamento nelle discese ripide. Per bici e carrozzina la
 * penalita' in salita e' molto piu' marcata. Il fondo stradale pesa poco a
 * piedi e moltissimo su due ruote piccole.
 */
export function edgeSpeeds(
  mode: Modalita,
  slope: Float32Array,
  rough: Float32Array | null,
): Float64Array {
  const base = BASE_SPEED[mode]
  const penalita = ROUGHNESS_PENALTY[mode]
  const out = new Float64Array(slope.length)

  for (let i = 0; i < slope.length; i++) {
    const s = slope[i]
    let kmh: number
    if (mode === 'foot') {
      kmh = 6.0 * Math.exp(-3.5 * Math.abs(s + 0.05))
    } else if (mode === 'bike') {
      kmh =
        s > 0
          ? base * Math.exp(-9.0 * s)
          : Math.min(base * (1.0 + 2.5 * -s), base * 1.6)
    } else {
      kmh =
        s > 0
          ? base * Math.exp(-14.0 * s)
          : Math.min(base * (1.0 + 0.8 * -s), base * 1.25)
    }
    if (rough !== null) kmh *= 1.0 - penalita * Math.min(1.0, Math.max(0.0, rough[i]))
    out[i] = Math.max(kmh, 0.3) / 3.6
  }
  return out
}

/**
 * Riga [tratti] di indice di traffico interpolata all'istante `minuto`.
 *
 * A specchio di `Esposizione.riga()`, ma con una differenza: il traffico e'
 * un pattern che si ripete ogni giorno (le 8:00 sono sempre le 8:00), mentre
 * il sole di `Esposizione` e' ancorato al giorno preciso del tragitto --
 * quindi qui si riporta prima `minuto` dentro un solo giorno (resto modulo
 * 1440), lui no. Fuori dalla finestra rilevata si tiene il valore del bordo
 * piu' vicino, mai un'estrapolazione: stesso principio "default prudente,
 * mai favorevole" del vento tipico.
 */
export function trafficoRiga(g: Grafo, minuto: number, dentro?: Float32Array): Float32Array {
  const out = dentro ?? new Float32Array(g.nTratti)
  if (g.trafficNFasce <= 1) {
    out.set(g.edgeTraffic.subarray(0, g.nTratti))
    return out
  }
  const m = ((minuto % 1440) + 1440) % 1440
  const idx = Math.min(
    Math.max((m - g.trafficFasciaInizio) / g.trafficFasciaPasso, 0),
    g.trafficNFasce - 1,
  )
  const i0 = Math.floor(idx)
  const i1 = Math.min(i0 + 1, g.trafficNFasce - 1)
  const w = idx - i0
  const base0 = i0 * g.nTratti
  const base1 = i1 * g.nTratti
  for (let e = 0; e < g.nTratti; e++) {
    out[e] = g.edgeTraffic[base0 + e] * (1 - w) + g.edgeTraffic[base1 + e] * w
  }
  return out
}

/** Indice di traffico di un solo tratto: quello che serve a descrivere un percorso. */
function trafficoValore(g: Grafo, minuto: number, tratto: number): number {
  if (g.trafficNFasce <= 1) return g.edgeTraffic[tratto]
  const m = ((minuto % 1440) + 1440) % 1440
  const idx = Math.min(
    Math.max((m - g.trafficFasciaInizio) / g.trafficFasciaPasso, 0),
    g.trafficNFasce - 1,
  )
  const i0 = Math.floor(idx)
  const i1 = Math.min(i0 + 1, g.trafficNFasce - 1)
  const w = idx - i0
  const lo = g.edgeTraffic[i0 * g.nTratti + tratto]
  const hi = g.edgeTraffic[i1 * g.nTratti + tratto]
  return lo + w * (hi - lo)
}

/**
 * Grado di traffico complessivo dell'area all'istante `minuto`, per la sola
 * visualizzazione (Timeline): non entra nel costo di un percorso, quello
 * resta `trafficoRiga`/`trafficoValore` sopra, per-tratto.
 *
 * E' la media dell'indice sui soli tratti che portano un dato reale o di
 * fallback tipologico (`edgeTraffic > 0`): i tratti mai coperti (ne' PUMS ne'
 * fallback) restano a zero per costruzione e diluirebbero la media verso il
 * basso senza dire nulla sul traffico vero. `copertura` dice quanto quella
 * media sia rappresentativa dell'intera rete.
 *
 * `null` se l'area non porta affatto l'asse traffico: nessun tratto ha un
 * valore sopra zero a nessuna ora.
 */
export function trafficoAggregato(
  g: Grafo,
  minuto: number,
): { indice: number; copertura: number } | null {
  const riga = trafficoRiga(g, minuto)
  let somma = 0
  let n = 0
  for (let e = 0; e < riga.length; e++) {
    if (riga[e] > 0) {
      somma += riga[e]
      n++
    }
  }
  if (n === 0) return null
  return { indice: somma / n, copertura: n / riga.length }
}

/**
 * Matrice [istante x tratto] del moltiplicatore di costo.
 *
 * Precalcolarla evita di interpolare l'esposizione (e ora anche il
 * traffico) a ogni estrazione dalla coda di priorita': durante il Dijkstra
 * il costo di un tratto diventa una singola lettura in un array.
 *
 * Il termine di traffico (`beta * trafficoRiga(...) * fattoreVento`) segue
 * ora lo stesso ciclo sui bin del sole, invece di sommarsi una sola volta a
 * tutte le righe: da quando l'indice varia per fascia oraria non e' piu'
 * costante durante il tragitto. Se `beta <= 0` il blocco resta saltato del
 * tutto, non solo moltiplicato per zero: stesso output, bit per bit, di
 * prima che questo termine esistesse (a specchio esatto di
 * `router._cost_multipliers`).
 */

/**
 * Matrice [istante x tratto] del tasso di dose solare (esposizione x carico
 * radiativo), indipendente da alpha.
 *
 * Estratta da `moltiplicatori()` perche' la ricerca Pareto in `pareto.ts` ha
 * bisogno dello stesso tasso non pesato: li' non c'e' un alpha che lo scali,
 * il tempo e la dose restano due assi separati fino alla fine.
 */
export function doseSolareBins(
  esposizione: Esposizione,
  minutoPartenza: number,
  nBins: number,
): Float32Array {
  const nTratti = esposizione.nTratti
  const dose = new Float32Array(nBins * nTratti)
  const riga = new Float32Array(nTratti)
  for (let b = 0; b < nBins; b++) {
    const minuto = minutoPartenza + b * COST_BIN_MINUTES
    const { elevation } = esposizione.soleA(minuto)
    const carico = solarLoad(elevation)
    if (carico <= 0.0) continue // di notte non c'e' sole da evitare
    esposizione.riga(minuto, riga)
    const base = b * nTratti
    for (let e = 0; e < nTratti; e++) dose[base + e] = riga[e] * carico
  }
  return dose
}

function moltiplicatori(
  g: Grafo,
  esposizione: Esposizione,
  minutoPartenza: number,
  alpha: number,
  nBins: number,
  beta = 0,
  fattoreVento = 1.0,
): Float32Array {
  const nTratti = esposizione.nTratti
  const mult = new Float32Array(nBins * nTratti).fill(1.0)

  if (alpha > 0.0) {
    const dose = doseSolareBins(esposizione, minutoPartenza, nBins)
    for (let i = 0; i < mult.length; i++) mult[i] += alpha * dose[i]
  }

  if (beta > 0.0) {
    const riga = new Float32Array(nTratti)
    for (let b = 0; b < nBins; b++) {
      const minuto = minutoPartenza + b * COST_BIN_MINUTES
      trafficoRiga(g, minuto, riga)
      const base = b * nTratti
      for (let e = 0; e < nTratti; e++) mult[base + e] += beta * fattoreVento * riga[e]
    }
  }

  return mult
}

/** Insiemi disgiunti con compressione di cammino: le componenti connesse. */
class UnionFind {
  private padre: Int32Array

  constructor(n: number) {
    this.padre = new Int32Array(n)
    for (let i = 0; i < n; i++) this.padre[i] = i
  }

  radice(x: number): number {
    let r = x
    while (this.padre[r] !== r) r = this.padre[r]
    while (this.padre[x] !== r) {
      const succ = this.padre[x]
      this.padre[x] = r
      x = succ
    }
    return r
  }

  unisci(a: number, b: number): void {
    const ra = this.radice(a)
    const rb = this.radice(b)
    if (ra !== rb) this.padre[rb] = ra
  }
}

/** Distanza al quadrato dal nodo piu' vicino fra quelli indicati. */
function distanzaMinima(g: Grafo, nodi: Int32Array, x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i < nodi.length; i++) {
    const n = nodi[i]
    const dx = g.nodeX[n] - x
    const dy = g.nodeY[n] - y
    const d = dx * dx + dy * dy
    if (d < best) best = d
  }
  return best
}

/**
 * Sceglie su quale porzione connessa di rete calcolare il percorso.
 *
 * La rete si frammenta: il ritaglio sul riquadro tronca le vie di bordo, e per
 * la carrozzina i gradini isolano interi quartieri. Ad Ascoli il centro storico
 * sta su un pianoro e i suoi accessi ripidi lo staccano dalla citta' bassa, che
 * essendo piu' estesa "vincerebbe" se ci limitassimo a prendere la componente
 * maggiore: un percorso dentro il centro diventerebbe impossibile. Si sceglie
 * quindi la componente che avvicina di piu' entrambi gli estremi richiesti.
 */
export function scegliComponente(
  g: Grafo,
  ammessi: Uint8Array,
  origine: [number, number],
  destinazione: [number, number],
): Int32Array {
  const uf = new UnionFind(g.nNodi)
  const usato = new Uint8Array(g.nNodi)
  for (let e = 0; e < g.nTratti; e++) {
    if (!ammessi[e]) continue
    uf.unisci(g.edgeU[e], g.edgeV[e])
    usato[g.edgeU[e]] = 1
    usato[g.edgeV[e]] = 1
  }

  const perRadice = new Map<number, number[]>()
  for (let n = 0; n < g.nNodi; n++) {
    if (!usato[n]) continue
    const r = uf.radice(n)
    const lista = perRadice.get(r)
    if (lista) lista.push(n)
    else perRadice.set(r, [n])
  }

  let candidate = [...perRadice.values()].filter((l) => l.length >= MIN_COMPONENT_NODES)
  if (candidate.length === 0) {
    // Nessuna componente degna: si tiene comunque la piu' grande, come faceva
    // l'`argmax` dell'originale.
    let piuGrande: number[] = []
    for (const lista of perRadice.values()) {
      if (lista.length > piuGrande.length) piuGrande = lista
    }
    if (piuGrande.length === 0) throw new ErroreRouting('rete percorribile vuota')
    candidate = [piuGrande]
  }

  let migliore: Int32Array | null = null
  let punteggio = Infinity
  for (const lista of candidate) {
    const nodi = Int32Array.from(lista)
    const p =
      Math.sqrt(distanzaMinima(g, nodi, origine[0], origine[1])) +
      Math.sqrt(distanzaMinima(g, nodi, destinazione[0], destinazione[1]))
    if (p < punteggio) {
      punteggio = p
      migliore = nodi
    }
  }
  return migliore as Int32Array
}

/** Nodo percorribile piu' vicino a un punto, fra i candidati indicati. */
export function aggancia(
  g: Grafo,
  x: number,
  y: number,
  candidati: Int32Array,
): { nodo: number; distanza: number } {
  let nodo = -1
  let best = Infinity
  for (let i = 0; i < candidati.length; i++) {
    const n = candidati[i]
    const dx = g.nodeX[n] - x
    const dy = g.nodeY[n] - y
    const d = dx * dx + dy * dy
    if (d < best) {
      best = d
      nodo = n
    }
  }
  if (nodo < 0) throw new ErroreRouting('nessun nodo a cui agganciare il punto')
  return { nodo, distanza: Math.sqrt(best) }
}

/**
 * Coda di priorita' che confronta le etichette come le tuple di `heapq`:
 * prima la stima, poi il costo, poi il nodo.
 *
 * Il terzo criterio non serve alla correttezza ma alla riproducibilita': fra
 * due percorsi di costo identico si vuole che il browser scelga lo stesso che
 * sceglieva il backend, altrimenti i confronti coi percorsi di riferimento
 * segnalerebbero differenze che non sono errori.
 */
class Coda {
  private stima: number[] = []
  private costo: number[] = []
  private nodo: number[] = []

  get vuota(): boolean {
    return this.nodo.length === 0
  }

  private prima(i: number, j: number): boolean {
    if (this.stima[i] !== this.stima[j]) return this.stima[i] < this.stima[j]
    if (this.costo[i] !== this.costo[j]) return this.costo[i] < this.costo[j]
    return this.nodo[i] < this.nodo[j]
  }

  private scambia(i: number, j: number): void {
    ;[this.stima[i], this.stima[j]] = [this.stima[j], this.stima[i]]
    ;[this.costo[i], this.costo[j]] = [this.costo[j], this.costo[i]]
    ;[this.nodo[i], this.nodo[j]] = [this.nodo[j], this.nodo[i]]
  }

  inserisci(stima: number, costo: number, nodo: number): void {
    this.stima.push(stima)
    this.costo.push(costo)
    this.nodo.push(nodo)
    let i = this.nodo.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.prima(i, p)) break
      this.scambia(i, p)
      i = p
    }
  }

  estrai(): { costo: number; nodo: number } {
    const costo = this.costo[0]
    const nodo = this.nodo[0]
    const ultimo = this.nodo.length - 1
    this.scambia(0, ultimo)
    this.stima.pop()
    this.costo.pop()
    this.nodo.pop()
    let i = 0
    const n = this.nodo.length
    for (;;) {
      const sx = 2 * i + 1
      const dx = sx + 1
      let piccolo = i
      if (sx < n && this.prima(sx, piccolo)) piccolo = sx
      if (dx < n && this.prima(dx, piccolo)) piccolo = dx
      if (piccolo === i) break
      this.scambia(i, piccolo)
      i = piccolo
    }
    return { costo, nodo }
  }
}

interface Cammino {
  costo: number
  tempo: number
  tratti: number[]
  nodi: number[]
}

/**
 * Dijkstra dipendente dal tempo con euristica A* sulla distanza residua.
 *
 * Esportata perche' e' anche il cuore della ricerca in `pareto.ts`: sia il
 * percorso piu' rapido piatto (usato li' come riferimento e come limite
 * temporale della ricerca multi-obiettivo), sia -- volendo -- un confronto
 * diretto con la somma pesata di oggi a parita' di costo scalare.
 */
export function dijkstra(
  g: Grafo,
  tempoPercorrenza: Float64Array,
  ammessi: Uint8Array,
  mult: Float32Array,
  nBins: number,
  partenza: number,
  arrivo: number,
  velocitaMax: number,
): Cammino | null {
  const nTratti = g.nTratti
  const goalX = g.nodeX[arrivo]
  const goalY = g.nodeY[arrivo]
  // Stima ottimistica del tempo residuo: distanza in linea d'aria alla
  // velocita' massima e senza penalita' di sole. Non sovrastima mai il costo
  // reale, quindi A* resta esatto. I costi sono in minuti, quindi anche
  // l'euristica deve esserlo: sovrastimarla renderebbe la ricerca avida verso
  // la destinazione e farebbe perdere i percorsi in ombra.
  const invVelocita = 1.0 / (velocitaMax * 60.0) // minuti per metro

  const migliorCosto = new Float64Array(g.nNodi).fill(Infinity)
  const migliorTempo = new Float64Array(g.nNodi).fill(Infinity)
  const nodoPrec = new Int32Array(g.nNodi).fill(-1)
  const trattoPrec = new Int32Array(g.nNodi).fill(-1)
  const sistemato = new Uint8Array(g.nNodi)

  migliorCosto[partenza] = 0.0
  migliorTempo[partenza] = 0.0
  const coda = new Coda()
  coda.inserisci(0.0, 0.0, partenza)

  while (!coda.vuota) {
    const { costo, nodo: u } = coda.estrai()
    if (sistemato[u]) continue
    sistemato[u] = 1
    if (u === arrivo) break

    const tOffset = migliorTempo[u]
    if (tOffset > MAX_TRIP_MINUTES) continue
    const bin = Math.min(Math.trunc(tOffset / COST_BIN_MINUTES), nBins - 1)
    const riga = bin * nTratti

    for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) {
      const e = g.adjEdge[k]
      if (!ammessi[e]) continue
      const v = g.adjTarget[k]
      if (sistemato[v]) continue

      const dt = tempoPercorrenza[e]
      const nuovoCosto = costo + dt * mult[riga + e]
      if (nuovoCosto < migliorCosto[v]) {
        migliorCosto[v] = nuovoCosto
        migliorTempo[v] = tOffset + dt
        nodoPrec[v] = u
        trattoPrec[v] = e
        const dx = g.nodeX[v] - goalX
        const dy = g.nodeY[v] - goalY
        coda.inserisci(nuovoCosto + Math.hypot(dx, dy) * invVelocita, nuovoCosto, v)
      }
    }
  }

  if (!sistemato[arrivo] || !Number.isFinite(migliorCosto[arrivo])) return null

  const tratti: number[] = []
  const nodi: number[] = []
  let cur = arrivo
  while (cur !== partenza) {
    tratti.push(trattoPrec[cur])
    nodi.push(cur)
    cur = nodoPrec[cur]
    if (cur < 0) return null
  }
  nodi.push(partenza)
  tratti.reverse()
  nodi.reverse()
  return {
    costo: migliorCosto[arrivo],
    tempo: migliorTempo[arrivo],
    tratti,
    nodi,
  }
}

export interface Segmento {
  from: [number, number]
  to: [number, number]
  exposure: number
  length_m: number
  minute: number
  name: string
  traffic_index: number
}

export interface Percorso {
  coordinates: [number, number][]
  segments: Segmento[]
  distance_m: number
  duration_min: number
  shade_pct: number
  sun_distance_m: number
  sun_dose_min: number
  avg_traffic_index: number
  arrival_minute: number
}

export const arrotonda = (v: number, cifre: number): number => {
  const f = 10 ** cifre
  return Math.round(v * f) / f
}

/**
 * Costruisce geometria, statistiche e profilo di esposizione di un percorso.
 *
 * Esportata perche' e' anche il modo in cui `pareto.ts` trasforma un'etichetta
 * della frontiera (una sequenza di tratti) nello stesso `Percorso` che gia'
 * mostra la UI: stessi campi, stesso arrotondamento, un solo posto dove le
 * statistiche di un percorso vengono calcolate.
 */
export function descrivi(
  g: Grafo,
  esposizione: Esposizione,
  tratti: number[],
  nodi: number[],
  minutoPartenza: number,
  tempoPercorrenza: Float64Array,
): Percorso {
  const coords: [number, number][] = nodi.map((n) => [g.nodeLon[n], g.nodeLat[n]])

  // Esposizione ed indice di traffico di ogni tratto valutati all'orario in
  // cui lo si percorre davvero -- lo stesso principio per entrambi, ora che
  // anche il traffico varia per fascia oraria.
  let t = minutoPartenza
  const segments: Segmento[] = []
  const esposizioni = new Float64Array(tratti.length)
  const traffici = new Float64Array(tratti.length)
  for (let i = 0; i < tratti.length; i++) {
    const e = tratti[i]
    const dt = tempoPercorrenza[e]
    const mid = t + dt / 2.0
    esposizioni[i] = esposizione.valore(mid, e)
    traffici[i] = trafficoValore(g, mid, e)
    segments.push({
      from: coords[i],
      to: coords[i + 1],
      exposure: arrotonda(esposizioni[i], 3),
      length_m: arrotonda(g.edgeLen[e], 1),
      minute: arrotonda(t, 2),
      name: g.nomi[g.edgeName[e]],
      traffic_index: arrotonda(traffici[i], 3),
    })
    t += dt
  }

  let lunghezzaTotale = 0
  let lunghezzaAlSole = 0
  let lunghezzaTraffico = 0
  for (let i = 0; i < tratti.length; i++) {
    const l = g.edgeLen[tratti[i]]
    lunghezzaTotale += l
    lunghezzaAlSole += l * esposizioni[i]
    lunghezzaTraffico += l * traffici[i]
  }

  // Quanto sole si prende davvero, pesato per il carico radiativo: e' la
  // grandezza che conta per il disagio percepito, non la sola percentuale.
  let dose = 0.0
  let tt = minutoPartenza
  for (let i = 0; i < tratti.length; i++) {
    const dt = tempoPercorrenza[tratti[i]]
    const { elevation } = esposizione.soleA(tt + dt / 2.0)
    dose += dt * esposizioni[i] * solarLoad(elevation)
    tt += dt
  }

  return {
    coordinates: coords,
    segments,
    distance_m: arrotonda(lunghezzaTotale, 1),
    duration_min: arrotonda(t - minutoPartenza, 2),
    shade_pct: arrotonda(100.0 * (1.0 - lunghezzaAlSole / Math.max(lunghezzaTotale, 1e-9)), 1),
    sun_distance_m: arrotonda(lunghezzaAlSole, 1),
    sun_dose_min: arrotonda(dose, 2),
    avg_traffic_index: arrotonda(lunghezzaTraffico / Math.max(lunghezzaTotale, 1e-9), 3),
    arrival_minute: arrotonda(t, 2),
  }
}

export interface RisultatoPercorso {
  mode: Modalita
  alpha: number
  beta: number
  departure_minute: number
  snap_distance_m: { origin: number; destination: number }
  shaded: Percorso
  fastest: Percorso
  comparison: {
    identical: boolean
    extra_minutes: number
    extra_meters: number
    shade_gain_pct: number
    sun_dose_saved_pct: number
    traffic_index_saved_pct: number
  }
}

const NOME_MODO: Record<Modalita, string> = {
  foot: 'a piedi',
  bike: 'in bici',
  wheelchair: 'in carrozzina',
}

export interface RicercaPreparata {
  ammessi: Uint8Array
  tempoPercorrenza: Float64Array
  velocitaMax: number
  partenza: { nodo: number; distanza: number }
  arrivo: { nodo: number; distanza: number }
}

/**
 * Prepara tutto cio' che serve a cercare un percorso in una modalita' data,
 * prima ancora di sapere se lo si vuole piu' rapido, piu' ombreggiato o su
 * una frontiera Pareto: quali tratti sono percorribili, quanto ci si mette su
 * ciascuno, e a quali nodi agganciare partenza e arrivo.
 *
 * Estratta da `calcolaPercorso` perche' `pareto.ts` ha bisogno esattamente
 * degli stessi controlli (stessa componente connessa, stessa validazione
 * della distanza di aggancio) prima di lanciare la propria ricerca.
 */
export function preparaRicerca(
  g: Grafo,
  mode: Modalita,
  origineUtm: [number, number],
  destinazioneUtm: [number, number],
): RicercaPreparata {
  const bit = MODE_BITS[mode]
  if (bit === undefined) throw new ErroreRouting(`modalita' sconosciuta: ${mode}`)

  const ammessi = new Uint8Array(g.nTratti)
  let qualcuno = false
  for (let e = 0; e < g.nTratti; e++) {
    if ((g.edgeFlags[e] & bit) > 0) {
      ammessi[e] = 1
      qualcuno = true
    }
  }
  if (!qualcuno) {
    throw new ErroreRouting(`nessun tratto percorribile in modalita' '${mode}'`)
  }

  const velocita = edgeSpeeds(mode, g.edgeSlope, g.edgeRough)
  const tempoPercorrenza = new Float64Array(g.nTratti)
  let velocitaMax = 0
  for (let e = 0; e < g.nTratti; e++) {
    tempoPercorrenza[e] = g.edgeLen[e] / velocita[e] / 60.0 // minuti
    if (ammessi[e] && velocita[e] > velocitaMax) velocitaMax = velocita[e]
  }

  // Entrambi gli estremi vanno agganciati alla stessa rete connessa, altrimenti
  // si finisce su tronconi isolati e nessun percorso esiste.
  const raggiungibili = scegliComponente(g, ammessi, origineUtm, destinazioneUtm)
  const partenza = aggancia(g, origineUtm[0], origineUtm[1], raggiungibili)
  const arrivo = aggancia(g, destinazioneUtm[0], destinazioneUtm[1], raggiungibili)

  if (partenza.nodo === arrivo.nodo) {
    throw new ErroreRouting('partenza e arrivo coincidono sullo stesso tratto')
  }
  for (const [etichetta, d] of [
    ['partenza', partenza.distanza],
    ['arrivo', arrivo.distanza],
  ] as [string, number][]) {
    if (d > 400) {
      throw new ErroreRouting(
        `il punto di ${etichetta} dista ${d.toFixed(0)} m dalla rete percorribile ` +
          `${NOME_MODO[mode]}. Puo' essere fuori dall'area preparata, oppure i due ` +
          'punti stanno su porzioni di rete che questa modalita\' non collega.',
      )
    }
  }

  return { ammessi, tempoPercorrenza, velocitaMax, partenza, arrivo }
}

/**
 * Calcola il percorso ombreggiato e quello piu' rapido per confronto.
 *
 * `esposizione` puo' essere gia' pronta oppure una funzione che la costruisce
 * dati il corridoio e la durata: la seconda forma serve a calcolare le ombre
 * solo dove e quando il tragitto passa davvero, cosa che si puo' sapere
 * soltanto dopo aver trovato il percorso piu' rapido.
 *
 * E' asincrona per un solo motivo: quella funzione, nel browser, deve
 * scaricare i tasselli del corridoio. Il resto del calcolo non aspetta nulla.
 */
export async function calcolaPercorso(opzioni: {
  grafo: Grafo
  esposizione:
    | Esposizione
    | ((corridoio: Float64Array, durata: number) => Esposizione | Promise<Esposizione>)
  origineUtm: [number, number]
  destinazioneUtm: [number, number]
  mode: Modalita
  minutoPartenza: number
  alpha: number
  beta?: number
  fattoreVento?: number
}): Promise<RisultatoPercorso> {
  const { grafo: g, mode, alpha } = opzioni
  const beta = opzioni.beta ?? 0
  const fattoreVento = opzioni.fattoreVento ?? 1.0

  const { ammessi, tempoPercorrenza, velocitaMax, partenza, arrivo } = preparaRicerca(
    g, mode, opzioni.origineUtm, opzioni.destinazioneUtm,
  )

  const nBins = Math.trunc(MAX_TRIP_MINUTES / COST_BIN_MINUTES) + 1

  // Percorso piu' rapido: nessuna penalita' di sole, e' il riferimento. Va
  // calcolato per primo anche perche' dice dove passera' il tragitto e quanto
  // durera', le due cose che servono a sapere quali ombre calcolare.
  const piatto = new Float32Array(g.nTratti).fill(1.0)
  const rapido = dijkstra(
    g, tempoPercorrenza, ammessi, piatto, 1, partenza.nodo, arrivo.nodo, velocitaMax,
  )
  if (rapido === null) {
    throw new ErroreRouting('nessun percorso trovato fra i due punti in questa modalita\'')
  }

  let esposizione: Esposizione
  if (typeof opzioni.esposizione === 'function') {
    const corridoio = new Float64Array(rapido.nodi.length * 2)
    for (let i = 0; i < rapido.nodi.length; i++) {
      corridoio[i * 2] = g.nodeX[rapido.nodi[i]]
      corridoio[i * 2 + 1] = g.nodeY[rapido.nodi[i]]
    }
    esposizione = await opzioni.esposizione(corridoio, rapido.tempo)
  } else {
    esposizione = opzioni.esposizione
  }

  const minutoPartenza = Math.min(
    Math.max(opzioni.minutoPartenza, esposizione.minutoIniziale),
    esposizione.minutoFinale,
  )

  // Un utente con alpha=0 e beta>0 vuole solo evitare il traffico: deve
  // ottenere un percorso ricalcolato, non quello piatto, da cui il gate su
  // entrambi (a specchio esatto del cambio in `router.compute_route`).
  let ombreggiato = rapido
  if (alpha > 0 || beta > 0) {
    const mult = moltiplicatori(g, esposizione, minutoPartenza, alpha, nBins, beta, fattoreVento)
    const trovato = dijkstra(
      g, tempoPercorrenza, ammessi, mult, nBins, partenza.nodo, arrivo.nodo, velocitaMax,
    )
    if (trovato !== null) ombreggiato = trovato
  }

  const shaded = descrivi(
    g, esposizione, ombreggiato.tratti, ombreggiato.nodi, minutoPartenza, tempoPercorrenza,
  )
  const fastest = descrivi(
    g, esposizione, rapido.tratti, rapido.nodi, minutoPartenza, tempoPercorrenza,
  )

  const uguali =
    ombreggiato.tratti.length === rapido.tratti.length &&
    ombreggiato.tratti.every((e, i) => e === rapido.tratti[i])

  return {
    mode,
    alpha,
    beta,
    departure_minute: arrotonda(minutoPartenza, 2),
    snap_distance_m: {
      origin: arrotonda(partenza.distanza, 1),
      destination: arrotonda(arrivo.distanza, 1),
    },
    shaded,
    fastest,
    comparison: {
      identical: uguali,
      extra_minutes: arrotonda(shaded.duration_min - fastest.duration_min, 2),
      extra_meters: arrotonda(shaded.distance_m - fastest.distance_m, 1),
      shade_gain_pct: arrotonda(shaded.shade_pct - fastest.shade_pct, 1),
      sun_dose_saved_pct: arrotonda(
        100.0 * (1.0 - shaded.sun_dose_min / Math.max(fastest.sun_dose_min, 1e-9)),
        1,
      ),
      traffic_index_saved_pct: arrotonda(
        100.0 * (1.0 - shaded.avg_traffic_index / Math.max(fastest.avg_traffic_index, 1e-9)),
        1,
      ),
    },
  }
}
