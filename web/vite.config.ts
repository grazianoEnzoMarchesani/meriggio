import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Il worker di MapLibre, servito com'e' sotto `maplibre/`.
 *
 * MapLibre non si porta il worker dentro il bundle: lo cerca a parte, come
 * modulo a se' stante, e senza quel file lo stile non finisce mai di caricarsi
 * e la mappa resta bianca. In sviluppo `optimizeDeps.exclude` basta, perche' i
 * file veri di `node_modules` sono li' a portata di mano; nel build no, e la
 * mappa si rompeva solo una volta pubblicata -- il posto peggiore per
 * accorgersene. Qui i due file vengono messi a disposizione allo stesso
 * indirizzo in entrambi i casi, cosi' quello che si vede in locale e' quello
 * che si vedra' sul server.
 *
 * Sono due perche' il worker importa a sua volta la parte comune, e la cerca
 * accanto a se': devono restare nella stessa cartella.
 */
function workerMapLibre(): Plugin {
  const richiedi = createRequire(import.meta.url)
  const FILE = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
  const leggi = (nome: string) =>
    readFileSync(richiedi.resolve(`maplibre-gl/dist/${nome}`))
  return {
    name: 'maplibre-worker',
    generateBundle() {
      for (const nome of FILE) {
        this.emitFile({ type: 'asset', fileName: `maplibre/${nome}`, source: leggi(nome) })
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const nome = FILE.find((f) => req.url?.split('?')[0]?.endsWith(`/maplibre/${f}`))
        if (!nome) return next()
        res.setHeader('Content-Type', 'text/javascript')
        res.end(leggi(nome))
      })
    },
  }
}

export default defineConfig({
  // Su GitHub Pages, come su Altervista, il sito non sta alla radice del
  // dominio ma in una sottocartella, e i percorsi dei dati devono tenerne
  // conto. Si passa dall'ambiente perche' dipende da dove si pubblica, non da
  // com'e' fatto il programma:
  //
  //     BASE=/ombra/ npm run build      (o `npm run build:altervista`)
  base: process.env.BASE ?? '/',
  plugins: [react(), workerMapLibre()],
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // Niente piu' proxy verso un'API: i dati sono file statici dentro `public`,
  // che in sviluppo Vite serve alla radice e nel build ricopia tali e quali.
  server: { port: 5173 },
})
