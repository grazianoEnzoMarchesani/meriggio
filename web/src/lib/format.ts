/** Formattazione di durate, distanze e orari in italiano. */

export function durata(minuti: number): string {
  const m = Math.round(minuti)
  if (m < 60) return `${m} min`
  const ore = Math.floor(m / 60)
  const resto = m % 60
  return resto === 0 ? `${ore} h` : `${ore} h ${resto} min`
}

export function distanza(metri: number): string {
  if (metri < 950) return `${Math.round(metri / 10) * 10} m`
  return `${(metri / 1000).toFixed(1).replace('.', ',')} km`
}

/**
 * Un orario, letto sull'orologio del luogo di cui si parla.
 *
 * Il fuso va indicato: chi programma da un'altra parte d'Europa un percorso ad
 * Ascoli vuole sapere a che ora arrivera' ad Ascoli, non che ora sara' a casa
 * sua in quel momento.
 */
export function ora(iso: string, fuso?: string): string {
  return new Date(iso).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: fuso,
  })
}

export function minutiToOra(minuti: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minuti)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Colore di un tratto in funzione dell'esposizione al sole.
 * Interpola fra il verde-acqua dell'ombra e l'ambra del pieno sole.
 */
export function coloreEsposizione(e: number): string {
  const t = Math.max(0, Math.min(1, e))
  const ombra = [24, 122, 139]
  const sole = [232, 137, 43]
  const c = ombra.map((v, i) => Math.round(v + (sole[i] - v) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

export const nomeModalita: Record<string, string> = {
  foot: 'A piedi',
  bike: 'In bici',
  wheelchair: 'In carrozzina',
}
