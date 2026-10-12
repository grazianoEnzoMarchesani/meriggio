/**
 * Il calcolo, fuori dal filo dell'interfaccia.
 *
 * Qui dentro gira quello che prima girava sul server: si scaricano grafo e
 * tasselli, si calcolano le ombre e si cerca il percorso. Sta in un worker per
 * un motivo pratico: un attraversamento di citta' al tramonto tiene occupato
 * il processore per qualche decimo di secondo, e sul filo principale sarebbero
 * decimi di secondo in cui la mappa non si muove sotto il dito.
 *
 * Il protocollo e' minimo di proposito: un messaggio con un numero d'ordine,
 * una risposta con lo stesso numero. Chi chiama sta in `lib/motore.ts`.
 */

import { Area } from './area.ts'
import type { Modalita } from './graph.ts'
import { sorgenteRete } from './rete.ts'

export interface DomandaApri {
  tipo: 'apri'
  base: string
}

export interface DomandaPercorso {
  tipo: 'percorso'
  partenza: { lon: number; lat: number }
  arrivo: { lon: number; lat: number }
  modalita: Modalita
  quando: number
  preferenzaOmbra: number
  preferenzaTraffico: number
  ventoLive?: boolean
}

export interface DomandaOmbre {
  tipo: 'ombre'
  bounds: [number, number, number, number]
  quando: number
  latoMax: number
}

export interface DomandaTraffico {
  tipo: 'traffico'
  quando: number
}

export interface DomandaReteTraffico {
  tipo: 'rete-traffico'
  quando: number
}

export type Domanda = (
  | DomandaApri
  | DomandaPercorso
  | DomandaOmbre
  | DomandaTraffico
  | DomandaReteTraffico
) & { id: number }

let area: Area | null = null
let baseCorrente = ''

async function svolgi(d: Domanda): Promise<{ esito: unknown; trasferibili: Transferable[] }> {
  if (d.tipo === 'apri') {
    if (!area || baseCorrente !== d.base) {
      area = await Area.apri(sorgenteRete(d.base))
      baseCorrente = d.base
    }
    return { esito: { pronta: true, slug: area.slug }, trasferibili: [] }
  }

  if (!area) throw new Error('area non ancora aperta')

  if (d.tipo === 'percorso') {
    const esito = await area.percorso({
      partenza: d.partenza,
      arrivo: d.arrivo,
      modalita: d.modalita,
      quando: new Date(d.quando),
      preferenzaOmbra: d.preferenzaOmbra,
      preferenzaTraffico: d.preferenzaTraffico,
      ventoLive: d.ventoLive,
    })
    return { esito, trasferibili: [] }
  }

  if (d.tipo === 'traffico') {
    return { esito: area.livelloTraffico(new Date(d.quando)), trasferibili: [] }
  }

  if (d.tipo === 'rete-traffico') {
    // Le tipizzazioni di `Grafo` sono condivise da tutti i tratti e restano
    // in uso per i percorsi successivi: qui viaggiano per valore (copia
    // strutturata), mai per trasferimento, che le neutralizzerebbe.
    return { esito: area.reteTraffico(new Date(d.quando)), trasferibili: [] }
  }

  const ombre = await area.ombre({
    bounds: d.bounds,
    quando: new Date(d.quando),
    latoMax: d.latoMax,
  })
  // I pixel viaggiano per trasferimento e non per copia: sono qualche
  // megabyte e passarli per valore raddoppierebbe la memoria e il tempo.
  return { esito: ombre, trasferibili: ombre ? [ombre.pixel.buffer] : [] }
}

self.onmessage = async (e: MessageEvent<Domanda>) => {
  const d = e.data
  try {
    const { esito, trasferibili } = await svolgi(d)
    ;(self as unknown as Worker).postMessage({ id: d.id, esito }, trasferibili)
  } catch (errore) {
    ;(self as unknown as Worker).postMessage({
      id: d.id,
      errore: errore instanceof Error ? errore.message : String(errore),
    })
  }
}
