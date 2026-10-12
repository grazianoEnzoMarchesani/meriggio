import type { ReactNode } from 'react'
import { apriInformativa } from '../lib/consenso'
import { distanza, durata, ora } from '../lib/format'
import { type Modalita, type Percorso, type RisultatoPercorso } from '../lib/motore'
import { useIsMobile } from '../lib/useIsMobile'
import { useStore } from '../store'
import { CapoInput } from './CapoInput'

const MODALITA: { id: Modalita; nome: string; icona: ReactNode }[] = [
  {
    id: 'foot',
    nome: 'A piedi',
    icona: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13" cy="4" r="1.6" />
        <path d="M12 21l-1.5-5.5L8 13l1-5 3 1.5 2 2.5 2.5 1" />
        <path d="M9 8L6 10l-1 4" />
      </svg>
    ),
  },
  {
    id: 'bike',
    nome: 'In bici',
    icona: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5.5" cy="17" r="3.5" />
        <circle cx="18.5" cy="17" r="3.5" />
        <path d="M12 17l-2.5-6h6l-3 6M14 6h2.5l1.5 4" />
      </svg>
    ),
  },
  {
    id: 'wheelchair',
    nome: 'Carrozzina',
    icona: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="16" r="5" />
        <circle cx="12" cy="3.5" r="1.5" />
        <path d="M11 7v5h5l3 5" />
      </svg>
    ),
  },
]

export function Panel() {
  const s = useStore()
  const mobile = useIsMobile()

  // Traffico e rilievo 3D sono comandi secondari: il primo devia il percorso
  // solo se lo si chiede, il secondo tocca solo la resa della mappa. Su mobile
  // stanno sotto una piega, cosi' il foglio aperto mostra prima il percorso.
  const avanzate = (
    <>
      {/* Gated sul manifesto, non su una stringa di citta': quando l'area
          aperta non ha l'asse traffico (`traffico.calibra` non e' mai
          girata, oggi ogni citta' diversa da Ascoli Piceno) lo slider
          sparisce del tutto invece di restare li' inattivo. */}
      {s.dettaglio?.traffic && (
        <div className="gruppo">
          <div className="gruppo__testa">
            <span className="etichetta">Quanto vuoi evitare il traffico</span>
            <span className="cursore__valore">{descriviTraffico(s.preferenzaTraffico)}</span>
          </div>
          <div className="cursore">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.preferenzaTraffico}
              onChange={(e) => s.imposta({ preferenzaTraffico: +e.target.value })}
              onMouseUp={() => s.partenza && s.arrivo && void s.calcola()}
              onTouchEnd={() => s.partenza && s.arrivo && void s.calcola()}
              onKeyUp={() => s.partenza && s.arrivo && void s.calcola()}
              aria-label="Preferenza per evitare il traffico"
            />
            <div className="cursore__estremi">
              <span>Il più rapido</span>
              <span>Il meno trafficato</span>
            </div>
            {s.percorso && !s.calcolo && (
              <p className={`cursore__esito${esitoTraffico(s.percorso, s.preferenzaTraffico).fermo ? ' cursore__esito--fermo' : ''}`}>
                {esitoTraffico(s.percorso, s.preferenzaTraffico).testo}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="gruppo">
        <div className="gruppo__testa">
          <span className="etichetta">Rilievo 3D</span>
          <span className="cursore__valore">
            {s.esagerazione3D <= 0 ? 'piatto' : `×${s.esagerazione3D.toFixed(1)}`}
          </span>
        </div>
        <div className="cursore">
          <input
            type="range"
            min={0}
            max={3}
            step={0.25}
            value={s.esagerazione3D}
            onChange={(e) => s.imposta({ esagerazione3D: +e.target.value })}
            aria-label="Esagerazione del rilievo"
          />
          <div className="cursore__estremi">
            <span>Piatto</span>
            <span>Esagerato</span>
          </div>
        </div>
      </div>
    </>
  )

  return (
    <aside className="pannello">
      <header className="pannello__testa">
        <div className="marchio">
          <span>{s.area ? s.area.name : 'caricamento…'}</span>
        </div>
        <p className="sottotitolo">
          Il percorso più fresco, non il più breve. Ombre calcolate da terreno,
          edifici e alberi reali, con il sole che si sposta mentre cammini.
        </p>
      </header>

      <div className="pannello__corpo">
        <div className="gruppo">
          <div className="capi">
            <CapoInput tipo="partenza" segnaposto="Punto di partenza" />
            <CapoInput tipo="arrivo" segnaposto="Punto di arrivo" />
            {s.partenza && s.arrivo && (
              <button className="scambia" onClick={s.scambia} title="Inverti partenza e arrivo" aria-label="Inverti partenza e arrivo">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 4v16M7 4L4 7M7 4l3 3M17 20V4M17 20l3-3M17 20l-3-3" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="gruppo">
          <span className="etichetta">Come ti muovi</span>
          <div className="segmentato">
            {MODALITA.map((m) => (
              <button
                key={m.id}
                aria-pressed={s.modalita === m.id}
                onClick={() => {
                  s.imposta({ modalita: m.id })
                  if (s.partenza && s.arrivo) void s.calcola()
                }}
              >
                {m.icona}
                {m.nome}
              </button>
            ))}
          </div>
        </div>

        <div className="gruppo">
          {/* Il valore corrente sta nell'intestazione, non fra gli estremi:
              in mezzo alla riga sotto la barra sembrava la tacca centrale di
              una scala a tre posizioni, invece di dire dov'e' il cursore. */}
          <div className="gruppo__testa">
            <span className="etichetta">Quanto vuoi evitare il sole</span>
            <span className="cursore__valore">{descrivi(s.preferenzaOmbra)}</span>
          </div>
          <div className="cursore">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.preferenzaOmbra}
              onChange={(e) => s.imposta({ preferenzaOmbra: +e.target.value })}
              onMouseUp={() => s.partenza && s.arrivo && void s.calcola()}
              onTouchEnd={() => s.partenza && s.arrivo && void s.calcola()}
              onKeyUp={() => s.partenza && s.arrivo && void s.calcola()}
              aria-label="Preferenza per l’ombra"
            />
            <div className="cursore__estremi">
              <span>Il più rapido</span>
              <span>Il più fresco</span>
            </div>
            {/* Dice a cosa e' servito spostare il cursore: senza, quando il
                margine e' nullo il comando sembra rotto invece che saturo. */}
            {s.percorso && !s.calcolo && (
              <p className={`cursore__esito${esito(s.percorso, s.preferenzaOmbra).fermo ? ' cursore__esito--fermo' : ''}`}>
                {esito(s.percorso, s.preferenzaOmbra).testo}
              </p>
            )}
          </div>
        </div>

        {mobile ? (
          <details className="altre">
            <summary>Altre opzioni</summary>
            <div className="altre__corpo">{avanzate}</div>
          </details>
        ) : (
          avanzate
        )}

        {s.errore && <div className="avviso">{s.errore}</div>}

        {s.calcolo && (
          <div className="caricamento">
            <span className="rotella" />
            Calcolo del percorso…
          </div>
        )}

        {!s.percorso && !s.calcolo && !s.errore && (
          <div className="istruzioni">
            {!s.partenza ? (
              <>
                Fai clic sulla mappa per scegliere la <b>partenza</b>, oppure
                cerca un indirizzo qui sopra.
              </>
            ) : !s.arrivo ? (
              <>
                Ora scegli l’<b>arrivo</b>: un altro clic sulla mappa.
              </>
            ) : null}
          </div>
        )}

        {s.percorso && !s.calcolo && (
          <div className="gruppo">
            <span className="etichetta">Percorsi</span>
            <div className="schede">
              {/* Non "primo e secondo classificato": il primo e' l'esito del
                  cursore, il secondo e' il metro di paragone fisso. */}
              <SchedaPercorso
                percorso={s.percorso.shaded}
                nome="Il tuo percorso"
                tipo="ombra"
                scelta={s.variante === 'shaded'}
                onClick={() => s.imposta({ variante: 'shaded' })}
                nota={
                  s.percorso.comparison.identical
                    ? 'Qui il cursore non trova niente di meglio: è anche il percorso più diretto.'
                    : `${tempoInPiu(s.percorso.comparison.extra_minutes)}, ${Math.round(s.percorso.comparison.sun_dose_saved_pct)}% di sole preso in meno.`
                }
              />
              {!s.percorso.comparison.identical && (
                <SchedaPercorso
                  percorso={s.percorso.fastest}
                  nome="Il più diretto"
                  etichettaRuolo="riferimento"
                  tipo="sole"
                  scelta={s.variante === 'fastest'}
                  onClick={() => s.imposta({ variante: 'fastest' })}
                  nota="Il tragitto più breve, calcolato ignorando l’ombra. Serve da paragone."
                />
              )}
            </div>
            <p className="scheda__nota">
              Arrivo previsto alle{' '}
              {ora(s.percorso[s.variante].arrival_instant, s.area?.timezone)}. Il
              sole passa da {s.percorso[s.variante].sun_start.elevation.toFixed(0)}° a{' '}
              {s.percorso[s.variante].sun_end.elevation.toFixed(0)}° di altezza durante il tragitto.
            </p>
          </div>
        )}

        <button className="link-privacy" onClick={() => apriInformativa(true)}>
          Privacy e consenso
        </button>
      </div>
    </aside>
  )
}

function SchedaPercorso({
  percorso,
  nome,
  etichettaRuolo,
  tipo,
  scelta,
  nota,
  onClick,
}: {
  percorso: Percorso
  nome: string
  /** Chiarisce che la scheda non e' un'alternativa ma un metro di paragone. */
  etichettaRuolo?: string
  tipo: 'ombra' | 'sole'
  scelta: boolean
  nota: string
  onClick: () => void
}) {
  return (
    <button
      className={`scheda${scelta ? ' scheda--scelta' : ''}${tipo === 'sole' ? ' scheda--rapido' : ''}`}
      onClick={onClick}
    >
      <div className="scheda__testa">
        <span className="scheda__nome">
          {nome}
          {etichettaRuolo && <span className="scheda__ruolo">{etichettaRuolo}</span>}
        </span>
        <span className={`pastiglia pastiglia--${tipo}`}>
          {Math.round(percorso.shade_pct)}% in ombra
        </span>
      </div>

      <div className="scheda__numeri">
        <span className="numero">
          <b>{durata(percorso.duration_min)}</b>
          <span>durata</span>
        </span>
        <span className="numero">
          <b>{distanza(percorso.distance_m)}</b>
          <span>distanza</span>
        </span>
      </div>

      <div
        className="barra"
        role="img"
        aria-label={`${Math.round(percorso.shade_pct)} per cento del percorso in ombra`}
      >
        <span className="barra__ombra" style={{ width: `${percorso.shade_pct}%` }} />
      </div>

      <span className="scheda__nota">{nota}</span>
    </button>
  )
}

function descrivi(v: number): string {
  if (v <= 0) return 'nessuna deviazione'
  if (v < 0.15) return 'velocità'
  if (v < 0.4) return 'un po’ d’ombra'
  if (v < 0.7) return 'equilibrio'
  if (v < 0.9) return 'molta ombra'
  return 'ombra a ogni costo'
}

function tempoInPiu(minuti: number): string {
  return minuti >= 0.5 ? `${Math.round(minuti)} min in più` : 'Nessun minuto in più'
}

function descriviTraffico(v: number): string {
  if (v <= 0) return 'nessuna deviazione'
  if (v < 0.15) return 'velocità'
  if (v < 0.4) return 'un po’ meno traffico'
  if (v < 0.7) return 'equilibrio'
  if (v < 0.9) return 'poco traffico'
  return 'meno traffico possibile'
}

/**
 * A specchio di `esito()`, ma sull'asse traffico: usa
 * `comparison.traffic_index_saved_pct` invece di `sun_dose_saved_pct`.
 */
function esitoTraffico(
  r: RisultatoPercorso,
  preferenza: number,
): { testo: string; fermo: boolean } {
  const c = r.comparison
  const risparmio = Math.round(c.traffic_index_saved_pct)

  if (preferenza <= 0) {
    return {
      testo:
        'Cursore al minimo: stai guardando il tragitto più diretto. Alzalo per evitare il traffico.',
      fermo: true,
    }
  }

  if (c.identical) {
    return {
      testo:
        preferenza >= PREFERENZA_ALTA
          ? 'Fra questi due punti non esiste un’alternativa meno trafficata: da qui in su il cursore non cambia più il percorso.'
          : 'A questo livello il percorso resta quello diretto. Alza il cursore per vedere se compare qualcosa di meno trafficato.',
      fermo: true,
    }
  }

  if (risparmio < GUADAGNO_MINIMO_PCT && preferenza >= PREFERENZA_ALTA) {
    return {
      testo:
        'Qui il cursore ha poco margine: anche spinto al massimo, le alternative meno trafficate su questo tragitto sono quasi nulle.',
      fermo: true,
    }
  }

  const prezzo =
    c.extra_minutes >= 0.5
      ? `al prezzo di ${Math.round(c.extra_minutes)} min`
      : 'senza costarti un minuto'
  return {
    testo: `Il cursore ti sta togliendo il ${risparmio}% del traffico, ${prezzo}.`,
    fermo: false,
  }
}

/** Oltre questo valore il cursore e' abbastanza alto da non avere piu' scuse. */
const PREFERENZA_ALTA = 0.7
/** Sotto questa soglia il guadagno e' rumore, non un risultato. */
const GUADAGNO_MINIMO_PCT = 3

/**
 * Che cosa ha ottenuto, in concreto, la posizione attuale del cursore.
 *
 * Serve a distinguere i due modi in cui il cursore puo' "non fare niente":
 * perche' e' basso, o perche' l'ombra qui e' finita. Senza dirlo, un comando
 * saturo sembra un comando rotto.
 */
function esito(
  r: RisultatoPercorso,
  preferenza: number,
): { testo: string; fermo: boolean } {
  const c = r.comparison
  const risparmio = Math.round(c.sun_dose_saved_pct)

  if (preferenza <= 0) {
    return {
      testo:
        'Cursore al minimo: stai guardando il tragitto più diretto. Alzalo per cercare ombra.',
      fermo: true,
    }
  }

  if (c.identical) {
    return {
      testo:
        preferenza >= PREFERENZA_ALTA
          ? 'Fra questi due punti non esiste un’alternativa più fresca: da qui in su il cursore non cambia più il percorso.'
          : 'A questo livello il percorso resta quello diretto. Alza il cursore per vedere se compare qualcosa di più fresco.',
      fermo: true,
    }
  }

  if (risparmio < GUADAGNO_MINIMO_PCT && preferenza >= PREFERENZA_ALTA) {
    return {
      testo:
        'Qui il cursore ha poco margine: anche spinto al massimo, l’ombra disponibile su questo tragitto è quasi nulla.',
      fermo: true,
    }
  }

  const prezzo =
    c.extra_minutes >= 0.5
      ? `al prezzo di ${Math.round(c.extra_minutes)} min`
      : 'senza costarti un minuto'
  return {
    testo: `Il cursore ti sta togliendo il ${risparmio}% del sole, ${prezzo}.`,
    fermo: false,
  }
}
