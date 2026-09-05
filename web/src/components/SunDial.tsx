import { useEffect, useState } from 'react'
import { motore, type Sole } from '../lib/motore'
import { minutiToOra } from '../lib/format'
import { useStore } from '../store'

/**
 * Quadrante solare: mostra dove sta il sole e, di conseguenza, da che parte
 * cadono le ombre. Il raggio del disco cresce man mano che il sole si
 * abbassa, cosi' la posizione sul quadrante racconta insieme azimut e
 * altezza.
 */
export function SunDial() {
  const area = useStore((s) => s.area)
  const giorno = useStore((s) => s.giorno)
  const minuti = useStore((s) => s.minuti)
  const istante = useStore((s) => s.istante)
  const [sole, setSole] = useState<Sole | null>(null)

  // Il calcolo e' immediato e non tocca la rete: non c'e' piu' niente da
  // attendere, il quadrante segue il cursore del tempo mentre lo si muove.
  useEffect(() => {
    if (!area) return
    let vivo = true
    void motore.sole(area.slug, istante()).then((s) => {
      if (vivo) setSole(s)
    })
    return () => {
      vivo = false
    }
  }, [area, istante, giorno, minuti])

  if (!sole) return null

  const R = 30
  const cx = 34
  const cy = 34
  // Allo zenit il sole sta al centro, all'orizzonte sul bordo
  const r = R * (1 - Math.max(0, sole.elevation) / 90)
  const rad = ((sole.azimuth - 90) * Math.PI) / 180
  const sx = cx + r * Math.cos(rad)
  const sy = cy + r * Math.sin(rad)
  // L'ombra cade dalla parte opposta
  const ox = cx - r * Math.cos(rad) * 0.85
  const oy = cy - r * Math.sin(rad) * 0.85

  return (
    <div className="quadro">
      <svg className="bussola" viewBox="0 0 68 68" role="img" aria-label="Posizione del sole">
        <circle cx={cx} cy={cy} r={R} fill="#fff" stroke="rgba(20,24,31,0.12)" />
        <circle cx={cx} cy={cy} r={R * 0.55} fill="none" stroke="rgba(20,24,31,0.08)" />
        <circle cx={cx} cy={cy} r={1.4} fill="rgba(20,24,31,0.25)" />
        {(['N', 'E', 'S', 'O'] as const).map((p, i) => {
          const a = ((i * 90 - 90) * Math.PI) / 180
          return (
            <text
              key={p}
              x={cx + (R - 6.5) * Math.cos(a)}
              y={cy + (R - 6.5) * Math.sin(a) + 3}
              textAnchor="middle"
              fontSize="7.5"
              fill="#8d96a5"
              fontWeight="600"
            >
              {p}
            </text>
          )
        })}
        {sole.is_daylight && (
          <>
            <line x1={cx} y1={cy} x2={ox} y2={oy} stroke="#187a8b" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
            <line x1={cx} y1={cy} x2={sx} y2={sy} stroke="#e8892b" strokeWidth="1.4" opacity="0.55" />
            <circle cx={sx} cy={sy} r="5" fill="#e8892b" stroke="#fff" strokeWidth="1.6" />
          </>
        )}
        {!sole.is_daylight && (
          <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize="9" fill="#8d96a5">
            notte
          </text>
        )}
      </svg>

      <div className="quadro__dati">
        <div className="quadro__ora">{minutiToOra(minuti)}</div>
        {sole.is_daylight ? (
          <>
            <div className="quadro__riga">
              Sole a <b>{sole.elevation.toFixed(0)}°</b> di altezza
            </div>
            <div className="quadro__riga">
              Ombre verso <b>{direzione(sole.azimuth + 180)}</b>
            </div>
          </>
        ) : (
          <div className="quadro__riga">Sole sotto l’orizzonte</div>
        )}
      </div>
    </div>
  )
}

function direzione(gradi: number): string {
  const punti = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest']
  return punti[Math.round((((gradi % 360) + 360) % 360) / 45) % 8]
}
