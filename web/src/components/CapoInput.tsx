import { useEffect, useRef, useState } from 'react'
import { apriInformativa, scegli as impostaConsenso, useConsenso } from '../lib/consenso'
import { motore, type Luogo } from '../lib/motore'
import { useStore } from '../store'

interface Props {
  tipo: 'partenza' | 'arrivo'
  segnaposto: string
}

/**
 * Campo di un estremo del percorso: mostra il punto scelto, accetta una
 * ricerca testuale e, quando e' attivo, raccoglie il prossimo clic sulla
 * mappa.
 */
export function CapoInput({ tipo, segnaposto }: Props) {
  const punto = useStore((s) => (tipo === 'partenza' ? s.partenza : s.arrivo))
  const attivo = useStore((s) => s.inAttesaDi === tipo)
  const area = useStore((s) => s.area)
  const attendi = useStore((s) => s.attendi)
  const impostaPunto = useStore((s) => s.impostaPunto)
  const consenso = useConsenso()
  const ricercaOk = consenso.ricerca === 'si'

  const [testo, setTesto] = useState('')
  const [cerca, setCerca] = useState(false)
  const [risultati, setRisultati] = useState<Luogo[]>([])
  const [localizzo, setLocalizzo] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Ricerca con attesa, per non interrogare a ogni tasto premuto
  useEffect(() => {
    if (!cerca || !ricercaOk || testo.trim().length < 2 || !area) {
      setRisultati([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        setRisultati(await motore.cerca(testo.trim(), area.slug, ctrl.signal))
      } catch {
        setRisultati([])
      }
    }, 320)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [testo, cerca, area, ricercaOk])

  useEffect(() => {
    if (!cerca) return
    const fuori = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setCerca(false)
        setTesto('')
      }
    }
    document.addEventListener('mousedown', fuori)
    return () => document.removeEventListener('mousedown', fuori)
  }, [cerca])

  function scegli(l: Luogo) {
    impostaPunto(tipo, { lon: l.lon, lat: l.lat, etichetta: l.name })
    setCerca(false)
    setTesto('')
    setRisultati([])
  }

  /**
   * "Dove sono adesso" come estremo del percorso.
   *
   * E' il modo in cui l'applicazione viene usata davvero: fermi in strada, con
   * il sole addosso, a decidere da che parte andare. Digitare l'indirizzo in
   * cui si e' gia' non ha molto senso.
   */
  function usaLaMiaPosizione() {
    if (!navigator.geolocation) return
    setLocalizzo(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocalizzo(false)
        setCerca(false)
        setTesto('')
        impostaPunto(tipo, {
          lon: +p.coords.longitude.toFixed(6),
          lat: +p.coords.latitude.toFixed(6),
          etichetta: 'La mia posizione',
        })
      },
      () => setLocalizzo(false),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  }

  if (cerca) {
    return (
      <div className="cerca" ref={box}>
        <input
          autoFocus
          value={testo}
          placeholder={ricercaOk ? `Cerca ${segnaposto.toLowerCase()}...` : 'Ricerca di indirizzi non attiva'}
          disabled={!ricercaOk}
          onChange={(e) => setTesto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setCerca(false)
              setTesto('')
            }
            if (e.key === 'Enter' && risultati.length) scegli(risultati[0])
          }}
        />
        {(risultati.length > 0 || testo.trim().length < 2 || !ricercaOk) && (
          <div className="suggerimenti">
            {'geolocation' in navigator && (
              <button
                className="suggerimento suggerimento--posizione"
                onClick={usaLaMiaPosizione}
                disabled={localizzo}
              >
                <strong>{localizzo ? 'Ti sto cercando…' : 'La mia posizione'}</strong>
                <small>usa il GPS del dispositivo</small>
              </button>
            )}
            {!ricercaOk && (
              <div className="suggerimento suggerimento--nota">
                <strong>La ricerca di indirizzi è spenta</strong>
                <small>
                  Scegli il punto con un clic sulla mappa, oppure attiva la ricerca: il testo che scrivi verrebbe
                  inviato a Nominatim (OpenStreetMap).
                </small>
                <span className="suggerimento__azioni">
                  <button className="bottone bottone--acceso" onClick={() => impostaConsenso('si', 'si')}>
                    Attiva la ricerca
                  </button>
                  <button className="bottone" onClick={() => apriInformativa(true)}>
                    Informativa
                  </button>
                </span>
              </div>
            )}
            {risultati.map((l, i) => (
              <button
                key={`${l.lon}-${l.lat}-${i}`}
                className={`suggerimento${l.in_area ? '' : ' suggerimento--fuori'}`}
                onClick={() => scegli(l)}
              >
                <strong>{l.name}</strong>
                <small>{l.in_area ? l.full_name : 'fuori dall’area preparata'}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`capo${attivo ? ' capo--attivo' : ''}`}>
      <span className={`capo__punto capo__punto--${tipo}`} />
      <button
        className="capo__testo"
        style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left' }}
        onClick={() => {
          attendi(tipo)
          setCerca(true)
        }}
      >
        <span className={`capo__titolo${punto ? '' : ' capo__titolo--vuoto'}`}>
          {punto ? punto.etichetta : segnaposto}
        </span>
      </button>
      {punto ? (
        <button
          className="capo__x"
          aria-label={`Rimuovi ${segnaposto.toLowerCase()}`}
          onClick={() => impostaPunto(tipo, null)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : (
        <button
          className="capo__x"
          aria-label={`Scegli ${segnaposto.toLowerCase()} sulla mappa`}
          title="Scegli sulla mappa"
          onClick={() => attendi(tipo)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
        </button>
      )}
    </div>
  )
}
