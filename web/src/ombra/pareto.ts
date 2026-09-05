/**
 * Frontiera di Pareto tempo/sole: prototipo di routing multi-obiettivo.
 *
 * `router.ts` sceglie un solo percorso comprimendo tempo e sole in un unico
 * costo scalare (`tempo x (1 + alpha x esposizione x carico)`), poi lo cerca
 * con Dijkstra. Qualunque sia alpha, quella somma pesata puo' trovare solo i
 * percorsi che stanno sull'inviluppo convesso inferiore dello spazio
 * (tempo, dose): un percorso Pareto-ottimo ma "in una tacca concava" della
 * frontiera reale non e' raggiungibile da NESSUN alpha >= 0, per costruzione
 * geometrica della somma pesata, non per un limite dell'implementazione.
 * E' la causa dei salti bizzarri che uno slider continuo produce su una rete
 * stradale reale (un percorso alternativo sostituisce l'altro di scatto, e la
 * percentuale d'ombra realizzata puo' muoversi nella direzione sbagliata).
 *
 * Qui si cerca invece l'intera frontiera non dominata con un Dijkstra
 * multi-etichetta (label-correcting) sul modello di NAMOA*: ogni nodo porta
 * un insieme di etichette (tempo, dose) nessuna delle quali e' dominata dalle
 * altre, invece di un solo costo migliore. La coda resta ordinata per tempo
 * (piu' euristica A* sulla distanza residua, come in `router.ts`): guida la
 * ricerca verso l'arrivo ma non influisce sulla correttezza, che dipende solo
 * dal confronto di dominanza a ogni estrazione.
 *
 * Scope di questo prototipo: due assi (tempo, sole). Il traffico resta fuori
 * -- vedi il commento in fondo al file per come diventerebbe il terzo asse.
 * `esposizione` qui e' gia' pronta (non la funzione-fabbrica per corridoio di
 * `calcolaPercorso`): la frontiera puo' esplorare strade ben fuori dal
 * corridoio del percorso piu' rapido, e il corridoio "giusto" da scaricare
 * per una ricerca multi-obiettivo e' una domanda ancora aperta, rimandata al
 * momento in cui questo verra' collegato all'app (vedi PROSSIMI_PASSI.md o
 * l'esito del benchmark in pareto-prestazioni.ts).
 */

import type { Grafo, Modalita } from './graph.ts'
import type { Esposizione } from './exposure.ts'
import {
  COST_BIN_MINUTES,
  MAX_TRIP_MINUTES,
  arrotonda,
  descrivi,
  dijkstra,
  doseSolareBins,
  preparaRicerca,
  type Percorso,
} from './router.ts'

/** Un punto della frontiera: un percorso, descritto dal suo costo su due assi. */
export interface EtichettaPareto {
  readonly tempo: number
  readonly sunDose: number
  readonly nodo: number
  readonly trattoPrec: number
  readonly precedente: EtichettaPareto | null
}

/**
 * `a` domina `b` se non è mai peggiore su nessun asse ed è strettamente
 * migliore su almeno uno: la definizione standard di Pareto-dominanza.
 */
export function domina(
  a: { tempo: number; sunDose: number },
  b: { tempo: number; sunDose: number },
): boolean {
  return (
    a.tempo <= b.tempo &&
    a.sunDose <= b.sunDose &&
    (a.tempo < b.tempo || a.sunDose < b.sunDose)
  )
}

/** Ricostruisce tratti e nodi di un'etichetta risalendo i predecessori. */
export function ricostruisciCammino(etichetta: EtichettaPareto): {
  tratti: number[]
  nodi: number[]
} {
  const tratti: number[] = []
  const nodi: number[] = []
  let cur: EtichettaPareto | null = etichetta
  while (cur !== null && cur.precedente !== null) {
    tratti.push(cur.trattoPrec)
    nodi.push(cur.nodo)
    cur = cur.precedente
  }
  if (cur !== null) nodi.push(cur.nodo)
  tratti.reverse()
  nodi.reverse()
  return { tratti, nodi }
}

/** Coda a min-heap ordinata per stima crescente, poi per nodo (determinismo). */
class CodaPareto {
  private stima: number[] = []
  private etichetta: EtichettaPareto[] = []

  get vuota(): boolean {
    return this.etichetta.length === 0
  }

  private prima(i: number, j: number): boolean {
    if (this.stima[i] !== this.stima[j]) return this.stima[i] < this.stima[j]
    return this.etichetta[i].nodo < this.etichetta[j].nodo
  }

  private scambia(i: number, j: number): void {
    ;[this.stima[i], this.stima[j]] = [this.stima[j], this.stima[i]]
    ;[this.etichetta[i], this.etichetta[j]] = [this.etichetta[j], this.etichetta[i]]
  }

  inserisci(stima: number, etichetta: EtichettaPareto): void {
    this.stima.push(stima)
    this.etichetta.push(etichetta)
    let i = this.etichetta.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.prima(i, p)) break
      this.scambia(i, p)
      i = p
    }
  }

  estrai(): EtichettaPareto {
    const etichetta = this.etichetta[0]
    const ultimo = this.etichetta.length - 1
    this.scambia(0, ultimo)
    this.stima.pop()
    this.etichetta.pop()
    let i = 0
    const n = this.etichetta.length
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
    return etichetta
  }
}

/**
 * Dijkstra multi-etichetta: trova tutte le etichette non dominate raggiunte
 * in `arrivo`, cioe' l'intera frontiera di Pareto (tempo, dose) fra
 * `partenza` e `arrivo`.
 *
 * E' "label-correcting", non "label-setting" in senso stretto: puo' inserire
 * in coda etichette che risultano dominate solo dopo, e le scarta quando le
 * estrae. Piu' semplice da scrivere in modo sicuramente corretto; se il
 * benchmark mostra che il churn della coda pesa, la prossima ottimizzazione
 * naturale e' un indice di dominanza per nodo che scarta prima di inserire.
 *
 * `tempoMassimo` limita la ricerca: senza un tetto, su una rete di quindicimila
 * nodi la ricerca esplorerebbe percorsi via via piu' lenti all'infinito pur di
 * risparmiare un decimo di punto percentuale di sole. Il chiamante lo fissa
 * come multiplo del tempo del percorso piu' rapido.
 */
export function frontieraParetoTempoSole(
  g: Grafo,
  tempoPercorrenza: Float64Array,
  ammessi: Uint8Array,
  doseBins: Float32Array,
  nBins: number,
  partenza: number,
  arrivo: number,
  velocitaMax: number,
  tempoMassimo: number,
): EtichettaPareto[] {
  const invVelocita = 1.0 / (velocitaMax * 60.0) // minuti per metro
  const goalX = g.nodeX[arrivo]
  const goalY = g.nodeY[arrivo]

  const accettatePerNodo = new Map<number, EtichettaPareto[]>()
  const arrivate: EtichettaPareto[] = []

  const partenzaEtichetta: EtichettaPareto = {
    tempo: 0,
    sunDose: 0,
    nodo: partenza,
    trattoPrec: -1,
    precedente: null,
  }
  const coda = new CodaPareto()
  coda.inserisci(0, partenzaEtichetta)

  while (!coda.vuota) {
    const etichetta = coda.estrai()
    if (etichetta.tempo > tempoMassimo) continue

    const accettateQui = accettatePerNodo.get(etichetta.nodo)
    if (accettateQui && accettateQui.some((a) => domina(a, etichetta))) continue
    if (accettateQui) accettateQui.push(etichetta)
    else accettatePerNodo.set(etichetta.nodo, [etichetta])

    if (etichetta.nodo === arrivo) {
      arrivate.push(etichetta)
      continue // non ci si ferma: altre etichette in coda possono essere non dominate
    }

    const bin = Math.min(Math.trunc(etichetta.tempo / COST_BIN_MINUTES), nBins - 1)
    const baseBin = bin * g.nTratti

    for (let k = g.adjStart[etichetta.nodo]; k < g.adjStart[etichetta.nodo + 1]; k++) {
      const e = g.adjEdge[k]
      if (!ammessi[e]) continue
      const v = g.adjTarget[k]

      const dt = tempoPercorrenza[e]
      const nuovoTempo = etichetta.tempo + dt
      if (nuovoTempo > tempoMassimo) continue
      const nuovaDose = etichetta.sunDose + dt * doseBins[baseBin + e]
      const nuova: EtichettaPareto = {
        tempo: nuovoTempo,
        sunDose: nuovaDose,
        nodo: v,
        trattoPrec: e,
        precedente: etichetta,
      }

      const accettateV = accettatePerNodo.get(v)
      if (accettateV && accettateV.some((a) => domina(a, nuova))) continue

      const dx = g.nodeX[v] - goalX
      const dy = g.nodeY[v] - goalY
      const stima = nuovoTempo + Math.hypot(dx, dy) * invVelocita
      coda.inserisci(stima, nuova)
    }
  }

  arrivate.sort((a, b) => a.tempo - b.tempo)
  return arrivate
}

export interface OpzioniFrontieraParetoTempoSole {
  grafo: Grafo
  esposizione: Esposizione
  origineUtm: [number, number]
  destinazioneUtm: [number, number]
  mode: Modalita
  minutoPartenza: number
  /**
   * Quanto oltre il tempo del percorso piu' rapido si e' disposti a
   * esplorare, come multiplo. Il tetto assoluto di `MAX_TRIP_MINUTES` resta
   * comunque valido sotto questo.
   */
  fattoreTempoMassimo?: number
}

export interface RisultatoFrontieraPareto {
  mode: Modalita
  departure_minute: number
  /** Il percorso piu' rapido in assoluto: e' sempre il primo punto della frontiera. */
  fastest: Percorso
  /** Ogni etichetta non dominata trovata a destinazione, ordinata per durata crescente. */
  frontiera: Percorso[]
}

/**
 * Calcola la frontiera di Pareto (tempo, sole) fra due punti.
 *
 * A differenza di `calcolaPercorso`, `esposizione` qui e' gia' pronta: vedi
 * il commento in testa al file sul perche' non c'e' ancora una versione a
 * corridoio.
 */
export function calcolaFrontieraParetoTempoSole(
  opzioni: OpzioniFrontieraParetoTempoSole,
): RisultatoFrontieraPareto {
  const { grafo: g, mode, esposizione } = opzioni
  const fattoreTempoMassimo = opzioni.fattoreTempoMassimo ?? 3.0

  const { ammessi, tempoPercorrenza, velocitaMax, partenza, arrivo } = preparaRicerca(
    g, mode, opzioni.origineUtm, opzioni.destinazioneUtm,
  )

  const piatto = new Float32Array(g.nTratti).fill(1.0)
  const rapido = dijkstra(
    g, tempoPercorrenza, ammessi, piatto, 1, partenza.nodo, arrivo.nodo, velocitaMax,
  )
  if (rapido === null) {
    throw new Error('nessun percorso trovato fra i due punti in questa modalita\'')
  }

  const minutoPartenza = Math.min(
    Math.max(opzioni.minutoPartenza, esposizione.minutoIniziale),
    esposizione.minutoFinale,
  )

  const tempoMassimo = Math.min(MAX_TRIP_MINUTES, rapido.tempo * fattoreTempoMassimo)
  const nBins = Math.trunc(tempoMassimo / COST_BIN_MINUTES) + 1
  const doseBins = doseSolareBins(esposizione, minutoPartenza, nBins)

  const etichette = frontieraParetoTempoSole(
    g, tempoPercorrenza, ammessi, doseBins, nBins,
    partenza.nodo, arrivo.nodo, velocitaMax, tempoMassimo,
  )

  const percorsi = etichette.map((et) => {
    const { tratti, nodi } = ricostruisciCammino(et)
    return descrivi(g, esposizione, tratti, nodi, minutoPartenza, tempoPercorrenza)
  })

  const fastest = descrivi(g, esposizione, rapido.tratti, rapido.nodi, minutoPartenza, tempoPercorrenza)

  return {
    mode,
    departure_minute: arrotonda(minutoPartenza, 2),
    fastest,
    frontiera: frontieraArrotondataPulita(percorsi),
  }
}

/**
 * Le etichette sono non dominate a piena precisione, ma `descrivi()` arrotonda
 * durata e dose per la UI (2 cifre): su una rete densa due etichette molto
 * vicine possono arrotondare allo stesso valore su un asse e finire per
 * "dominarsi" solo nella rappresentazione mostrata, anche se a piena
 * precisione non lo fanno. Un passaggio Pareto standard sui valori gia'
 * arrotondati -- ordinare per durata (e a parita' di durata per dose, cosi'
 * il primo di un pareggio e' gia' quello migliore) e tenere solo cio' che
 * migliora ancora la dose -- toglie questi doppioni senza toccare
 * `frontieraParetoTempoSole`, che resta corretta sui numeri veri.
 */
function frontieraArrotondataPulita(percorsi: Percorso[]): Percorso[] {
  const ordinata = [...percorsi].sort(
    (a, b) => a.duration_min - b.duration_min || a.sun_dose_min - b.sun_dose_min,
  )
  const pulita: Percorso[] = []
  let doseMinima = Infinity
  for (const p of ordinata) {
    if (p.sun_dose_min < doseMinima) {
      pulita.push(p)
      doseMinima = p.sun_dose_min
    }
  }
  return pulita
}

/**
 * Sceglie un punto della frontiera dato un cursore 0..1, come quello che
 * oggi guida alpha: 0 e' il piu' rapido, 1 il piu' in ombra fra quelli
 * effettivamente non dominati. La scelta e' sul tempo (il percorso il cui
 * tempo e' piu' vicino a "quanto tempo extra sono disposto a spendere",
 * interpolato fra gli estremi della frontiera), non su un peso astratto:
 * e' la stessa grandezza che il testo dei cursori gia' mostra oggi
 * ("al prezzo di N minuti").
 *
 * E' una decisione di UX rimandabile: qui serve solo a dimostrare che, con
 * la frontiera vera in mano, un punto sempre esistito ma mai raggiungibile
 * dalla somma pesata torna finalmente selezionabile.
 */
export function scegliDallaFrontiera(frontiera: Percorso[], preferenza: number): Percorso {
  if (frontiera.length === 0) throw new Error('frontiera vuota')
  const ordinata = [...frontiera].sort((a, b) => a.duration_min - b.duration_min)
  const p = Math.min(1, Math.max(0, preferenza))
  const min = ordinata[0].duration_min
  const max = ordinata[ordinata.length - 1].duration_min
  const target = min + p * (max - min)

  let migliore = ordinata[0]
  let scarto = Infinity
  for (const perc of ordinata) {
    const d = Math.abs(perc.duration_min - target)
    if (d < scarto) {
      scarto = d
      migliore = perc
    }
  }
  return migliore
}

/**
 * Terzo asse (traffico), per quando servira':
 *
 * Basta aggiungere `trafficoDose: number` a `EtichettaPareto` (accumulata con
 * lo stesso schema di `sunDose`, leggendo `trafficoRiga` invece di
 * `doseSolareBins`) ed estendere `domina()` a tre confronti. L'unico rischio
 * reale e' dimensionale: la frontiera puo' crescere molto piu' in fretta con
 * tre assi che con due (ogni etichetta non dominata su (tempo, sole) puo'
 * sdoppiarsi in piu' etichette non dominate su (tempo, sole, traffico)). Se il
 * benchmark a due assi mostra margine, si prova subito a tre pieni; se la
 * frontiera esplode, l'alternativa e' un vincolo-epsilon invece di un terzo
 * asse pieno: tenere solo le etichette (tempo, sole) il cui traffico
 * accumulato resta sotto una soglia, invece di trattarlo come un obiettivo
 * paritario da minimizzare.
 */
