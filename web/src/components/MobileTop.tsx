import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { SunDial } from './SunDial'
import { Timeline } from './Timeline'

/**
 * Fascia superiore su mobile: bussola del sole e scrubber del tempo, sempre
 * a video. Di norma compatta -- il disco della bussola e l'ora bastano;
 * un tocco la espande per la data e alba/tramonto.
 */
export function MobileTop() {
  const [espanso, setEspanso] = useState(false)

  function alterna() {
    setEspanso((v) => !v)
  }

  // Un tocco sulla card apre/chiude; ma non se cade su un comando
  // (slider del tempo, campo data, "Adesso").
  function tocco(e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('input, button, a')) return
    alterna()
  }

  function tasto(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      alterna()
    }
  }

  return (
    <div className="m-top">
      <div
        className={`m-top__carta${espanso ? ' m-top__carta--espanso' : ''}`}
        onClick={tocco}
        onKeyDown={tasto}
        role="button"
        tabIndex={0}
        aria-expanded={espanso}
        aria-label={espanso ? 'Comprimi la fascia del tempo' : 'Espandi la fascia del tempo'}
      >
        <SunDial />
        <Timeline />
        <svg
          className="m-top__freccia"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </div>
  )
}
