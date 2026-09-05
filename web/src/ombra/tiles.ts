/**
 * Lettura dei tasselli di superficie e ricomposizione del mosaico.
 *
 * I tasselli sono blocchi binari scritti da `export.py`: quota in interi a 16
 * bit sopra una base propria del tassello, altezza della chioma e densita'
 * arborea in un byte ciascuna, il tutto filtrato per differenza di riga e
 * compresso. Qui si fa il cammino inverso e si incollano i tasselli richiesti
 * in un unico raster contiguo, che e' la forma in cui `shadow.ts` lavora.
 *
 * Il mosaico non e' mai tutta la citta': si chiedono i tasselli che toccano il
 * corridoio del tragitto, di solito da uno a quattro.
 */

import { affineDaOrigine, type Affine } from './shadow.ts'

const MAGIC = 0x54424d4f // "OMBT" letto come intero little-endian

/**
 * Versione del formato dei tasselli.
 *
 * La 2 ha aggiunto in coda il piano del costruito, e con esso quattro byte di
 * intestazione per il suo passo di quantizzazione. La 1 si legge ancora: un'area
 * esportata prima resta utilizzabile, semplicemente non porta il terreno, e le
 * ombre degli edifici tornano a passare dal raster come facevano allora.
 */
export const VERSIONE_TASSELLI = 2
const HEADER = 28
const HEADER_V1 = 24
const FLAG_CANOPY = 1
const FLAG_TCD = 2
const FLAG_BUILT = 4

export interface Tassello {
  x: number
  y: number
  url: string
  width: number
  height: number
  bytes: number
}

export interface VedutaInsieme {
  url: string
  width: number
  height: number
  resolution: number
  bytes: number
}

export interface GrigliaSuperficie {
  width: number
  height: number
  /** spigolo alto-sinistra del pixel (0, 0), in coordinate UTM */
  origin: [number, number]
  resolution: number
  tile_size: number
  tiles_x: number
  tiles_y: number
  tiles: Tassello[]
  /** tutta l'area in un solo blocco, a risoluzione ridotta */
  overview: VedutaInsieme
  bytes: number
}

export interface TasselloDecodificato {
  width: number
  height: number
  dsm: Float32Array
  canopy: Float32Array | null
  tcd: Float32Array | null
  /** quanto il costruito solleva il terreno: `dsm - built` e' il terreno nudo */
  built: Float32Array | null
}

/** Somma cumulata per riga: inverso del filtro di differenza dell'esportazione. */
function integraRighe16(q: Uint16Array, w: number, h: number): void {
  for (let r = 0; r < h; r++) {
    const base = r * w
    for (let c = 1; c < w; c++) q[base + c] = (q[base + c] + q[base + c - 1]) & 0xffff
  }
}

function integraRighe8(q: Uint8Array, w: number, h: number): void {
  for (let r = 0; r < h; r++) {
    const base = r * w
    for (let c = 1; c < w; c++) q[base + c] = (q[base + c] + q[base + c - 1]) & 0xff
  }
}

/** Decodifica un tassello gia' decompresso. */
export function decodificaTassello(bytes: Uint8Array): TasselloDecodificato {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('tassello non riconosciuto')
  const versione = view.getUint16(4, true)
  if (versione !== VERSIONE_TASSELLI && versione !== 1) {
    throw new Error(`tassello di versione ${versione}`)
  }
  const intestazione = versione === 1 ? HEADER_V1 : HEADER

  const flags = view.getUint16(6, true)
  const width = view.getUint16(8, true)
  const height = view.getUint16(10, true)
  const zOffset = view.getFloat32(12, true)
  const zScale = view.getFloat32(16, true)
  const canopyScale = view.getFloat32(20, true)
  const builtScale = versione === 1 ? 0 : view.getFloat32(24, true)
  const n = width * height

  let off = bytes.byteOffset + intestazione
  // Copia invece di vista: l'offset non e' garantito multiplo di 2 e comunque
  // l'integrazione per riga scrive sui valori.
  const quote = new Uint16Array(bytes.buffer.slice(off, off + n * 2))
  off += n * 2
  integraRighe16(quote, width, height)
  const dsm = new Float32Array(n)
  for (let i = 0; i < n; i++) dsm[i] = Math.fround(quote[i] * zScale + zOffset)

  let canopy: Float32Array | null = null
  if (flags & FLAG_CANOPY) {
    const q = new Uint8Array(bytes.buffer.slice(off, off + n))
    off += n
    integraRighe8(q, width, height)
    canopy = new Float32Array(n)
    for (let i = 0; i < n; i++) canopy[i] = Math.fround(q[i] * canopyScale)
  }

  let tcd: Float32Array | null = null
  if (flags & FLAG_TCD) {
    const q = new Uint8Array(bytes.buffer.slice(off, off + n))
    off += n
    integraRighe8(q, width, height)
    tcd = new Float32Array(n)
    for (let i = 0; i < n; i++) tcd[i] = q[i]
  }

  let built: Float32Array | null = null
  if (flags & FLAG_BUILT) {
    const q = new Uint8Array(bytes.buffer.slice(off, off + n))
    integraRighe8(q, width, height)
    built = new Float32Array(n)
    for (let i = 0; i < n; i++) built[i] = Math.fround(q[i] * builtScale)
  }

  return { width, height, dsm, canopy, tcd, built }
}

export interface Superficie {
  width: number
  height: number
  /** colonna e riga del primo pixel del mosaico dentro il raster dell'area */
  col0: number
  row0: number
  pixelSize: number
  transform: Affine
  dsm: Float32Array
  canopy: Float32Array | null
  tau: Float32Array | null
  /** altezza del costruito sopra il terreno, se l'area la esporta */
  built: Float32Array | null
}

/**
 * Il terreno nudo, senza edifici.
 *
 * Serve a chi disegna le ombre degli edifici per conto suo, in geometria: il
 * raster deve allora occuparsi di tutto il resto, terreno e chiome, senza
 * rifare anche quelle. Se l'area non porta il piano del costruito -- e' il caso
 * di un export vecchio -- si ritorna il DSM, che le ombre le fa comunque tutte.
 */
export function quotaSuolo(s: Superficie): Float32Array {
  if (s.built === null) return s.dsm
  const suolo = new Float32Array(s.dsm.length)
  for (let i = 0; i < suolo.length; i++) suolo[i] = Math.fround(s.dsm[i] - s.built[i])
  return suolo
}

/** Riquadro di pixel, estremo superiore escluso. */
export interface RiquadroPixel {
  col0: number
  row0: number
  col1: number
  row1: number
}

/**
 * Riquadro di pixel che copre un rettangolo in coordinate UTM, tagliato sul
 * raster disponibile. Ritorna null se il rettangolo cade tutto fuori.
 */
export function riquadroPixel(
  griglia: GrigliaSuperficie,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RiquadroPixel | null {
  const res = griglia.resolution
  const [ox, oy] = griglia.origin
  const col0 = Math.max(0, Math.floor((x0 - ox) / res))
  const col1 = Math.min(griglia.width, Math.ceil((x1 - ox) / res))
  // Le righe scendono verso sud, quindi la y maggiore da' la riga minore.
  const row0 = Math.max(0, Math.floor((oy - y1) / res))
  const row1 = Math.min(griglia.height, Math.ceil((oy - y0) / res))
  if (col1 <= col0 || row1 <= row0) return null
  return { col0, row0, col1, row1 }
}

/** Indici dei tasselli che intersecano un riquadro di pixel. */
export function tasselliDi(griglia: GrigliaSuperficie, r: RiquadroPixel): Tassello[] {
  const T = griglia.tile_size
  const tx0 = Math.floor(r.col0 / T)
  const tx1 = Math.floor((r.col1 - 1) / T)
  const ty0 = Math.floor(r.row0 / T)
  const ty1 = Math.floor((r.row1 - 1) / T)
  const out: Tassello[] = []
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) out.push(griglia.tiles[ty * griglia.tiles_x + tx])
  }
  return out
}

/**
 * Incolla i tasselli in un mosaico che copre esattamente il riquadro chiesto.
 *
 * I tasselli sono ritagliati dalla stessa griglia del raster dell'area, quindi
 * rimetterli insieme e' una copia di righe: nessuna riproiezione, nessuna
 * interpolazione, gli stessi pixel che il backend leggerebbe da GeoTIFF.
 */
export function componiSuperficie(
  griglia: GrigliaSuperficie,
  riquadro: RiquadroPixel,
  decodificati: Map<string, TasselloDecodificato>,
  trasmissivita: (tcd: Float32Array) => Float32Array,
): Superficie {
  const T = griglia.tile_size
  const width = riquadro.col1 - riquadro.col0
  const height = riquadro.row1 - riquadro.row0
  const n = width * height

  const dsm = new Float32Array(n)
  let canopy: Float32Array | null = null
  let tcd: Float32Array | null = null
  let built: Float32Array | null = null

  for (const t of tasselliDi(griglia, riquadro)) {
    const dec = decodificati.get(t.url)
    if (!dec) throw new Error(`tassello mancante: ${t.url}`)
    const tc0 = t.x * T
    const tr0 = t.y * T
    // Sovrapposizione fra il tassello e il riquadro, in pixel del raster
    const c0 = Math.max(riquadro.col0, tc0)
    const c1 = Math.min(riquadro.col1, tc0 + dec.width)
    const r0 = Math.max(riquadro.row0, tr0)
    const r1 = Math.min(riquadro.row1, tr0 + dec.height)
    if (c1 <= c0 || r1 <= r0) continue

    if (dec.canopy && !canopy) canopy = new Float32Array(n)
    if (dec.tcd && !tcd) tcd = new Float32Array(n)
    if (dec.built && !built) built = new Float32Array(n)

    const larghezza = c1 - c0
    for (let r = r0; r < r1; r++) {
      const src = (r - tr0) * dec.width + (c0 - tc0)
      const dst = (r - riquadro.row0) * width + (c0 - riquadro.col0)
      dsm.set(dec.dsm.subarray(src, src + larghezza), dst)
      if (dec.canopy && canopy) canopy.set(dec.canopy.subarray(src, src + larghezza), dst)
      if (dec.tcd && tcd) tcd.set(dec.tcd.subarray(src, src + larghezza), dst)
      if (dec.built && built) built.set(dec.built.subarray(src, src + larghezza), dst)
    }
  }

  // Se la vegetazione non sopravanza il terreno da nessuna parte non serve il
  // secondo passaggio di shadow casting, che costa quanto il primo. E' la
  // stessa scorciatoia che il backend prende in `load_surfaces`.
  if (canopy && !canopy.some((v) => v > 0)) {
    canopy = null
    tcd = null
  }

  const res = griglia.resolution
  const originX = griglia.origin[0] + riquadro.col0 * res
  const originY = griglia.origin[1] - riquadro.row0 * res

  return {
    width,
    height,
    col0: riquadro.col0,
    row0: riquadro.row0,
    pixelSize: res,
    transform: affineDaOrigine(originX, originY, res),
    dsm,
    canopy,
    tau: canopy && tcd ? trasmissivita(tcd) : null,
    built,
  }
}

/**
 * La veduta d'insieme come superficie, ritagliata su un riquadro di pixel suoi.
 *
 * Sta gia' tutta in memoria in un blocco solo, quindi non c'e' niente da
 * incollare: si copia la finestra chiesta e si rifa' la geometria alla sua
 * risoluzione, che e' un multiplo di quella dei tasselli.
 */
export function superficieDaVeduta(
  griglia: GrigliaSuperficie,
  veduta: TasselloDecodificato,
  riquadro: RiquadroPixel,
  trasmissivita: (tcd: Float32Array) => Float32Array,
): Superficie {
  const res = griglia.overview.resolution
  const col0 = Math.max(0, Math.min(veduta.width, riquadro.col0))
  const col1 = Math.max(col0, Math.min(veduta.width, riquadro.col1))
  const row0 = Math.max(0, Math.min(veduta.height, riquadro.row0))
  const row1 = Math.max(row0, Math.min(veduta.height, riquadro.row1))
  const width = col1 - col0
  const height = row1 - row0
  const n = width * height

  const dsm = new Float32Array(n)
  const canopy = veduta.canopy ? new Float32Array(n) : null
  const tcd = veduta.tcd ? new Float32Array(n) : null
  const built = veduta.built ? new Float32Array(n) : null
  for (let r = 0; r < height; r++) {
    const src = (row0 + r) * veduta.width + col0
    const dst = r * width
    dsm.set(veduta.dsm.subarray(src, src + width), dst)
    if (canopy && veduta.canopy) canopy.set(veduta.canopy.subarray(src, src + width), dst)
    if (tcd && veduta.tcd) tcd.set(veduta.tcd.subarray(src, src + width), dst)
    if (built && veduta.built) built.set(veduta.built.subarray(src, src + width), dst)
  }

  const usaChiome = canopy !== null && canopy.some((v) => v > 0)
  return {
    width,
    height,
    col0,
    row0,
    pixelSize: res,
    transform: affineDaOrigine(
      griglia.origin[0] + col0 * res,
      griglia.origin[1] - row0 * res,
      res,
    ),
    dsm,
    canopy: usaChiome ? canopy : null,
    tau: usaChiome && tcd ? trasmissivita(tcd) : null,
    built,
  }
}
