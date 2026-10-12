import { useEffect, useState } from 'react'
import { motore } from '../lib/motore'
import { meteoPer, type MeteoLive } from '../meriggio/meteo'
import { useConsenso } from '../lib/consenso'
import { useStore } from '../store'

/** A specchio di `descriviTraffico` in Panel.tsx, ma sull'indice assoluto (non sul risparmio dello slider). */
function descriviLivelloTraffico(indice: number): string {
  if (indice < 0.15) return 'scarso'
  if (indice < 0.4) return 'moderato'
  if (indice < 0.7) return 'intenso'
  return 'molto intenso'
}

/**
 * Meteo e grado di traffico per l'istante scelto sulla Timeline -- non
 * "adesso", l'ora e il giorno che si sta guardando, stessa convenzione del
 * quadrante solare qui accanto (`SunDial`), che mostra il sole di
 * quell'istante e non quello del momento in cui si guarda lo schermo.
 *
 * Il traffico e' l'indice generale dell'area (non di un percorso preciso),
 * `null` se l'area non porta quell'asse (oggi solo Ascoli Piceno) o se a
 * quell'ora nessun tratto ha un valore sopra zero. Un ritardo breve evita di
 * interrogare rete e worker a ogni pixel mentre si trascina il cursore del
 * tempo.
 */
export function Condizioni() {
  const area = useStore((s) => s.area)
  const dettaglio = useStore((s) => s.dettaglio)
  const giorno = useStore((s) => s.giorno)
  const minuti = useStore((s) => s.minuti)
  const preparazione = useStore((s) => s.preparazione)
  const imposta = useStore((s) => s.imposta)
  const { mappa } = useConsenso()

  const [meteo, setMeteo] = useState<MeteoLive | undefined>(undefined)
  const [traffico, setTraffico] = useState<{ indice: number; copertura: number } | null>(null)

  useEffect(() => {
    if (!area) {
      setMeteo(undefined)
      setTraffico(null)
      return
    }
    let attivo = true
    const timer = window.setTimeout(() => {
      const quando = motore.istante(area.slug, giorno, minuti)

      // Il meteo e' una richiesta a Open-Meteo: solo con il consenso
      if (mappa === 'si') {
        void meteoPer(area.center[0], area.center[1], quando, area.timezone).then((m) => {
          if (attivo) setMeteo(m)
        })
      } else {
        setMeteo(undefined)
      }

      if (dettaglio?.traffic && !preparazione) {
        motore
          .livelloTraffico(quando)
          .then((v) => {
            if (attivo) setTraffico(v)
          })
          .catch(() => {
            if (attivo) setTraffico(null)
          })
      } else {
        setTraffico(null)
      }
    }, 150)
    return () => {
      attivo = false
      window.clearTimeout(timer)
    }
  }, [area, dettaglio, preparazione, giorno, minuti, mappa])

  // Se il traffico sparisce (cambio area, o non piu' un dato per quest'ora)
  // mentre lo strato era acceso, l'elemento su cui si passa il mouse non fa
  // piu' in tempo a generare un `mouseleave`: senza questo la mappa
  // resterebbe con la rete colorata accesa senza modo di spegnerla. Non un
  // `return` di pulizia sullo stesso effetto: quello scatterebbe a ogni
  // nuovo aggiornamento del traffico (anche ogni 30" con "Adesso" attivo),
  // spegnendo lo strato anche mentre lo si sta genuinamente guardando.
  useEffect(() => {
    if (!traffico) imposta({ evidenziaTraffico: false })
  }, [traffico, imposta])

  // Pulizia solo allo smontaggio del widget, non a ogni suo aggiornamento.
  useEffect(() => () => imposta({ evidenziaTraffico: false }), [imposta])

  if (!meteo && !traffico) return null

  return (
    <div className="condizioni">
      {meteo && (
        <>
          <div className="condizioni__riga">
            <b>{Math.round(meteo.temperatura)}°</b> {meteo.descrizione}
          </div>
          <div className="condizioni__dettaglio">
            percepiti {Math.round(meteo.percepita)}° · umidità {Math.round(meteo.umidita)}% · vento{' '}
            {Math.round(meteo.ventoKmh)} km/h
          </div>
        </>
      )}
      {traffico && (
        <div
          className="condizioni__riga condizioni__traffico"
          onMouseEnter={() => imposta({ evidenziaTraffico: true })}
          onMouseLeave={() => imposta({ evidenziaTraffico: false })}
          title="Passa il mouse qui per vedere il traffico su tutte le strade"
        >
          Traffico <b>{descriviLivelloTraffico(traffico.indice)}</b>
        </div>
      )}
    </div>
  )
}
