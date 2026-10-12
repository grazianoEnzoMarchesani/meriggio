import { useEffect } from 'react'
import { apriInformativa, scegli, useConsenso } from '../lib/consenso'

const AGGIORNATA = 'ottobre 2026'

/**
 * Informativa sulla privacy. Descrive quello che l'app fa davvero: se cambia
 * un servizio esterno, un dato salvato o una finalita', va cambiata qui nello
 * stesso commit. Le richieste di rete stanno in `lib/motore.ts` (Nominatim),
 * `meriggio/meteo.ts` e `meriggio/vento.ts` (Open-Meteo), `components/MapView.tsx`
 * (OpenFreeMap); il consenso in `lib/consenso.ts`.
 */
export function Informativa() {
  const { informativa, mappa, ricerca } = useConsenso()

  useEffect(() => {
    if (!informativa) return
    const tasto = (e: KeyboardEvent) => {
      if (e.key === 'Escape') apriInformativa(false)
    }
    window.addEventListener('keydown', tasto)
    return () => window.removeEventListener('keydown', tasto)
  }, [informativa])

  if (!informativa) return null

  return (
    <div className="velo velo--alto" onClick={() => apriInformativa(false)}>
      <div
        className="finestra finestra--larga"
        role="dialog"
        aria-modal="true"
        aria-labelledby="informativa-titolo"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="finestra__testa">
          <div>
            <h2 id="informativa-titolo">Informativa sulla privacy</h2>
            <p className="finestra__nota">Ultimo aggiornamento: {AGGIORNATA}</p>
          </div>
          <button className="bottone bottone--icona" aria-label="Chiudi l’informativa" onClick={() => apriInformativa(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="finestra__corpo informativa">
          <h3>In breve</h3>
          <p>
            Meriggio calcola ombre e percorsi <strong>interamente nel tuo browser</strong>. I punti di partenza e di
            arrivo che scegli, e la tua posizione se la usi, non vengono inviati a nessun server. Il sito non usa
            cookie, non raccoglie statistiche, non contiene pubblicità e non profila chi lo visita. Caratteri, librerie
            e dati delle aree sono serviti da questo stesso sito.
          </p>
          <p>
            Per funzionare, però, si collega a servizi di terzi, e <strong>non lo fa finché non dai il consenso</strong>:
            lo sfondo della mappa e il meteo, indispensabili, e la ricerca di indirizzi, facoltativa. Il consenso dura sei
            mesi e puoi cambiarlo quando vuoi da qui sotto.
          </p>

          <div className="informativa__scelta">
            <div className="etichetta">La tua scelta</div>
            <div className="informativa__riga">
              <span>
                Mappa e meteo: <strong>{mappa === 'si' ? 'acconsentito' : mappa === 'no' ? 'rifiutato' : 'non ancora scelto'}</strong>
              </span>
              {mappa === 'si' ? (
                <button className="bottone" onClick={() => scegli('no', 'no')}>
                  Revoca
                </button>
              ) : (
                <button className="bottone bottone--acceso" onClick={() => scegli('si', ricerca === 'si' ? 'si' : 'no')}>
                  Acconsento
                </button>
              )}
            </div>
            <div className="informativa__riga">
              <span>
                Ricerca di indirizzi: <strong>{ricerca === 'si' ? 'acconsentito' : 'non attiva'}</strong>
              </span>
              {ricerca === 'si' ? (
                <button className="bottone" onClick={() => scegli('si', 'no')}>
                  Disattiva
                </button>
              ) : (
                <button className="bottone bottone--acceso" onClick={() => scegli('si', 'si')}>
                  Attiva
                </button>
              )}
            </div>
          </div>

          <h3>1. Titolare del trattamento</h3>
          <p>
            Il titolare è <strong>Graziano Enzo Marchesani</strong>, in qualità di persona fisica. Contatto:{' '}
            <strong>graziano.marchesani [at] unicam.it</strong> (sostituisci <code>[at]</code> con <code>@</code>).
          </p>
          <p>
            Questo è un progetto personale. Sebbene sia nato per attività di ricerca e didattica svolte presso
            l’Università di Camerino, <strong>non è un sito istituzionale: l’Università non lo gestisce né determina le
            finalità dei trattamenti qui descritti</strong>. Non è stato nominato un Responsabile della protezione dei
            dati, non ricorrendone i presupposti (art. 37 GDPR).
          </p>

          <h3>2. Cosa resta sul tuo dispositivo</h3>
          <ul>
            <li>
              <strong>Punti e percorsi.</strong> Partenza, arrivo, il percorso calcolato e, se premi «La mia posizione»,
              le coordinate del dispositivo restano nel browser e si perdono quando chiudi o ricarichi la pagina. Il calcolo
              delle ombre e del percorso avviene sul tuo dispositivo.
            </li>
            <li>
              <strong>Posizione.</strong> Il GPS viene letto solo se premi «La mia posizione», dopo che il browser ti ha
              chiesto il permesso. Il valore serve come punto del percorso e non viene inviato a nessuno.
            </li>
            <li>
              <strong>Nessun cookie.</strong> Non ne viene impostato alcuno.
            </li>
            <li>
              <strong>La tua scelta sul consenso</strong> è l’unico dato che l’app scrive nel <code>localStorage</code>{' '}
              (<code>meriggio.consenso</code>, con la data). Non identifica nessuno e non viene inviato altrove. Dopo{' '}
              <strong>sei mesi</strong> scade e ti viene chiesto di nuovo; puoi cancellarlo in ogni momento dalle
              impostazioni del browser.
            </li>
            <li>
              <strong>Memoria temporanea del browser (Cache API).</strong> Per non riscaricare i dati delle aree
              (<code>meriggio-dati-…</code>, file serviti da questo sito) e le risposte del meteo (<code>meriggio-meteo-…</code>
              e <code>meriggio-vento-…</code>) il browser li conserva. Il meteo si riferisce al centro dell’area, non alla
              tua posizione, e viene cancellato se revochi il consenso.
            </li>
            <li>
              <strong>Nessuna telemetria.</strong> Nessuna analisi del traffico, pixel di tracciamento, pubblicità o
              componente di social network.
            </li>
          </ul>

          <h3>3. Servizi esterni contattati</h3>
          <p>
            A ciascun servizio arriva quello che arriva con qualsiasi richiesta web: il tuo <strong>indirizzo IP</strong>,
            informazioni sul browser (<em>user agent</em>) e l’indirizzo di questo sito (<em>referrer</em>). Ognuno agisce
            come titolare autonomo, secondo la propria informativa.
          </p>
          <div className="informativa__tabella">
            <table>
              <thead>
                <tr>
                  <th>Servizio</th>
                  <th>A cosa serve e cosa vede in più</th>
                  <th>Quando</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>GitHub Pages (GitHub, Inc.)</td>
                  <td>Ospita il sito, compresi i dati delle aree. Conserva i normali log di accesso.</td>
                  <td>Sempre (è da lì che arriva la pagina)</td>
                </tr>
                <tr>
                  <td>
                    <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>
                  </td>
                  <td>
                    Sfondo della mappa (stile, tasselli vettoriali, simboli). Ogni richiesta contiene posizione e zoom,
                    quindi insieme all’IP il fornitore capisce <strong>quale zona stai guardando</strong>.
                  </td>
                  <td>
                    <strong>Solo dopo il consenso</strong> «mappa e meteo»
                  </td>
                </tr>
                <tr>
                  <td>
                    <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer">Open-Meteo</a>
                  </td>
                  <td>
                    Meteo e vento. Riceve le coordinate del <strong>centro dell’area</strong> (la città, non i tuoi punti),
                    il giorno e il fuso orario; il vento solo se il cursore del traffico è attivo.
                  </td>
                  <td>
                    <strong>Solo dopo il consenso</strong> «mappa e meteo»
                  </td>
                </tr>
                <tr>
                  <td>
                    <a href="https://nominatim.org" target="_blank" rel="noopener noreferrer">Nominatim</a> (OpenStreetMap
                    Foundation)
                  </td>
                  <td>
                    Ricerca di indirizzi e luoghi. Riceve <strong>il testo che scrivi nel campo di ricerca</strong> (anche
                    mentre lo digiti, dopo una breve pausa) e il riquadro dell’area. Può essere un indirizzo di casa.
                  </td>
                  <td>
                    <strong>Solo dopo il consenso</strong> «ricerca di indirizzi», e solo quando cerchi
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Nessuno di questi servizi riceve i punti di partenza e arrivo, i percorsi o la tua posizione. GitHub e
            OpenStreetMap Foundation (Regno Unito) operano anche fuori dallo Spazio economico europeo: i trasferimenti
            si basano sul <em>EU–US Data Privacy Framework</em>, sulle clausole contrattuali standard o sulla decisione di
            adeguatezza per il Regno Unito, secondo i casi.
          </p>
          <ul>
            <li>
              <strong>Base giuridica.</strong> Per mappa, meteo e ricerca, il tuo <strong>consenso</strong> (art. 6(1)(a)
              GDPR), revocabile in ogni momento dal riquadro in cima a questa pagina; la revoca non cancella le richieste
              già fatte. Per l’ospitalità del sito, il legittimo interesse del titolare a erogare il servizio (art. 6(1)(f));
              il titolare non ha accesso ai log e non li usa.
            </li>
            <li>
              <strong>Il titolare non raccoglie nulla.</strong> Non gestisce nessun server: non riceve il tuo IP né altri
              dati che ti riguardano. I log restano presso i fornitori.
            </li>
            <li>
              <strong>Se rifiuti la mappa</strong>, Meriggio non può funzionare, perché i punti si scelgono sulla mappa:
              resta una schermata che spiega perché e ti permette di cambiare idea. <strong>Se rifiuti solo la ricerca</strong>,
              tutto funziona: scegli i punti con un clic sulla mappa o con «La mia posizione».
            </li>
          </ul>

          <h3>4. Conservazione</h3>
          <p>
            Il titolare non conserva nulla di ciò che usi. Il consenso resta nel tuo browser fino a sei mesi; i log presso
            i fornitori seguono le loro politiche.
          </p>

          <h3>5. I tuoi diritti</h3>
          <p>
            Puoi esercitare i diritti degli articoli 15-22 GDPR (accesso, rettifica, cancellazione, limitazione,
            portabilità, opposizione) scrivendo all’indirizzo del § 1: riceverai risposta entro un mese. Poiché il titolare
            non detiene altri dati su di te, la maggior parte delle richieste va rivolta ai fornitori del § 3. Puoi
            proporre reclamo al{' '}
            <a href="https://www.garanteprivacy.it" target="_blank" rel="noopener noreferrer">
              Garante per la protezione dei dati personali
            </a>{' '}
            (Piazza Venezia 11, 00187 Roma) o all’autorità del Paese in cui risiedi.
          </p>
          <p>
            Non c’è profilazione né decisioni automatizzate ai sensi dell’art. 22 GDPR. Il sito non è rivolto a minori di
            quattordici anni.
          </p>

          <h3>6. Modifiche</h3>
          <p>
            L’informativa viene aggiornata quando cambiano l’app o la normativa; la data in cima indica l’ultima revisione.
            Il codice è pubblico su{' '}
            <a href="https://github.com/grazianoEnzoMarchesani/meriggio" target="_blank" rel="noopener noreferrer">
              github.com/grazianoEnzoMarchesani/meriggio
            </a>
            , quindi ogni affermazione può essere verificata.
          </p>
        </div>
      </div>
    </div>
  )
}
