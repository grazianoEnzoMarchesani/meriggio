import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useStore } from '../store'
import { Condizioni } from './Condizioni'
import { MobileRiepilogo } from './MobileRiepilogo'

/**
 * Foglio che sale dal basso su mobile, con tre posizioni di riposo.
 *
 *  - `chiuso`: presa + blocco fisso (riepilogo del percorso e meteo), niente
 *    di tagliato a meta';
 *  - `medio`: mezza altezza, per leggere i risultati guardando la mappa;
 *  - `aperto`: quasi pieno, per cursori e impostazioni.
 *
 * Si trascina dalla presa. Un tocco secco sulla presa avanza di una
 * posizione; da `aperto` torna a `chiuso`. Il corpo scorre da solo.
 *
 * Il trascinamento non usa `setPointerCapture`: con il mouse la cattura a
 * volte non viene rilasciata (drag/selezione nativi) e il foglio "si
 * incolla" al puntatore. I `pointermove`/`pointerup` stanno invece su
 * `window`, che l'evento di rilascio lo riceve sempre.
 */

type Stato = 'chiuso' | 'medio' | 'aperto'
const ORDINE: Stato[] = ['chiuso', 'medio', 'aperto']

/** Quanti pixel del foglio restano in vista in ciascuno stato. */
function visibile(stato: Stato, altezza: number, chiuso: number): number {
  // Chiuso: presa + blocco fisso (riepilogo + meteo), misurato -- tutto o
  // niente, mai una card tagliata a meta'.
  if (stato === 'chiuso') return chiuso
  if (stato === 'medio') return altezza * 0.54
  return altezza - 10
}

export function MobileSheet({ children }: { children: ReactNode }) {
  const foglio = useRef<HTMLDivElement>(null)
  const fisso = useRef<HTMLDivElement>(null)
  const off = useRef(0)
  const trascina = useRef<{ y0: number; off0: number; stato: Stato; mosso: boolean } | null>(null)
  const [stato, setStato] = useState<Stato>('chiuso')
  const [attivo, setAttivo] = useState(false)
  const [chiusoPx, setChiusoPx] = useState(200)

  const altezza = useCallback(
    () => foglio.current?.offsetHeight ?? window.innerHeight * 0.9,
    [],
  )
  const offsetPer = useCallback(
    (s: Stato) => Math.max(0, altezza() - visibile(s, altezza(), chiusoPx)),
    [altezza, chiusoPx],
  )

  // Lo scatto "chiuso" mostra esattamente presa + blocco fisso: la misura
  // segue il contenuto (percorso presente o meno, testo a capo, meteo che
  // arriva). La stessa altezza va ai comandi MapLibre in basso, via variabile
  // CSS, perche' non ci finiscano sotto.
  useLayoutEffect(() => {
    const el = fisso.current
    if (!el) return
    const PRESA = 40
    const aggiorna = () => {
      const px = PRESA + el.offsetHeight
      setChiusoPx(px)
      document.documentElement.style.setProperty('--m-foglio-chiuso', `${px}px`)
    }
    aggiorna()
    const ro = new ResizeObserver(aggiorna)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--m-foglio-chiuso')
    }
  }, [])
  const applica = useCallback((valore: number, anima: boolean) => {
    const el = foglio.current
    if (!el) return
    off.current = valore
    el.style.transition = anima ? '' : 'none'
    el.style.transform = `translateY(${valore}px)`
  }, [])

  const muovi = useCallback(
    (e: PointerEvent) => {
      const t = trascina.current
      if (!t) return
      e.preventDefault()
      const dy = e.clientY - t.y0
      if (Math.abs(dy) > 4) t.mosso = true
      applica(Math.min(Math.max(0, t.off0 + dy), offsetPer('chiuso')), false)
    },
    [applica, offsetPer],
  )

  const fine = useCallback(
    (e: PointerEvent) => {
      const t = trascina.current
      trascina.current = null
      window.removeEventListener('pointermove', muovi)
      window.removeEventListener('pointerup', fine)
      window.removeEventListener('pointercancel', fine)
      setAttivo(false)
      if (!t) return

      // Tocco secco: avanza di una posizione, da "aperto" torna a "chiuso".
      if (!t.mosso) {
        const i = ORDINE.indexOf(t.stato)
        setStato(i >= ORDINE.length - 1 ? 'chiuso' : ORDINE[i + 1])
        return
      }

      // Aggancia lo stato piu' vicino alla posizione lasciata...
      let scelto: Stato = 'chiuso'
      let distanza = Infinity
      for (const s of ORDINE) {
        const d = Math.abs(offsetPer(s) - off.current)
        if (d < distanza) {
          distanza = d
          scelto = s
        }
      }
      // ...ma un gesto deciso deve muovere di almeno una posizione nel suo
      // verso, anche se la mano si e' fermata poco oltre lo stato di partenza.
      const dyTot = e.clientY - t.y0
      const partenza = ORDINE.indexOf(t.stato)
      if (dyTot > 52 && ORDINE.indexOf(scelto) >= partenza) {
        scelto = ORDINE[Math.max(0, partenza - 1)]
      } else if (dyTot < -52 && ORDINE.indexOf(scelto) <= partenza) {
        scelto = ORDINE[Math.min(ORDINE.length - 1, partenza + 1)]
      }

      setStato(scelto)
      applica(offsetPer(scelto), true)
    },
    [muovi, applica, offsetPer],
  )

  function giu(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button > 0 || !e.isPrimary) return
    e.preventDefault()
    trascina.current = { y0: e.clientY, off0: off.current, stato, mosso: false }
    setAttivo(true)
    window.addEventListener('pointermove', muovi, { passive: false })
    window.addEventListener('pointerup', fine)
    window.addEventListener('pointercancel', fine)
  }

  // Posizione iniziale e a ogni cambio di stato deciso fuori dal trascinamento.
  useEffect(() => {
    applica(offsetPer(stato), true)
  }, [stato, applica, offsetPer])

  // Il foglio segue rotazione e cambi di viewport (barra URL che appare/sparisce).
  useEffect(() => {
    const ridisegna = () => applica(offsetPer(stato), false)
    window.addEventListener('resize', ridisegna)
    window.addEventListener('orientationchange', ridisegna)
    return () => {
      window.removeEventListener('resize', ridisegna)
      window.removeEventListener('orientationchange', ridisegna)
    }
  }, [stato, applica, offsetPer])

  // Pulizia se il foglio si smonta con un trascinamento in corso.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', muovi)
      window.removeEventListener('pointerup', fine)
      window.removeEventListener('pointercancel', fine)
    },
    [muovi, fine],
  )

  // All'arrivo di un percorso *nuovo*, se era chiuso si apre a meta' per
  // mostrarlo. Solo sulla transizione "niente percorso -> percorso": i
  // ricalcoli di un percorso gia' in vista (cambio di ora, di modalita', dei
  // cursori) non devono far risalire il foglio sotto le mani dell'utente.
  const percorso = useStore((s) => s.percorso)
  const avevaPercorso = useRef(false)
  useEffect(() => {
    const cePercorso = percorso != null
    if (cePercorso && !avevaPercorso.current) {
      setStato((s) => (s === 'chiuso' ? 'medio' : s))
    }
    avevaPercorso.current = cePercorso
  }, [percorso])

  return (
    <div ref={foglio} className={`m-foglio${attivo ? ' m-foglio--attivo' : ''}`}>
      <div
        className="m-foglio__presa"
        onPointerDown={giu}
        role="button"
        tabIndex={0}
        aria-label="Trascina per aprire o chiudere il pannello"
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setStato((s) => ORDINE[Math.min(ORDINE.length - 1, ORDINE.indexOf(s) + 1)])
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setStato((s) => ORDINE[Math.max(0, ORDINE.indexOf(s) - 1)])
          }
        }}
      >
        <span className="m-foglio__barra" />
      </div>
      <div ref={fisso} className="m-foglio__fisso">
        <MobileRiepilogo onApri={() => setStato((s) => (s === 'chiuso' ? 'medio' : s))} />
        <div className="m-foglio__meteo">
          <Condizioni />
        </div>
      </div>
      <div className="m-foglio__corpo">{children}</div>
    </div>
  )
}
