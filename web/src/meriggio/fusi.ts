/**
 * Ora locale dell'area, senza dipendere da dove si trova chi guarda.
 *
 * Il backend usava `zoneinfo`: il fuso dell'area sta nel manifesto ed e' quello
 * in cui vanno letti gli orari, non quello del dispositivo. Chi programma da
 * Berlino un percorso ad Ascoli per le nove del mattino intende le nove ad
 * Ascoli. Nel browser lo stesso lavoro lo fa `Intl`, che conosce il database
 * dei fusi ed e' gia' dentro alla piattaforma.
 */

const formattatori = new Map<string, Intl.DateTimeFormat>()

function formattatore(fuso: string): Intl.DateTimeFormat {
  let f = formattatori.get(fuso)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formattatori.set(fuso, f)
  }
  return f
}

export interface OraLocale {
  anno: number
  mese: number
  giorno: number
  ore: number
  minuti: number
  secondi: number
}

/** I campi dell'orologio da parete di un fuso, per un istante assoluto. */
export function oraLocale(istante: Date, fuso: string): OraLocale {
  const p = formattatore(fuso).formatToParts(istante)
  const v = (tipo: string) => Number(p.find((x) => x.type === tipo)?.value ?? '0')
  // Alcune piattaforme scrivono la mezzanotte come "24"
  const ore = v('hour') % 24
  return {
    anno: v('year'),
    mese: v('month'),
    giorno: v('day'),
    ore,
    minuti: v('minute'),
    secondi: v('second'),
  }
}

/** Scostamento del fuso da UTC, in millisecondi, a un dato istante. */
function scostamento(istante: Date, fuso: string): number {
  const l = oraLocale(istante, fuso)
  const comeSeUtc = Date.UTC(l.anno, l.mese - 1, l.giorno, l.ore, l.minuti, l.secondi)
  return comeSeUtc - Math.floor(istante.getTime() / 1000) * 1000
}

/**
 * L'istante assoluto in cui, nel fuso indicato, l'orologio segna la data e
 * l'ora date.
 *
 * Si parte dalla lettura ingenua e la si corregge due volte, perche' lo
 * scostamento da applicare dipende dall'istante che si sta cercando: nella
 * notte del cambio d'ora la prima correzione puo' cadere ancora dall'altra
 * parte del salto.
 */
export function istanteLocale(
  fuso: string,
  anno: number,
  mese: number,
  giorno: number,
  ore = 0,
  minuti = 0,
  secondi = 0,
): Date {
  const ingenuo = Date.UTC(anno, mese - 1, giorno, ore, minuti, secondi)
  let ms = ingenuo - scostamento(new Date(ingenuo), fuso)
  ms = ingenuo - scostamento(new Date(ms), fuso)
  return new Date(ms)
}

/** La mezzanotte locale del giorno in cui cade un istante. */
export function mezzanotteLocale(istante: Date, fuso: string): Date {
  const l = oraLocale(istante, fuso)
  return istanteLocale(fuso, l.anno, l.mese, l.giorno)
}

/** Minuti dalla mezzanotte locale, come li conta il router. */
export function minutiDelGiorno(istante: Date, fuso: string): number {
  const l = oraLocale(istante, fuso)
  return l.ore * 60 + l.minuti + l.secondi / 60
}

/** Data locale in forma `AAAA-MM-GG`. */
export function giornoLocale(istante: Date, fuso: string): string {
  const l = oraLocale(istante, fuso)
  const due = (n: number) => String(n).padStart(2, '0')
  return `${l.anno}-${due(l.mese)}-${due(l.giorno)}`
}
