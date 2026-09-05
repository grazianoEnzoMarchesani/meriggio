import { distanza, durata, ora } from '../lib/format'
import { useStore } from '../store'

/**
 * Striscia sempre in vista in cima al foglio mobile.
 *
 * A foglio chiuso e' l'unica cosa che si legge, quindi porta la risposta --
 * durata, distanza, quota d'ombra, ora d'arrivo -- senza dover aprire niente.
 * Quando ancora non c'e' un percorso dice il passo successivo. A foglio aperto
 * resta agganciata in alto mentre sotto scorre la configurazione.
 *
 * Un tocco apre il foglio a meta': da chiuso e' il modo naturale di passare
 * dalla risposta ai comandi.
 */
export function MobileRiepilogo({ onApri }: { onApri: () => void }) {
  const s = useStore()

  let corpo
  if (s.errore) {
    corpo = <span className="m-riepilogo__attesa m-riepilogo__attesa--ambra">{s.errore}</span>
  } else if (s.percorso) {
    // Durante un ricalcolo il percorso precedente resta a video (solo un po'
    // smorzato): l'altezza della striscia non cambia e il foglio non sobbalza
    // -- utile soprattutto quando l'ora scorre da sola.
    const p = s.percorso[s.variante]
    corpo = (
      <div className={`m-riepilogo__esito${s.calcolo ? ' m-riepilogo__esito--attesa' : ''}`}>
        <div className="m-riepilogo__numeri">
          <b>{durata(p.duration_min)}</b>
          <span>{distanza(p.distance_m)}</span>
          <span
            className={`pastiglia pastiglia--${s.variante === 'fastest' ? 'sole' : 'ombra'}`}
          >
            {Math.round(p.shade_pct)}% in ombra
          </span>
        </div>
        <div className="m-riepilogo__arrivo">
          {s.calcolo
            ? 'aggiorno il percorso…'
            : `arrivo alle ${ora(p.arrival_instant, s.area?.timezone)}`}
        </div>
      </div>
    )
  } else if (s.calcolo) {
    corpo = (
      <span className="m-riepilogo__attesa">
        <span className="rotella" /> Calcolo del percorso…
      </span>
    )
  } else if (!s.partenza) {
    corpo = <span className="m-riepilogo__attesa">Tocca la mappa per scegliere la partenza.</span>
  } else if (!s.arrivo) {
    corpo = <span className="m-riepilogo__attesa">Ora tocca la mappa per l’arrivo.</span>
  } else {
    corpo = <span className="m-riepilogo__attesa">Pronti: sto per calcolare il percorso.</span>
  }

  return (
    <button className="m-riepilogo" onClick={onApri} aria-label="Apri il pannello del percorso">
      {corpo}
    </button>
  )
}
