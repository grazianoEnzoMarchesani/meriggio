import { useEffect } from 'react'
import { Condizioni } from './components/Condizioni'
import { Consenso } from './components/Consenso'
import { Informativa } from './components/Informativa'
import { MapView } from './components/MapView'
import { MobileSheet } from './components/MobileSheet'
import { MobileTop } from './components/MobileTop'
import { Panel } from './components/Panel'
import { SunDial } from './components/SunDial'
import { Timeline } from './components/Timeline'
import { useConsenso } from './lib/consenso'
import { useIsMobile } from './lib/useIsMobile'
import { useStore } from './store'

export default function App() {
  const caricaAree = useStore((s) => s.caricaAree)
  const mobile = useIsMobile()
  const { mappa } = useConsenso()

  useEffect(() => {
    void caricaAree()
  }, [caricaAree])

  // Finche' non c'e' il consenso la mappa non si monta: nessuna richiesta a terzi
  if (mappa !== 'si') {
    return (
      <>
        <Consenso />
        <Informativa />
      </>
    )
  }

  if (mobile) {
    return (
      <>
        <MapView />
        {/* Fascia sempre visibile: dove sta il sole e a che ora si parte.
            E' il comando che fa muovere le ombre sulla mappa, quindi resta
            fuori dal foglio. */}
        <MobileTop />
        <MobileSheet>
          <Panel />
        </MobileSheet>
        <Informativa />
      </>
    )
  }

  return (
    <>
      <MapView />
      <div className="guscio">
        <Panel />
        <div className="cruscotto">
          <SunDial />
          <Condizioni />
        </div>
        <Timeline />
      </div>
      <Informativa />
    </>
  )
}
