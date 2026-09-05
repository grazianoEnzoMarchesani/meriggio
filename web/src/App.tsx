import { useEffect } from 'react'
import { Condizioni } from './components/Condizioni'
import { MapView } from './components/MapView'
import { MobileSheet } from './components/MobileSheet'
import { MobileTop } from './components/MobileTop'
import { Panel } from './components/Panel'
import { SunDial } from './components/SunDial'
import { Timeline } from './components/Timeline'
import { useIsMobile } from './lib/useIsMobile'
import { useStore } from './store'

export default function App() {
  const caricaAree = useStore((s) => s.caricaAree)
  const mobile = useIsMobile()

  useEffect(() => {
    void caricaAree()
  }, [caricaAree])

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
    </>
  )
}
