import { useEffect, useRef } from 'react'
import {
  AttributionControl,
  GeolocateControl,
  Map as MLMap,
  Marker,
  NavigationControl,
  type GeoJSONSource,
  type ImageSource,
  setWorkerUrl,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { motore } from '../lib/motore'
import { useStore, type Punto } from '../store'

// Base cartografica libera, senza chiave d'accesso.
const STILE = 'https://tiles.openfreemap.org/styles/positron'

// Da sola MapLibre cercherebbe il proprio worker accanto al file da cui e'
// stata caricata -- che dopo il bundling e' il pacchetto dell'applicazione, e
// li' quel file non c'e'. Glielo si indica dove il build lo mette davvero
// (vedi `workerMapLibre` in `vite.config.ts`), partendo da `BASE_URL` perche'
// il sito puo' stare in una sottocartella del dominio.
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`)

/** Su schermo stretto il layout mobile cambia dove va lasciato spazio. */
const suMobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches

/**
 * Bordo da lasciare libero attorno a cio' che si inquadra: a sinistra per il
 * pannello desktop, sopra e sotto per la card del tempo e il foglio su mobile.
 */
function riquadro(extraBasso = 0) {
  if (suMobile()) {
    return {
      top: 150,
      bottom: Math.round(window.innerHeight * 0.42) + extraBasso,
      left: 28,
      right: 28,
    }
  }
  return { top: 70, bottom: 150 + extraBasso, left: 410, right: 60 }
}

const SORGENTE_OMBRE = 'ombre'
const SORGENTE_EDIFICI = 'edifici'
const SORGENTE_TERRENO = 'terreno'
const SORGENTE_PERCORSO = 'percorso'
const SORGENTE_ALTERNATIVA = 'alternativa'
const SORGENTE_RETE_TRAFFICO = 'rete-traffico'


function creaSegno(tipo: 'partenza' | 'arrivo') {
  const el = document.createElement('div')
  el.className = `segna segna--${tipo}`
  el.textContent = tipo === 'partenza' ? 'A' : 'B'
  el.title = tipo === 'partenza' ? 'Partenza' : 'Arrivo'
  return el
}

export function MapView() {
  const contenitore = useRef<HTMLDivElement>(null)
  const mappa = useRef<MLMap | null>(null)
  const pronta = useRef(false)
  const segni = useRef<{ partenza?: Marker; arrivo?: Marker }>({})
  const versioneOmbre = useRef(0)
  const indirizzoOmbre = useRef<string | null>(null)

  const area = useStore((s) => s.area)
  const giorno = useStore((s) => s.giorno)
  const minuti = useStore((s) => s.minuti)
  const preparazione = useStore((s) => s.preparazione)
  const istante = useStore((s) => s.istante)
  const partenza = useStore((s) => s.partenza)
  const arrivo = useStore((s) => s.arrivo)
  const percorso = useStore((s) => s.percorso)
  const variante = useStore((s) => s.variante)
  const esagerazione3D = useStore((s) => s.esagerazione3D)
  const evidenziaTraffico = useStore((s) => s.evidenziaTraffico)

  // ---- creazione della mappa ------------------------------------------
  useEffect(() => {
    if (!contenitore.current || mappa.current) return

    const m = new MLMap({
      container: contenitore.current,
      style: STILE,
      center: [12.5, 42.5],
      zoom: 5,
      // L'attribuzione la aggiungiamo noi piu' sotto, con le fonti delle
      // ombre: lasciata anche qui, MapLibre ne piazzava due, una sopra
      // l'altra nell'angolo.
      attributionControl: false,
      maxPitch: 70,
    })
    mappa.current = m
    if (import.meta.env.DEV) (window as unknown as { __mappa: MLMap }).__mappa = m

    // Su mobile lo zoom si fa a due dita: si tiene solo "la mia posizione",
    // cosi' l'angolo in basso a destra resta sgombro sopra il foglio.
    if (!suMobile()) m.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
    m.addControl(new GeolocateControl({ trackUserLocation: false }), 'bottom-right')
    m.addControl(
      new AttributionControl({
        compact: true,
        customAttribution:
          'Ombre: TINITALY (INGV), TUM Global Building Atlas, ETH Canopy Height, Copernicus HRL',
      }),
    )

    m.on('load', () => {
      // Le ombre arrivano come immagine gia' riproiettata: la sorgente viene
      // creata al primo fotogramma disponibile, perche' una sorgente immagine
      // con coordinate nulle manda in errore il calcolo dei tasselli.

      // Edifici estrusi: aiutano a capire da dove nasce ogni ombra
      m.addSource(SORGENTE_EDIFICI, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      m.addLayer({
        id: 'edifici',
        type: 'fill-extrusion',
        source: SORGENTE_EDIFICI,
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#c9c2b6',
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 3],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.55,
        },
      })

      // Traffico su tutta la rete: nascosto di norma (nessuna feature),
      // popolato solo mentre si passa il mouse su "Traffico ..." nel
      // cruscotto (vedi `Condizioni.tsx`). Sopra edifici/ombre, sotto il
      // percorso: e' un'informazione di sfondo sull'intera citta', il
      // percorso scelto deve restare quello che si legge per primo.
      m.addSource(SORGENTE_RETE_TRAFFICO, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      m.addLayer({
        id: SORGENTE_RETE_TRAFFICO,
        type: 'line',
        source: SORGENTE_RETE_TRAFFICO,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 17, 3.5],
          // Scala neutra (grigio, quasi invisibile a traffico nullo) fino al
          // rosso: deliberatamente diversa dalla coppia ambra/verde-acqua
          // usata per sole/ombra, per non confondersi con il percorso
          // disegnato sopra.
          'line-color': ['interpolate', ['linear'], ['get', 'traffico'], 0, '#9aa3b0', 1, '#d1373f'],
          // Proporzionale, non a scatto: la meta' dei tratti sta sotto 0.1
          // (vie secondarie, giustamente quasi invisibili) e il 90-esimo
          // percentile intorno a 0.4 -- una curva che salisse subito
          // all'opacita' piena anche per i valori bassi avrebbe reso tutta
          // la rete ugualmente "rossa", cancellando proprio il confronto
          // che questo strato deve mostrare.
          'line-opacity': ['interpolate', ['linear'], ['get', 'traffico'], 0, 0, 1, 0.85],
        },
      })

      // Percorso alternativo, tratteggiato e in secondo piano
      m.addSource(SORGENTE_ALTERNATIVA, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      m.addLayer({
        id: 'alternativa',
        type: 'line',
        source: SORGENTE_ALTERNATIVA,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#8d96a5',
          'line-width': 3,
          'line-dasharray': [1.6, 1.8],
          'line-opacity': 0.75,
        },
      })

      // Percorso scelto: bordo scuro piu' linea colorata per esposizione
      m.addSource(SORGENTE_PERCORSO, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      m.addLayer({
        id: 'percorso-bordo',
        type: 'line',
        source: SORGENTE_PERCORSO,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
      })
      m.addLayer({
        id: 'percorso',
        type: 'line',
        source: SORGENTE_PERCORSO,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 5.5,
          // Dal verde-acqua dell'ombra all'ambra del pieno sole
          'line-color': [
            'interpolate',
            ['linear'],
            ['get', 'exposure'],
            0,
            '#187a8b',
            0.5,
            '#7fa38a',
            1,
            '#e8892b',
          ],
        },
      })

      pronta.current = true
      m.getCanvas().style.cursor = 'crosshair'
    })

    // Un clic posiziona l'estremo in attesa
    m.on('click', (e: MapMouseEvent) => {
      const { inAttesaDi, impostaPunto } = useStore.getState()
      const punto: Punto = {
        lon: +e.lngLat.lng.toFixed(6),
        lat: +e.lngLat.lat.toFixed(6),
        etichetta: `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`,
      }
      impostaPunto(inAttesaDi, punto)
    })

    return () => {
      m.remove()
      mappa.current = null
      pronta.current = false
      if (indirizzoOmbre.current) URL.revokeObjectURL(indirizzoOmbre.current)
      indirizzoOmbre.current = null
    }
  }, [])

  // ---- inquadratura ed edifici quando cambia l'area --------------------
  useEffect(() => {
    const m = mappa.current
    if (!m || !area) return
    const applica = () => {
      m.fitBounds(area.bounds as [number, number, number, number], {
        padding: riquadro(),
        duration: 900,
      })
      const src = m.getSource(SORGENTE_EDIFICI) as GeoJSONSource | undefined
      if (src) src.setData(motore.edificiUrl(area.slug))

      // Il rilievo cambia con l'area quanto gli edifici: si sostituisce la
      // sorgente invece di riusarla, perche' i tasselli DEM sono legati al
      // riquadro dell'area precedente.
      void motore.terreno(area.slug).then((terreno) => {
        if (mappa.current !== m || useStore.getState().area?.slug !== area.slug) return
        if (m.getTerrain()) m.setTerrain(null)
        if (m.getSource(SORGENTE_TERRENO)) m.removeSource(SORGENTE_TERRENO)
        if (!terreno) return
        m.addSource(SORGENTE_TERRENO, {
          type: 'raster-dem',
          tiles: terreno.tiles,
          tileSize: terreno.tileSize,
          minzoom: terreno.minzoom,
          maxzoom: terreno.maxzoom,
          encoding: terreno.encoding,
        })
        const esagerazione = useStore.getState().esagerazione3D
        if (esagerazione > 0) m.setTerrain({ source: SORGENTE_TERRENO, exaggeration: esagerazione })
      })
    }
    if (pronta.current) applica()
    else m.once('load', applica)
  }, [area])

  // ---- manopola dell'esagerazione del rilievo ---------------------------
  useEffect(() => {
    const m = mappa.current
    if (!m || !pronta.current || !m.getSource(SORGENTE_TERRENO)) return
    m.setTerrain(esagerazione3D > 0 ? { source: SORGENTE_TERRENO, exaggeration: esagerazione3D } : null)
  }, [esagerazione3D])

  // ---- mappa delle ombre all'orario scelto -----------------------------
  //
  // L'immagine non arriva piu' da un server: viene calcolata nel worker sul
  // riquadro che si sta guardando e dipinta su una tela, da cui esce come
  // oggetto temporaneo che la mappa usa come texture. Si ricalcola quando
  // cambia l'ora e quando ci si sposta, sempre con un attimo di attesa perche'
  // trascinare la mappa o il cursore del tempo non scateni una raffica di
  // calcoli di cui si vedrebbe solo l'ultimo.
  useEffect(() => {
    const m = mappa.current
    if (!m || !area || preparazione) return
    let vivo = true
    let ritardo = 0

    const aggiorna = async () => {
      const generazione = ++versioneOmbre.current
      const b = m.getBounds()
      try {
        const dati = await motore.ombre(
          [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
          istante(),
          Math.min(1600, Math.round(m.getCanvas().width * 1.1)),
        )
        // Nel frattempo puo' essere arrivata una richiesta piu' recente:
        // dipingere questa sarebbe un lampeggio all'indietro.
        if (!vivo || generazione !== versioneOmbre.current) return
        if (!dati) {
          if (m.getLayer('ombre')) m.setLayoutProperty('ombre', 'visibility', 'none')
          return
        }

        const tela = document.createElement('canvas')
        tela.width = dati.larghezza
        tela.height = dati.altezza
        tela
          .getContext('2d')
          ?.putImageData(new ImageData(dati.pixel, dati.larghezza, dati.altezza), 0, 0)
        // Un oggetto temporaneo invece di un `data:` lungo qualche milione di
        // caratteri: la mappa vuole un indirizzo, non l'immagine.
        const blob = await new Promise<Blob | null>((r) => tela.toBlob(r, 'image/png'))
        if (!blob || !vivo || generazione !== versioneOmbre.current) return
        const url = URL.createObjectURL(blob)
        const precedente = indirizzoOmbre.current
        indirizzoOmbre.current = url
        // Quello di prima non serve piu' a nessuno: la mappa sta gia'
        // caricando il nuovo.
        if (precedente) URL.revokeObjectURL(precedente)

        const src = m.getSource(SORGENTE_OMBRE) as ImageSource | undefined
        if (src) {
          src.updateImage({ url, coordinates: dati.angoli })
          m.setLayoutProperty('ombre', 'visibility', 'visible')
          return
        }
        m.addSource(SORGENTE_OMBRE, { type: 'image', url, coordinates: dati.angoli })
        // Sotto agli edifici: l'ombra sta a terra, non sui tetti
        m.addLayer(
          {
            id: 'ombre',
            type: 'raster',
            source: SORGENTE_OMBRE,
            paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 180 },
          },
          m.getLayer('edifici') ? 'edifici' : undefined,
        )
      } catch (e) {
        if (vivo) console.warn('ombre non disponibili', e)
      }
    }

    const programma = (attesa: number) => {
      window.clearTimeout(ritardo)
      ritardo = window.setTimeout(aggiorna, attesa)
    }

    programma(260)
    const allaFine = () => programma(400)
    m.on('moveend', allaFine)
    return () => {
      vivo = false
      window.clearTimeout(ritardo)
      m.off('moveend', allaFine)
    }
  }, [area, giorno, minuti, preparazione, istante])

  // ---- contrassegni di partenza e arrivo -------------------------------
  useEffect(() => {
    const m = mappa.current
    if (!m) return

    for (const tipo of ['partenza', 'arrivo'] as const) {
      const punto = tipo === 'partenza' ? partenza : arrivo
      const esistente = segni.current[tipo]

      if (!punto) {
        esistente?.remove()
        delete segni.current[tipo]
        continue
      }
      if (esistente) {
        esistente.setLngLat([punto.lon, punto.lat])
        continue
      }
      const segno = new Marker({ element: creaSegno(tipo), draggable: true })
        .setLngLat([punto.lon, punto.lat])
        .addTo(m)
      segno.on('dragend', () => {
        const p = segno.getLngLat()
        useStore.getState().impostaPunto(tipo, {
          lon: +p.lng.toFixed(6),
          lat: +p.lat.toFixed(6),
          etichetta: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
        })
      })
      segni.current[tipo] = segno
    }
  }, [partenza, arrivo])

  // ---- disegno del percorso --------------------------------------------
  useEffect(() => {
    const m = mappa.current
    if (!m || !pronta.current) return

    const principale = m.getSource(SORGENTE_PERCORSO) as GeoJSONSource | undefined
    const secondaria = m.getSource(SORGENTE_ALTERNATIVA) as GeoJSONSource | undefined
    if (!principale || !secondaria) return

    if (!percorso) {
      principale.setData({ type: 'FeatureCollection', features: [] })
      secondaria.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    const scelto = percorso[variante]
    const altro = percorso[variante === 'shaded' ? 'fastest' : 'shaded']

    principale.setData({
      type: 'FeatureCollection',
      features: scelto.segments.map((s) => ({
        type: 'Feature' as const,
        properties: { exposure: s.exposure, name: s.name },
        geometry: { type: 'LineString' as const, coordinates: [s.from, s.to] },
      })),
    })

    secondaria.setData(
      percorso.comparison.identical
        ? { type: 'FeatureCollection', features: [] }
        : {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature' as const,
                properties: {},
                geometry: { type: 'LineString' as const, coordinates: altro.coordinates },
              },
            ],
          },
    )

    // Inquadra il percorso senza finire sotto al pannello
    const lons = scelto.coordinates.map((c) => c[0])
    const lats = scelto.coordinates.map((c) => c[1])
    m.fitBounds(
      [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      { padding: riquadro(20), duration: 700, maxZoom: 17 },
    )
  }, [percorso, variante])

  // ---- strato con tutta la rete colorata per traffico -------------------
  //
  // Popolato solo mentre `evidenziaTraffico` e' vero (hover su "Traffico
  // ..." nel cruscotto, vedi `Condizioni.tsx`): fuori da li' la sorgente
  // resta vuota, niente da disegnare e niente da scaricare dal worker.
  useEffect(() => {
    const m = mappa.current
    if (!m || !pronta.current) return
    const src = m.getSource(SORGENTE_RETE_TRAFFICO) as GeoJSONSource | undefined
    if (!src) return

    if (!evidenziaTraffico || !area) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    let vivo = true
    void motore.reteTraffico(istante()).then((rete) => {
      // Se nel frattempo il mouse e' uscito, non c'e' piu' motivo di disegnare.
      if (!vivo || !useStore.getState().evidenziaTraffico) return
      if (!rete) {
        src.setData({ type: 'FeatureCollection', features: [] })
        return
      }
      const { nodeLon, nodeLat, edgeU, edgeV, valori } = rete
      const features = []
      for (let e = 0; e < edgeU.length; e++) {
        const u = edgeU[e]
        const v = edgeV[e]
        features.push({
          type: 'Feature' as const,
          properties: { traffico: valori[e] },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [nodeLon[u], nodeLat[u]],
              [nodeLon[v], nodeLat[v]],
            ],
          },
        })
      }
      src.setData({ type: 'FeatureCollection', features })
    })
    return () => {
      vivo = false
    }
  }, [evidenziaTraffico, area, giorno, minuti, istante])

  return <div className="mappa" ref={contenitore} />
}
