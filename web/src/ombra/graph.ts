/**
 * Lettura del grafo percorribile dal blocco binario prodotto da `export.py`.
 *
 * E' la stessa struttura che il backend teneva in un `.npz`: nodi, tratti con
 * lunghezza, pendenza e permessi, e le liste di adiacenza in forma compatta.
 * Cambia solo il contenitore, che qui e' un unico `ArrayBuffer` con le viste
 * tipizzate agli scostamenti giusti: nessun parser, nessuna copia.
 *
 * Due cose che nel `.npz` c'erano e qui no, perche' si ricostruiscono:
 *
 *   - i punti dove campionare l'ombra, che erano due terzi del peso del file
 *     e sono semplicemente distribuiti a passo regolare lungo ogni tratto;
 *   - la quota dei nodi, che serviva solo a calcolare le pendenze, gia' fatte.
 */

// Bit di accesso per modalita', come in `graph.py`
export const FOOT = 1
export const BIKE = 2
export const WHEELCHAIR = 4

export type Modalita = 'foot' | 'bike' | 'wheelchair'

export const MODE_BITS: Record<Modalita, number> = {
  foot: FOOT,
  bike: BIKE,
  wheelchair: WHEELCHAIR,
}

const MAGIC = 0x47424d4f // "OMBG"

/**
 * Versione del formato del grafo.
 *
 * La 2 ha aggiunto in coda `edgeTraffic`, l'indice statico di esposizione al
 * traffico (asse di comfort accanto al sole, oggi solo per Ascoli Piceno). La
 * 3 lo ha reso una matrice `[fasce x tratti]` invece di un vettore, per farlo
 * variare durante il giorno come il sole: subito dopo l'header fisso da 40
 * byte scrive tre scalari (`trafficNFasce`, `trafficFasciaInizio`,
 * `trafficFasciaPasso`, minuti dalla mezzanotte) che nella v1/v2 non esistono
 * affatto, poi l'array appiattito `[nFasce x nTratti]` invece che `[nTratti]`.
 * La 1 e la 2 si leggono ancora: un'area esportata prima resta percorribile,
 * semplicemente con l'asse traffico costante durante la giornata invece che a
 * fasce (v1: zero ovunque; v2: il valore statico di allora, trattato come
 * un'unica fascia che copre tutto il giorno -- `trafficNFasce = 1`).
 */
export const VERSIONE_GRAFO = 3
const HEADER = 40

export interface Grafo {
  nNodi: number
  nTratti: number
  /** coordinate metriche UTM, x e y alternati */
  nodeX: Float64Array
  nodeY: Float64Array
  nodeLon: Float32Array
  nodeLat: Float32Array
  edgeU: Int32Array
  edgeV: Int32Array
  edgeLen: Float32Array
  edgeSlope: Float32Array
  edgeRough: Float32Array
  edgeFlags: Uint8Array
  edgeName: Uint16Array
  /**
   * Indice di esposizione al traffico, appiattito `[trafficNFasce x nTratti]`
   * (riga-major, come `esposizione`): zero se l'area non lo porta (v1, o v2/v3
   * senza calibrazione). Va letto con `trafficoValore`/`trafficoRiga` di
   * `router.ts`, mai indicizzato direttamente con il solo indice del tratto
   * -- quello leggerebbe la fascia sbagliata non appena `trafficNFasce > 1`.
   */
  edgeTraffic: Float32Array
  /** quante fasce orarie porta `edgeTraffic` (1 se l'asse non varia nel tempo: v1/v2, o v3 senza calibrazione) */
  trafficNFasce: number
  /** inizio della prima fascia, minuti dalla mezzanotte locale */
  trafficFasciaInizio: number
  /** durata di una fascia, minuti */
  trafficFasciaPasso: number
  /** quanti punti di campionamento dell'ombra ha ciascun tratto */
  sampleCount: Uint16Array
  /** scostamento del primo campione di ogni tratto, lungo `sampleX`/`sampleY` */
  sampleOffset: Int32Array
  sampleX: Float64Array
  sampleY: Float64Array
  adjStart: Int32Array
  adjTarget: Int32Array
  adjEdge: Int32Array
  nomi: string[]
}

/** Decodifica il grafo da un blocco gia' decompresso. */
export function leggiGrafo(dati: Uint8Array, nomi: string[]): Grafo {
  // Le viste tipizzate vogliono uno scostamento multiplo della loro larghezza.
  // Il blocco arriva quasi sempre all'inizio del proprio buffer, ma un
  // decompressore puo' restituirlo dentro un'area condivisa: in quel caso si
  // paga una copia, una volta per citta'.
  const bytes = dati.byteOffset % 4 === 0 ? dati : new Uint8Array(dati)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('grafo non riconosciuto')
  const versione = view.getUint32(4, true)
  if (versione !== VERSIONE_GRAFO && versione !== 1 && versione !== 2) {
    throw new Error(`grafo di versione ${versione}`)
  }

  const nNodi = view.getUint32(8, true)
  const nTratti = view.getUint32(12, true)
  const nAdiacenze = view.getUint32(16, true)
  const nCampioni = view.getUint32(20, true)
  const originX = view.getFloat64(24, true)
  const originY = view.getFloat64(32, true)

  // Le viste si succedono nell'ordine in cui l'esportazione le ha scritte,
  // ciascuna allineata a quattro byte.
  let off = bytes.byteOffset + HEADER
  const buf = bytes.buffer as ArrayBuffer
  const prendi = <T>(fabbrica: (b: ArrayBuffer, o: number, n: number) => T, n: number, larghezza: number): T => {
    const v = fabbrica(buf, off, n)
    off += n * larghezza
    while (off % 4) off += 1
    return v
  }
  const i32 = (n: number) => prendi((b, o, k) => new Int32Array(b, o, k), n, 4)
  const f32 = (n: number) => prendi((b, o, k) => new Float32Array(b, o, k), n, 4)
  const u16 = (n: number) => prendi((b, o, k) => new Uint16Array(b, o, k), n, 2)
  const u8 = (n: number) => prendi((b, o, k) => new Uint8Array(b, o, k), n, 1)

  const nodeMmX = i32(nNodi)
  const nodeMmY = i32(nNodi)
  const nodeLon = f32(nNodi)
  const nodeLat = f32(nNodi)
  const edgeU = i32(nTratti)
  const edgeV = i32(nTratti)
  const edgeLen = f32(nTratti)
  const edgeSlope = f32(nTratti)
  const edgeRough = f32(nTratti)
  const adjStart = i32(nNodi + 1)
  const adjTarget = i32(nAdiacenze)
  const adjEdge = i32(nAdiacenze)
  const edgeName = u16(nTratti)
  const sampleCount = u16(nTratti)
  const edgeFlags = u8(nTratti)

  // v1: nessun dato di traffico, zero ovunque -- mai un'ipotesi favorevole,
  // solo "quest'area non porta l'asse traffico" (vedi VERSIONE_GRAFO sopra).
  // v2: un valore per tratto, trattato come un'unica fascia che copre tutto
  // il giorno. v3: la griglia di fasce vera, scritta come tre scalari subito
  // prima dell'array -- non fa parte dell'header fisso da 40 byte perche'
  // v1/v2 non la portano affatto.
  let trafficNFasce = 1
  let trafficFasciaInizio = 0
  let trafficFasciaPasso = 15
  let edgeTraffic: Float32Array
  if (versione === 1) {
    edgeTraffic = new Float32Array(nTratti)
  } else if (versione === 2) {
    edgeTraffic = f32(nTratti)
  } else {
    // `view` legge con scostamenti relativi a `bytes.byteOffset`, `off` e'
    // invece assoluto nel buffer (serve tale e quale ai costruttori dei
    // typed array qui sotto): la differenza va tolta solo per queste tre
    // letture dirette.
    const rel = off - bytes.byteOffset
    trafficNFasce = view.getUint32(rel, true)
    trafficFasciaInizio = view.getFloat32(rel + 4, true)
    trafficFasciaPasso = view.getFloat32(rel + 8, true)
    off += 12
    edgeTraffic = f32(trafficNFasce * nTratti)
  }

  // Le coordinate viaggiano come millimetri interi rispetto a un'origine: un
  // intero a 32 bit le porta esatte, la doppia precisione le rimette dov'erano.
  const nodeX = new Float64Array(nNodi)
  const nodeY = new Float64Array(nNodi)
  for (let i = 0; i < nNodi; i++) {
    nodeX[i] = originX + nodeMmX[i] / 1000
    nodeY[i] = originY + nodeMmY[i] / 1000
  }

  // Punti di campionamento dell'ombra: uno ogni ~8 m lungo il tratto, estremi
  // esclusi, cosi' la frazione d'ombra e' rappresentativa di tutto il tratto e
  // non solo del suo centro. E' la ricostruzione di quanto faceva `graph.py`.
  const sampleOffset = new Int32Array(nTratti + 1)
  for (let e = 0; e < nTratti; e++) sampleOffset[e + 1] = sampleOffset[e] + sampleCount[e]
  if (sampleOffset[nTratti] !== nCampioni) {
    throw new Error('il numero di campioni non torna con quello dichiarato')
  }
  const sampleX = new Float64Array(nCampioni)
  const sampleY = new Float64Array(nCampioni)
  for (let e = 0; e < nTratti; e++) {
    const ax = nodeX[edgeU[e]]
    const ay = nodeY[edgeU[e]]
    const bx = nodeX[edgeV[e]]
    const by = nodeY[edgeV[e]]
    const n = sampleCount[e]
    const base = sampleOffset[e]
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n
      sampleX[base + i] = ax + f * (bx - ax)
      sampleY[base + i] = ay + f * (by - ay)
    }
  }

  return {
    nNodi, nTratti,
    nodeX, nodeY, nodeLon, nodeLat,
    edgeU, edgeV, edgeLen, edgeSlope, edgeRough, edgeFlags, edgeName, edgeTraffic,
    trafficNFasce, trafficFasciaInizio, trafficFasciaPasso,
    sampleCount, sampleOffset, sampleX, sampleY,
    adjStart, adjTarget, adjEdge,
    nomi,
  }
}
