/**
 * Esposizione solare dei tratti nel tempo, interrogabile a qualsiasi orario.
 *
 * Traduzione di `exposure.py`. Il router deve poter chiedere "quanto sole
 * prende questo tratto alle 15:37?" migliaia di volte per ogni percorso. La
 * risposta viene quindi campionata a istanti discreti e interpolata fra i due
 * piu' vicini: costa un accesso a un array, e il sole si muove con continuita'
 * invece che a scatti.
 */

export class Esposizione {
  /** matrice [istanti x tratti], 0 = ombra piena, 255 = pieno sole */
  readonly esposizione: Uint8Array
  /** minuti dalla mezzanotte del giorno di partenza; puo' superare 1440 */
  readonly minuti: Float32Array
  readonly elevazione: Float32Array
  readonly azimut: Float32Array
  readonly nTratti: number

  constructor(
    esposizione: Uint8Array,
    minuti: Float32Array,
    elevazione: Float32Array,
    azimut: Float32Array,
    nTratti: number,
  ) {
    this.esposizione = esposizione
    this.minuti = minuti
    this.elevazione = elevazione
    this.azimut = azimut
    this.nTratti = nTratti
  }

  get minutoIniziale(): number {
    return this.minuti[0]
  }

  get minutoFinale(): number {
    return this.minuti[this.minuti.length - 1]
  }

  /** Indice dell'istante calcolato piu' vicino a un orario. */
  indiceA(minuto: number): number {
    return Math.min(Math.max(this.cerca(minuto), 0), this.minuti.length - 1)
  }

  /** Come `np.searchsorted`: il primo indice davanti al quale inserire `m`. */
  private cerca(m: number): number {
    let lo = 0
    let hi = this.minuti.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.minuti[mid] < m) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Esposizione di tutti i tratti a un dato orario, in [0, 1].
   *
   * Interpola linearmente fra i due istanti adiacenti: il sole si muove con
   * continuita' e un passo di quindici minuti darebbe altrimenti scalini
   * visibili nei costi.
   */
  riga(minuto: number, dentro?: Float32Array): Float32Array {
    const ultimo = this.minuti.length - 1
    const m = Math.min(Math.max(minuto, this.minuti[0]), this.minuti[ultimo])
    const j = Math.min(Math.max(this.cerca(m), 1), ultimo)
    const m0 = this.minuti[j - 1]
    const m1 = this.minuti[j]
    const w = m1 === m0 ? 0.0 : (m - m0) / (m1 - m0)

    const out = dentro ?? new Float32Array(this.nTratti)
    const base = (j - 1) * this.nTratti
    const succ = j * this.nTratti
    for (let e = 0; e < this.nTratti; e++) {
      const lo = this.esposizione[base + e]
      const hi = this.esposizione[succ + e]
      out[e] = (lo + w * (hi - lo)) / 255.0
    }
    return out
  }

  /** Esposizione di un solo tratto: quello che serve a descrivere un percorso. */
  valore(minuto: number, tratto: number): number {
    const ultimo = this.minuti.length - 1
    const m = Math.min(Math.max(minuto, this.minuti[0]), this.minuti[ultimo])
    const j = Math.min(Math.max(this.cerca(m), 1), ultimo)
    const m0 = this.minuti[j - 1]
    const m1 = this.minuti[j]
    const w = m1 === m0 ? 0.0 : (m - m0) / (m1 - m0)
    const lo = this.esposizione[(j - 1) * this.nTratti + tratto]
    const hi = this.esposizione[j * this.nTratti + tratto]
    return (lo + w * (hi - lo)) / 255.0
  }

  /** Elevazione e azimut del sole a un dato orario. */
  soleA(minuto: number): { elevation: number; azimuth: number } {
    const i = this.indiceA(minuto)
    return { elevation: this.elevazione[i], azimuth: this.azimut[i] }
  }
}
