import { useSyncExternalStore } from 'react'

/**
 * Vero quando lo schermo e' stretto abbastanza da meritare il layout mobile:
 * mappa a tutto schermo, card del tempo in alto e pannello in un foglio
 * trascinabile dal basso (vedi `MobileSheet`). La stessa soglia di `index.css`.
 */
const QUERY = '(max-width: 900px)'

function iscrivi(notifica: () => void) {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', notifica)
  return () => mq.removeEventListener('change', notifica)
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    iscrivi,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
