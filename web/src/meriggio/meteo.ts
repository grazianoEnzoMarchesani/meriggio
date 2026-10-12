/**
 * Meteo dell'istante scelto (Timeline), per mostrarlo accanto al quadrante
 * solare -- stessa convenzione: non "adesso", l'ora e il giorno che si sta
 * guardando, che puo' essere ieri o fra un mese quanto oggi.
 *
 * Separato da `vento.ts` benche' la fonte sia la stessa (Open-Meteo): quello
 * alimenta un calcolo (il raffinamento OSPM dentro il worker, con un
 * contratto di fallback rigido verso il vento tipico cotto nell'export,
 * sempre e solo "adesso") e vive percio' dentro `area.ts`. Questo modulo
 * serve solo a mostrare qualche numero in un widget, sul filo principale, e
 * se manca semplicemente sparisce -- nessun percorso dipende da questo dato,
 * stesso principio "mai bloccare il routing per una rete esterna" del resto
 * del progetto, qui applicato a un dato puramente informativo.
 */

import { giornoLocale, oraLocale } from './fusi.ts'

export const VERSIONE_METEO = 2
const CACHE_METEO = `meriggio-meteo-v${VERSIONE_METEO}`

// Un giorno intero (le richieste sono per data, non per istante): oltre
// questa soglia una lettura in cache e' comunque da rifare, per lasciare
// spazio a un aggiornamento del modello di previsione. Per un giorno ormai
// passato la risposta non cambierebbe piu', ma tenere un'unica soglia
// invece di distinguere i due casi non vale la complessita' in piu'.
const TTL_MS = 20 * 60 * 1000

export interface MeteoLive {
  temperatura: number
  percepita: number
  umidita: number
  precipitazione: number
  ventoKmh: number
  descrizione: string
}

// Codici WMO ("weather code") della documentazione Open-Meteo: coprono tutti
// i valori che l'API puo' restituire, il resto (valori non elencati) cade
// sul default prudente "condizioni non note" invece di inventare una voce.
const DESCRIZIONI: Record<number, string> = {
  0: 'sereno',
  1: 'poco nuvoloso',
  2: 'parzialmente nuvoloso',
  3: 'coperto',
  45: 'nebbia',
  48: 'nebbia con brina',
  51: 'pioviggine debole',
  53: 'pioviggine moderata',
  55: 'pioviggine intensa',
  56: 'pioviggine gelata debole',
  57: 'pioviggine gelata intensa',
  61: 'pioggia debole',
  63: 'pioggia moderata',
  65: 'pioggia intensa',
  66: 'pioggia gelata debole',
  67: 'pioggia gelata intensa',
  71: 'neve debole',
  73: 'neve moderata',
  75: 'neve intensa',
  77: 'granelli di neve',
  80: 'rovesci deboli',
  81: 'rovesci moderati',
  82: 'rovesci violenti',
  85: 'rovesci di neve deboli',
  86: 'rovesci di neve intensi',
  95: 'temporale',
  96: 'temporale con grandine debole',
  99: 'temporale con grandine forte',
}

export function descriviCodiceMeteo(codice: number): string {
  return DESCRIZIONI[codice] ?? 'condizioni non note'
}

const CAMPI_ORARI =
  'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m'

/**
 * Oltre questa distanza nel passato l'API di previsione non copre piu' un
 * dato affidabile (serve quella storica, con dati finali ma un piccolo
 * ritardo di elaborazione); entro questa soglia -- incluso tutto il futuro,
 * fino all'orizzonte della previsione, circa 16 giorni -- si resta
 * sull'API di previsione. Confine scelto per prudenza, Open-Meteo non ne
 * dichiara uno esatto.
 */
const GIORNI_PASSATO_FORECAST = 5

function sorgente(quando: Date): string {
  const giorniFa = (Date.now() - quando.getTime()) / 86_400_000
  return giorniFa > GIORNI_PASSATO_FORECAST
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast'
}

async function rispostaFresca(url: string): Promise<Response | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    const cache = await caches.open(CACHE_METEO)
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
    await (await caches.open(CACHE_METEO)).put(url, risposta)
  } catch {
    /* se non si puo' conservare, pazienza */
  }
}

/**
 * Basso livello: PUO' lanciare (rete assente, risposta non ok, JSON
 * malformato, data fuori dalla copertura dell'API scelta) -- stesso
 * contratto di `vento.ts`/`rete.ts`.
 */
async function fetchMeteoOra(lon: number, lat: number, quando: Date, fuso: string): Promise<MeteoLive> {
  const giorno = giornoLocale(quando, fuso)
  const url =
    `${sorgente(quando)}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${CAMPI_ORARI}&start_date=${giorno}&end_date=${giorno}` +
    `&timezone=${encodeURIComponent(fuso)}&wind_speed_unit=kmh`

  let risposta = await rispostaFresca(url)
  if (!risposta) {
    risposta = await fetch(url)
    if (!risposta.ok) throw new Error(`meteo: richiesta fallita (${risposta.status})`)
    await conserva(url, risposta.clone())
  }

  const dati = await risposta.json()
  const h = dati?.hourly
  if (!Array.isArray(h?.time) || h.time.length === 0) {
    throw new Error('meteo: risposta senza serie oraria')
  }

  // Con `timezone` passato esplicitamente, Open-Meteo scrive gli orari come
  // ora locale di quel fuso ("AAAA-MM-GGTHH:00"), non UTC: l'ora del punto
  // scelto e' percio' l'indice diretto, un confronto testuale sull'ora
  // invece di riparsare e confrontare istanti assoluti.
  const ora = String(oraLocale(quando, fuso).ore).padStart(2, '0')
  const idx = (h.time as string[]).findIndex((t) => t.endsWith(`T${ora}:00`))
  if (idx < 0) throw new Error('meteo: ora non trovata nella serie')

  const temperatura = h.temperature_2m?.[idx]
  const percepita = h.apparent_temperature?.[idx]
  const umidita = h.relative_humidity_2m?.[idx]
  const precipitazione = h.precipitation?.[idx]
  const codice = h.weather_code?.[idx]
  const ventoKmh = h.wind_speed_10m?.[idx]
  if (
    typeof temperatura !== 'number' ||
    typeof percepita !== 'number' ||
    typeof umidita !== 'number' ||
    typeof precipitazione !== 'number' ||
    typeof codice !== 'number' ||
    typeof ventoKmh !== 'number'
  ) {
    throw new Error('meteo: valori mancanti per questa ora')
  }
  return {
    temperatura,
    percepita,
    umidita,
    precipitazione,
    ventoKmh,
    descrizione: descriviCodiceMeteo(codice),
  }
}

/**
 * Alto livello: non lancia MAI. Ritorna `undefined` su qualunque fallimento
 * (rete assente, o la data e' fuori dalla copertura di entrambe le API,
 * troppo nel futuro o troppo di recente nel passato per lo storico) -- il
 * chiamante (un componente React) nasconde semplicemente il widget.
 *
 * Il `warn` (non `error`, per non sembrare un guasto dell'app) e' l'unico
 * modo per capire *perche'* il widget e' sparito: senza, un blocco di rete
 * (estensione, proxy aziendale, adblock su un dominio di terze parti) e un
 * bug vero sarebbero indistinguibili dall'esterno.
 */
export async function meteoPer(
  lon: number,
  lat: number,
  quando: Date,
  fuso: string,
): Promise<MeteoLive | undefined> {
  try {
    return await fetchMeteoOra(lon, lat, quando, fuso)
  } catch (errore) {
    console.warn('[meriggio] meteo non disponibile:', errore)
    return undefined
  }
}
