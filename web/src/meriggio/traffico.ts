/**
 * Helper lato client per l'asse di comfort traffico.
 *
 * Deliberatamente senza alcun ricalcolo OSPM/H-W qui dentro: quella parte
 * gira solo offline in Python (`traffico.py`), mai nel browser. Il client
 * legge solo `Grafo.edgeTraffic` (un array gia' pronto) e applica un unico
 * scalare di raffinamento vento sopra il valore cotto -- superficie molto
 * piu' piccola di quella dell'asse sole.
 */

import type { VentoLive } from './vento.ts'

export interface VentoTipico {
  speed_ms: number
  direction_deg: number | null
}

// Stessa costante del box model server-side (`traffico._WIND_MIN_MS`): la
// velocita' minima di ricircolo che evita la singolarita' a vento calmo.
// Duplicata qui come gia' fa il progetto per altre costanti condivise fra
// Python e TypeScript (es. `COST_BIN_MINUTES` in router.py/router.ts):
// niente configurazione condivisa fra i due linguaggi in questa codebase.
const WIND_MIN_MS = 0.5

// Limiti di sicurezza sul moltiplicatore: un vento live quasi calmo non deve
// far esplodere l'indice, un vento live fortissimo non deve azzerarlo.
const FATTORE_MIN = 0.2
const FATTORE_MAX = 3.0

/**
 * Moltiplicatore da applicare a `edgeTraffic` (gia' calibrato sul vento
 * tipico) per riflettere il vento del momento.
 *
 * `live === undefined` (fetch mai tentato, fallito, o offline) -> sempre
 * 1.0, cioe' "fidati del valore tipico": e' il default prudente, mai
 * un'ipotesi di vento piu' favorevole di quella gia' calibrata.
 *
 * Altrimenti la stessa riduzione a scatola del box model server-side
 * (`traffico._dispersion_ospm_lite`): la concentrazione scala come
 * 1/(vento + velocita' minima di ricircolo), quindi il rapporto fra il
 * vento tipico e quello live da' il fattore di correzione. Solo la
 * velocita' conta, non la direzione: il box model non porta un orientamento
 * per-tratto (vedi `traffico.py`), quindi la direzione live non avrebbe
 * nulla con cui essere confrontata.
 */
export function fattoreVento(tipico: VentoTipico, live: VentoLive | undefined): number {
  if (live === undefined) return 1.0
  const fattore = (tipico.speed_ms + WIND_MIN_MS) / (live.velocita + WIND_MIN_MS)
  return Math.min(FATTORE_MAX, Math.max(FATTORE_MIN, fattore))
}
