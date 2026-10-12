import { useSyncExternalStore } from 'react'

/**
 * Consenso ai servizi esterni.
 *
 * Meriggio non fa nessuna richiesta a terzi finche' chi lo usa non ha risposto:
 *
 *   - `mappa`   sfondo cartografico (OpenFreeMap) e meteo (Open-Meteo). Senza,
 *               l'app non puo' funzionare: i punti si scelgono sulla mappa.
 *   - `ricerca` ricerca di indirizzi (Nominatim di OpenStreetMap). Facoltativa:
 *               restano il clic sulla mappa e il pulsante della posizione.
 *
 * La risposta sta nel browser (`localStorage`) per sei mesi, poi viene chiesta
 * di nuovo. Se cambia cosa viene salvato, va aggiornata anche l'informativa
 * (`components/Informativa.tsx`).
 */

export type Scelta = 'si' | 'no' | 'da-fare'

interface Stato {
  mappa: Scelta
  ricerca: Scelta
  informativa: boolean
}

const CHIAVE = 'meriggio.consenso'
const DURATA_MS = 1000 * 60 * 60 * 24 * 183

function leggi(): Pick<Stato, 'mappa' | 'ricerca'> {
  try {
    const grezzo = window.localStorage.getItem(CHIAVE)
    if (!grezzo) return { mappa: 'da-fare', ricerca: 'da-fare' }
    const { mappa, ricerca, at } = JSON.parse(grezzo) as {
      mappa: 'si' | 'no'
      ricerca: 'si' | 'no'
      at: number
    }
    const valido = (v: unknown) => v === 'si' || v === 'no'
    if (!valido(mappa) || !valido(ricerca) || Date.now() - at > DURATA_MS) {
      return { mappa: 'da-fare', ricerca: 'da-fare' }
    }
    return { mappa, ricerca }
  } catch {
    return { mappa: 'da-fare', ricerca: 'da-fare' }
  }
}

let stato: Stato = { ...leggi(), informativa: false }
const ascoltatori = new Set<() => void>()

function aggiorna(parziale: Partial<Stato>) {
  stato = { ...stato, ...parziale }
  ascoltatori.forEach((a) => a())
}

/** Risposte meteo gia' scaricate: si buttano se il consenso viene tolto. */
function svuotaCacheMeteo() {
  if (typeof caches === 'undefined') return
  void caches
    .keys()
    .then((nomi) =>
      Promise.all(
        nomi
          .filter((n) => n.startsWith('meriggio-meteo-') || n.startsWith('meriggio-vento-'))
          .map((n) => caches.delete(n)),
      ),
    )
    .catch(() => {})
}

/** Registra la scelta e la tiene per sei mesi. */
export function scegli(mappa: 'si' | 'no', ricerca: 'si' | 'no') {
  const effettiva = mappa === 'si' ? ricerca : 'no'
  try {
    window.localStorage.setItem(CHIAVE, JSON.stringify({ mappa, ricerca: effettiva, at: Date.now() }))
  } catch {
    // Archivio bloccato: la scelta vale comunque finche' la scheda resta aperta
  }
  if (mappa === 'no') svuotaCacheMeteo()
  aggiorna({ mappa, ricerca: effettiva })
}

/** Riapre la domanda da capo (da "Rivedi la scelta"). */
export function ripensaci() {
  try {
    window.localStorage.removeItem(CHIAVE)
  } catch {
    /* niente da cancellare */
  }
  svuotaCacheMeteo()
  aggiorna({ mappa: 'da-fare', ricerca: 'da-fare' })
}

export function apriInformativa(aperta: boolean) {
  aggiorna({ informativa: aperta })
}

/** Per il codice che non e' un componente (motore, worker). */
export const consensoMappa = () => stato.mappa === 'si'
export const consensoRicerca = () => stato.ricerca === 'si'

export function useConsenso(): Stato {
  return useSyncExternalStore(
    (cb) => {
      ascoltatori.add(cb)
      return () => ascoltatori.delete(cb)
    },
    () => stato,
  )
}
