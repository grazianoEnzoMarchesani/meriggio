import { create } from 'zustand'
import {
  motore,
  type Area,
  type DettaglioArea,
  type Modalita,
  type RisultatoPercorso,
} from './lib/motore'

export interface Punto {
  lon: number
  lat: number
  etichetta: string
}

type Capolinea = 'partenza' | 'arrivo'

interface Stato {
  aree: Area[]
  area: Area | null
  dettaglio: DettaglioArea | null
  /** vero finche' il worker sta scaricando grafo e manifesto dell'area */
  preparazione: boolean

  partenza: Punto | null
  arrivo: Punto | null
  /** Quale estremo riceve il prossimo clic sulla mappa. */
  inAttesaDi: Capolinea

  modalita: Modalita
  giorno: string
  minuti: number
  seguiOrologio: boolean
  preferenzaOmbra: number
  /** 0 = nessuna deviazione per il traffico, 1 = massima. Ignorata se l'area non ha l'asse traffico. */
  preferenzaTraffico: number
  /** Vero mentre si passa il mouse su "Traffico ..." nel cruscotto: mostra lo strato con tutta la rete sulla mappa. */
  evidenziaTraffico: boolean
  /** Quanto il rilievo viene esagerato in verticale; 0 lo spegne. */
  esagerazione3D: number

  percorso: RisultatoPercorso | null
  variante: 'shaded' | 'fastest'
  calcolo: boolean
  errore: string | null

  caricaAree: () => Promise<void>
  scegliArea: (slug: string) => Promise<void>
  impostaPunto: (quale: Capolinea, punto: Punto | null) => void
  scambia: () => void
  attendi: (quale: Capolinea) => void
  imposta: (patch: Partial<Stato>) => void
  vaiAdesso: () => void
  calcola: () => Promise<void>
  pulisci: () => void
  /** L'istante di partenza scelto, come istante assoluto. */
  istante: () => Date
}

/** Il giorno e l'ora di adesso, nel fuso di chi guarda finche' non c'e' un'area. */
function adessoLocale() {
  const d = new Date()
  const due = (n: number) => String(n).padStart(2, '0')
  return {
    giorno: `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}`,
    minuti: d.getHours() * 60 + d.getMinutes(),
  }
}

export const useStore = create<Stato>((set, get) => ({
  aree: [],
  area: null,
  dettaglio: null,
  preparazione: false,

  partenza: null,
  arrivo: null,
  inAttesaDi: 'partenza',

  modalita: 'foot',
  ...adessoLocale(),
  seguiOrologio: true,
  preferenzaOmbra: 0.6,
  // 0, non 0.6 come il sole: e' un asse nuovo e non rodato, prudente
  // partire senza deviazione finche' l'utente non la chiede esplicitamente.
  preferenzaTraffico: 0,
  evidenziaTraffico: false,
  esagerazione3D: 1.5,

  percorso: null,
  variante: 'shaded',
  calcolo: false,
  errore: null,

  istante() {
    const s = get()
    return s.area
      ? motore.istante(s.area.slug, s.giorno, s.minuti)
      : new Date()
  },

  async caricaAree() {
    try {
      const aree = await motore.aree()
      set({ aree })
      if (aree.length && !get().area) await get().scegliArea(aree[0].slug)
    } catch (e) {
      set({ errore: (e as Error).message })
    }
  },

  async scegliArea(slug) {
    const area = get().aree.find((a) => a.slug === slug) ?? null
    set({
      area,
      partenza: null,
      arrivo: null,
      percorso: null,
      inAttesaDi: 'partenza',
      preparazione: true,
    })
    if (!area) return set({ preparazione: false })
    try {
      // Il dettaglio serve subito all'interfaccia (alba, tramonto); la
      // preparazione del worker scarica il grafo e puo' prendersi il suo tempo.
      const dettaglio = await motore.area(slug, get().giorno)
      // L'ora di partenza e' quella dell'orologio dell'area, non del telefono:
      // se il fuso e' diverso, e' quello che l'utente intende.
      const ora = get().seguiOrologio ? motore.adesso(slug) : {}
      set({ dettaglio, ...ora })
      await motore.preparaArea(slug)
      set({ preparazione: false })
    } catch (e) {
      set({ errore: (e as Error).message, preparazione: false })
    }
  },

  impostaPunto(quale, punto) {
    set({ [quale]: punto, percorso: null, errore: null } as Partial<Stato>)
    const s = get()
    // Dopo aver messo la partenza si passa naturalmente all'arrivo
    if (quale === 'partenza' && punto && !s.arrivo) set({ inAttesaDi: 'arrivo' })
    if (get().partenza && get().arrivo) void get().calcola()
  },

  scambia() {
    const { partenza, arrivo } = get()
    set({ partenza: arrivo, arrivo: partenza, percorso: null })
    if (partenza && arrivo) void get().calcola()
  },

  attendi(quale) {
    set({ inAttesaDi: quale })
  },

  imposta(patch) {
    set(patch as Partial<Stato>)
  },

  vaiAdesso() {
    const s = get()
    set({ ...(s.area ? motore.adesso(s.area.slug) : adessoLocale()), seguiOrologio: true })
    if (s.partenza && s.arrivo) void get().calcola()
  },

  async calcola() {
    const s = get()
    if (!s.area || !s.partenza || !s.arrivo) return
    set({ calcolo: true, errore: null })

    try {
      const percorso = await motore.percorso({
        partenza: { lon: s.partenza.lon, lat: s.partenza.lat },
        arrivo: { lon: s.arrivo.lon, lat: s.arrivo.lat },
        modalita: s.modalita,
        istante: s.istante(),
        preferenzaOmbra: s.preferenzaOmbra,
        preferenzaTraffico: s.preferenzaTraffico,
      })
      set({ percorso, calcolo: false })
    } catch (e) {
      set({ errore: (e as Error).message, calcolo: false, percorso: null })
    }
  },

  pulisci() {
    set({ partenza: null, arrivo: null, percorso: null, errore: null, inAttesaDi: 'partenza' })
  },
}))

// Esposto solo in sviluppo, per ispezione e collaudo dal browser.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __store: typeof useStore }).__store = useStore
}
