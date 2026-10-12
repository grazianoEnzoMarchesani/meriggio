import { apriInformativa, ripensaci, scegli, useConsenso } from '../lib/consenso'

/**
 * Prima cosa che si vede, finche' non si risponde, e unica cosa che si vede se
 * si rifiuta: senza lo sfondo della mappa Meriggio non puo' funzionare, perche'
 * partenza e arrivo si scelgono li'. Nessuna richiesta a terzi parte prima.
 */
export function Consenso() {
  const { mappa } = useConsenso()

  if (mappa === 'da-fare') {
    return (
      <div className="velo velo--pieno">
        <div className="finestra" role="dialog" aria-modal="true" aria-labelledby="consenso-titolo">
          <div className="finestra__corpo">
            <h2 id="consenso-titolo">Prima di cominciare</h2>
            <p>
              Meriggio calcola ombre e percorsi nel tuo browser: i punti che scegli e la tua posizione{' '}
              <strong>non vengono inviati a nessuno</strong>. Per mostrare la mappa e il meteo, però, si collega a due
              servizi esterni, che così ricevono il tuo <strong>indirizzo IP</strong> e vedono{' '}
              <strong>quale zona stai guardando</strong>:
            </p>
            <ul className="finestra__elenco">
              <li>
                <strong>OpenFreeMap</strong> — lo sfondo della mappa
              </li>
              <li>
                <strong>Open-Meteo</strong> — meteo e vento della città
              </li>
            </ul>
            <p>
              Se vuoi, puoi anche attivare la <strong>ricerca di indirizzi</strong> (Nominatim di OpenStreetMap), che
              riceve il testo che scrivi nel campo di ricerca.
            </p>
            <p className="finestra__nota">
              La tua risposta vale sei mesi e puoi cambiarla in qualsiasi momento da «Privacy e consenso». Senza la mappa
              Meriggio non può funzionare.
            </p>
          </div>
          <div className="finestra__azioni">
            <button className="bottone bottone--grande bottone--acceso" onClick={() => scegli('si', 'si')}>
              Accetto tutto
            </button>
            <button className="bottone bottone--grande" onClick={() => scegli('si', 'no')}>
              Solo mappa e meteo
            </button>
            <button className="bottone bottone--grande" onClick={() => scegli('no', 'no')}>
              Non accetto
            </button>
          </div>
          <button className="finestra__link" onClick={() => apriInformativa(true)}>
            Leggi l’informativa sulla privacy
          </button>
        </div>
      </div>
    )
  }

  // Rifiutato
  return (
    <div className="velo velo--pieno">
      <div className="finestra" role="dialog" aria-modal="true" aria-labelledby="senza-titolo">
        <div className="finestra__corpo">
          <h2 id="senza-titolo">Senza la mappa Meriggio non può partire</h2>
          <p>
            Hai scelto di non collegarti ai servizi esterni. Rispettiamo la scelta e non è stata fatta nessuna richiesta
            a terzi, ma Meriggio ha bisogno della mappa per funzionare: partenza e arrivo si scelgono lì sopra.
          </p>
          <p className="finestra__nota">
            Se hai premuto per errore, o hai cambiato idea, puoi tornare sulla scelta. Il codice è pubblico: chi preferisce
            non usare servizi esterni può eseguire Meriggio in locale, come spiegato nel README del progetto.
          </p>
        </div>
        <div className="finestra__azioni">
          <button className="bottone bottone--grande bottone--acceso" onClick={ripensaci}>
            Rivedi la scelta
          </button>
        </div>
        <button className="finestra__link" onClick={() => apriInformativa(true)}>
          Leggi l’informativa sulla privacy
        </button>
      </div>
    </div>
  )
}
