/**
 * I file dell'area presi dalla rete, e tenuti.
 *
 * I dati di una citta' non cambiano mai: un tassello di superficie descrive
 * edifici e alberi come stavano quando l'area e' stata preparata. Vale quindi
 * la pena conservarli davvero, non solo sperare nella cache del browser, che
 * puo' svuotarsi da un momento all'altro. Con la Cache Storage il secondo
 * percorso in un quartiere gia' visitato non scarica nulla, e con un po' di
 * fortuna funziona anche senza rete.
 *
 * **Quello che non cambia mai e' il contenuto, non il formato.** Il giorno in
 * cui i tasselli imparano a portare un piano in piu', quelli conservati
 * diventano di colpo la versione vecchia -- e siccome stanno in un magazzino
 * che sopravvive al ricaricamento forzato, nessun gesto dell'utente li toglie
 * di mezzo. Per questo il magazzino porta la versione del formato nel nome:
 * cambiandola si cambia scaffale, e il vecchio viene buttato alla prima
 * occasione invece di restare a servire dati che il client non sa piu' leggere.
 */

import type { Sorgente } from './area.ts'
import { VERSIONE_GRAFO } from './graph.ts'
import { VERSIONE_TASSELLI } from './tiles.ts'

// Lo scaffale porta entrambe le versioni, non solo quella dei tasselli: sono
// due formati che cambiano in momenti diversi (`graph.bin.gz` e i tasselli
// di superficie non hanno nulla in comune), e un bump dell'uno senza l'altro
// -- come la Fase 4 della variazione oraria, che ha alzato solo
// `VERSIONE_GRAFO` -- deve comunque aprire uno scaffale nuovo. Prima di
// questo, un grafo gia' in Cache Storage da una visita precedente sarebbe
// rimasto li' per sempre: la stessa `url` (`graph.bin.gz` non cambia nome fra
// versioni) trova sempre una corrispondenza in `conservata()`, quindi non
// verrebbe mai riscaricato anche dopo una nuova esportazione sul server.
const CACHE = `ombra-dati-v${VERSIONE_TASSELLI}-g${VERSIONE_GRAFO}`

/** Butta gli scaffali di un formato che non e' piu' quello di adesso. */
let ripulita: Promise<void> | null = null
function ripulisci(): Promise<void> {
  if (ripulita) return ripulita
  ripulita = (async () => {
    if (typeof caches === 'undefined') return
    try {
      const nomi = await caches.keys()
      await Promise.all(
        nomi
          .filter((n) => n.startsWith('ombra-dati-') && n !== CACHE)
          .map((n) => caches.delete(n)),
      )
    } catch {
      /* se non si puo' fare pulizia, si scarica e basta */
    }
  })()
  return ripulita
}

/** Scompatta un blocco gzip, se lo e'. */
async function scompatta(bytes: Uint8Array): Promise<Uint8Array> {
  // I file arrivano compressi perche' sono stati salvati cosi', ma un server
  // puo' benissimo decomprimerli per conto suo prima di consegnarli: il
  // riconoscimento e' sui primi due byte, non sul nome del file.
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const flusso = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(flusso).arrayBuffer())
}

async function conservata(url: string): Promise<Response | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    return await (await caches.open(CACHE)).match(url)
  } catch {
    return undefined // navigazione privata, quota esaurita: si scarica e basta
  }
}

async function conserva(url: string, risposta: Response): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    await (await caches.open(CACHE)).put(url, risposta)
  } catch {
    /* se non si puo' conservare, pazienza */
  }
}

/** Legge i file di un'area da un indirizzo di base, conservandoli. */
export function sorgenteRete(base: string): Sorgente {
  // La base va risolta subito in forma assoluta: `new URL` non accetta un
  // percorso come `/dati/ascoli-piceno/` per basarci sopra un altro percorso.
  const radice =
    typeof location === 'undefined' ? base : new URL(base, location.href).toString()
  return async (percorso: string) => {
    await ripulisci()
    const url = new URL(percorso, radice).toString()
    let risposta = await conservata(url)
    if (!risposta) {
      risposta = await fetch(url)
      if (!risposta.ok) {
        throw new Error(`${percorso}: richiesta fallita (${risposta.status})`)
      }
      await conserva(url, risposta.clone())
    }
    return scompatta(new Uint8Array(await risposta.arrayBuffer()))
  }
}

/** Svuota i dati conservati: serve quando un'area viene ripreparata. */
export async function svuotaCache(): Promise<void> {
  if (typeof caches !== 'undefined') await caches.delete(CACHE)
}
