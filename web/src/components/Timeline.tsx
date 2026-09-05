import { useEffect, useMemo, useRef, useState } from 'react'
import { minutiToOra } from '../lib/format'
import { motore } from '../lib/motore'
import { useStore } from '../store'

/**
 * Linea del tempo della giornata. Muovendola cambia l'ora di partenza, e con
 * essa sia le ombre disegnate sulla mappa sia il percorso calcolato: e' il
 * comando che rende evidente quanto il sole cambi le cose.
 */
export function Timeline() {
  const area = useStore((s) => s.area)
  const giorno = useStore((s) => s.giorno)
  const minuti = useStore((s) => s.minuti)
  const seguiOrologio = useStore((s) => s.seguiOrologio)
  const dettaglio = useStore((s) => s.dettaglio)
  const imposta = useStore((s) => s.imposta)
  const calcola = useStore((s) => s.calcola)
  const vaiAdesso = useStore((s) => s.vaiAdesso)
  const percorso = useStore((s) => s.percorso)

  const ricalcolo = useRef<number | undefined>(undefined)
  const [riproduci, setRiproduci] = useState(false)

  // Con "adesso" attivo l'ora avanza da sola insieme all'orologio
  useEffect(() => {
    if (!seguiOrologio || !area) return
    const id = setInterval(() => imposta(motore.adesso(area.slug)), 30_000)
    return () => clearInterval(id)
  }, [seguiOrologio, imposta, area])

  const fuso = area?.timezone
  const alba = useMemo(() => oreDa(dettaglio?.sunrise, fuso), [dettaglio, fuso])
  const tramonto = useMemo(() => oreDa(dettaglio?.sunset, fuso), [dettaglio, fuso])

  // Fascia che distingue notte, giorno e i due crepuscoli
  const fascia = useMemo(() => {
    if (alba == null || tramonto == null) return 'rgba(20,24,31,0.12)'
    const a = (alba / 1440) * 100
    const t = (tramonto / 1440) * 100
    return (
      `linear-gradient(90deg,` +
      ` #2c3550 0%, #2c3550 ${a - 3}%,` +
      ` #e8892b ${a + 1}%, #f6d9a8 ${(a + t) / 2}%, #e8892b ${t - 1}%,` +
      ` #2c3550 ${t + 3}%, #2c3550 100%)`
    )
  }, [alba, tramonto])

  function muovi(v: number) {
    setRiproduci(false)
    imposta({ minuti: v, seguiOrologio: false })
    // Il percorso si ricalcola solo quando il cursore si ferma
    window.clearTimeout(ricalcolo.current)
    if (percorso) ricalcolo.current = window.setTimeout(() => void calcola(), 420)
  }

  // "Play": l'ora scorre da sola a passi di mezz'ora entro l'arco del giorno,
  // ricalcolando ombre e percorso a ogni passo -- si vede come il sole
  // sposta il tragitto migliore nel corso della giornata. Ripreso l'inizio,
  // riparte in ciclo finche' non lo si ferma.
  useEffect(() => {
    if (!riproduci) return
    const inizio = alba != null ? Math.max(0, alba - 30) : 6 * 60
    const fine = tramonto != null ? Math.min(1439, tramonto + 30) : 21 * 60
    let vivo = true
    let attesa: number

    async function passo() {
      const s = useStore.getState()
      const prossimo = s.minuti + 30 > fine ? inizio : s.minuti + 30
      s.imposta({ minuti: prossimo, seguiOrologio: false })
      if (s.percorso) await s.calcola()
      if (vivo) attesa = window.setTimeout(passo, 850)
    }

    attesa = window.setTimeout(passo, 850)
    return () => {
      vivo = false
      window.clearTimeout(attesa)
    }
  }, [riproduci, alba, tramonto])

  return (
    <div className="tempo">
      <div className="tempo__testa">
        <div className="tempo__ora">
          {minutiToOra(minuti)}
          <small>
            {alba != null && tramonto != null
              ? `alba ${minutiToOra(alba)} · tramonto ${minutiToOra(tramonto)}`
              : 'partenza'}
          </small>
        </div>

        <div className="tempo__comandi">
          <button
            className={`bottone bottone--icona${riproduci ? ' bottone--acceso' : ''}`}
            onClick={() => setRiproduci((v) => !v)}
            aria-pressed={riproduci}
            title={riproduci ? 'Ferma' : 'Scorri la giornata, mezz’ora per volta'}
            aria-label={riproduci ? 'Ferma lo scorrimento della giornata' : 'Scorri la giornata, mezz’ora per volta'}
          >
            {riproduci ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="4" width="5" height="16" rx="1" />
                <rect x="14" y="4" width="5" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5Z" />
              </svg>
            )}
          </button>
          <input
            className="data"
            type="date"
            value={giorno}
            onChange={(e) => {
              setRiproduci(false)
              imposta({ giorno: e.target.value, seguiOrologio: false })
              if (percorso) void calcola()
            }}
          />
          <button
            className={`bottone${seguiOrologio ? ' bottone--acceso' : ''}`}
            onClick={() => {
              setRiproduci(false)
              vaiAdesso()
            }}
            title="Torna all’ora attuale"
          >
            Adesso
          </button>
        </div>
      </div>

      <div className="tempo__barra">
        <div className="tempo__fascia" style={{ background: fascia }} />
        <input
          type="range"
          min={0}
          max={1439}
          step={5}
          value={minuti}
          onChange={(e) => muovi(+e.target.value)}
          aria-label="Ora di partenza"
        />
      </div>
    </div>
  )
}

/** Minuti dalla mezzanotte di un istante, letti sull'orologio dell'area. */
function oreDa(iso: string | null | undefined, fuso?: string): number | null {
  if (!iso) return null
  const [ore, minuti] = new Date(iso)
    .toLocaleTimeString('en-GB', { hour12: false, timeZone: fuso })
    .split(':')
    .map(Number)
  return ore * 60 + minuti
}
