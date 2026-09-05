/** Apertura di un'area esportata leggendola da disco, per test e misure. */

import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { Area, type Sorgente } from '../src/ombra/area.ts'

export const DATI = fileURLToPath(new URL('../public/dati/', import.meta.url))

export function esportata(slug: string): boolean {
  return existsSync(`${DATI}${slug}/manifest.json`)
}

/** Legge i file dell'area dal disco, scompattando quelli compressi. */
export function sorgenteLocale(slug: string): Sorgente {
  return async (percorso: string) => {
    const dati = readFileSync(`${DATI}${slug}/${percorso}`)
    // Il gzip si riconosce dai primi due byte: cosi' la stessa sorgente legge
    // sia i file compressi sia il manifesto in chiaro, come fa quella di rete
    // davanti a un server che decomprime da solo.
    const compresso = dati.length > 2 && dati[0] === 0x1f && dati[1] === 0x8b
    return new Uint8Array(compresso ? gunzipSync(dati) : dati)
  }
}

export function apriLocale(slug: string): Promise<Area> {
  return Area.apri(sorgenteLocale(slug))
}
