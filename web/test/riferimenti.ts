/** Lettura dei valori di riferimento prodotti da `python -m meriggio.cli riferimenti`. */

import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('./riferimenti/', import.meta.url))

export function carica<T>(nome: string): T {
  return JSON.parse(gunzipSync(readFileSync(`${DIR}${nome}.json.gz`)).toString())
}

/** Un array tipizzato ricostruito dal base64 con cui il Python l'ha scritto. */
export function daBase64(b64: string, tipo: 'f4'): Float32Array
export function daBase64(b64: string, tipo: 'f8'): Float64Array
export function daBase64(b64: string, tipo: 'f4' | 'f8'): Float32Array | Float64Array {
  const buf = Buffer.from(b64, 'base64')
  // Il buffer di Node puo' essere una vista dentro un pool condiviso, quindi
  // se ne prende una copia allineata prima di reinterpretarne i byte.
  const copia = new Uint8Array(buf).slice().buffer
  return tipo === 'f4' ? new Float32Array(copia) : new Float64Array(copia)
}

/** Scarto massimo fra due sequenze di numeri, e dove si trova. */
export function scartoMax(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): { max: number; indice: number } {
  if (a.length !== b.length) throw new Error(`lunghezze diverse: ${a.length} e ${b.length}`)
  let max = 0
  let indice = -1
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > max) {
      max = d
      indice = i
    }
  }
  return { max, indice }
}
