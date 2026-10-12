/**
 * Vento live, per raffinare l'indice di traffico gia' cotto nell'export.
 *
 * `traffico.calibra` (backend) cuoce un solo vento "tipico" per area, una
 * volta, offline. Qui si prova a leggere il vento del momento da Open-Meteo
 * e a scostarsi da quel valore tipico solo quando la lettura live c'e'
 * davvero -- mai un'ipotesi, mai un blocco del calcolo del percorso se la
 * rete manca: stesso principio "default prudente" di `live.ts` per il sole,
 * stesso contratto di basso livello di `rete.ts` (la funzione di fetch PUO'
 * lanciare, la degradazione e' compito del chiamante).
 *
 * Cache propria, non quella dei dati statici (`rete.ts`/`VERSIONE_TASSELLI`):
 * il vento ha una vita utile di minuti, non ha senso condividere lo scaffale
 * con tasselli che restano validi finche' l'area non viene ripreparata.
 */

export const VERSIONE_VENTO = 1
const CACHE_VENTO = `meriggio-vento-v${VERSIONE_VENTO}`

// Open-Meteo aggiorna il "current" ogni 15' (dati del modello a 15 minuti):
// oltre questa soglia una lettura in cache e' comunque da rifare.
const TTL_MS = 20 * 60 * 1000

export interface VentoLive {
  velocita: number
  direzione: number
}

async function rispostaFresca(url: string): Promise<Response | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    const cache = await caches.open(CACHE_VENTO)
    const trovata = await cache.match(url)
    if (!trovata) return undefined
    const data = trovata.headers.get('date')
    const eta = data ? Date.now() - new Date(data).getTime() : Infinity
    return eta < TTL_MS ? trovata : undefined
  } catch {
    return undefined // navigazione privata, quota esaurita: si scarica e basta
  }
}

async function conserva(url: string, risposta: Response): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    await (await caches.open(CACHE_VENTO)).put(url, risposta)
  } catch {
    /* se non si puo' conservare, pazienza */
  }
}

/**
 * Basso livello: PUO' lanciare (rete assente, risposta non ok, JSON
 * malformato) -- stesso contratto di `rete.ts`.
 */
async function fetchVentoLive(lon: number, lat: number): Promise<VentoLive> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`

  let risposta = await rispostaFresca(url)
  if (!risposta) {
    risposta = await fetch(url)
    if (!risposta.ok) throw new Error(`vento: richiesta fallita (${risposta.status})`)
    await conserva(url, risposta.clone())
  }

  const dati = await risposta.json()
  const velocita = dati?.current?.wind_speed_10m
  const direzione = dati?.current?.wind_direction_10m
  if (typeof velocita !== 'number' || typeof direzione !== 'number') {
    throw new Error('vento: risposta senza wind_speed_10m/wind_direction_10m')
  }
  return { velocita, direzione }
}

/**
 * Alto livello: non lancia MAI. Ritorna `undefined` su qualunque fallimento
 * -- il chiamante (`area.ts`) sostituisce col vento tipico cotto nell'export,
 * non con un'ipotesi favorevole. Mirror del ruolo di `live.ts` per l'ombra.
 */
export async function ventoCorrente(lon: number, lat: number): Promise<VentoLive | undefined> {
  try {
    return await fetchVentoLive(lon, lat)
  } catch {
    return undefined
  }
}
