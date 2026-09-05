/**
 * Le ombre come immagine da sovrapporre alla mappa.
 *
 * Prende il posto di `render.py`. Il raster di soleggiamento vive in coordinate
 * UTM, mentre la mappa ragiona in Web Mercator: fra i due c'e' una rotazione
 * che ad Ascoli vale un grado scarso, cioe' una quarantina di metri ai bordi
 * dell'area. Consegnare l'immagine UTM cosi' com'e', dicendo alla mappa dove
 * stanno i suoi quattro angoli, la farebbe scivolare via dalle strade: va
 * riproiettata, come faceva il backend.
 *
 * La riproiezione e' fatta riga per riga. In Web Mercator una riga di pixel ha
 * latitudine costante e longitudine esattamente proporzionale alla colonna:
 * lungo una riga, quindi, la posizione UTM e' una curva regolarissima, e
 * calcolarla per intero ogni sedici pixel e interpolare in mezzo sbaglia meno
 * di un millimetro.
 *
 * **Sulla resa.** Il calcolo delle ombre sta sulla griglia del modello, e li'
 * resta: e' quello che costa. L'immagine consegnata alla mappa, pero', non ha
 * motivo di fermarsi a un pixel per cella. Se lo fa, la scheda grafica se la
 * ritrova da ingrandire di sette-otto volte e quello che si vede sono i
 * quadrati della griglia, sfocati dall'interpolazione: un difetto di
 * presentazione che si legge come un difetto di calcolo. Qui si prende la
 * strada opposta: la maschera viene ammorbidita di mezza cella e ricampionata
 * a interpolazione bilineare su un'immagine grande quanto lo schermo, dove il
 * bordo dell'ombra diventa una sfumatura di un paio di metri. Non e' dettaglio
 * inventato: e' il margine di incertezza che quel bordo ha davvero, fra la
 * cella del modello e la penombra del disco solare.
 */

import { ombreEdifici, type Edificio } from './edifici.ts'
import { riempi, type Pezzo } from './rasterizza.ts'
import { invertiAffine, sunFactor } from './shadow.ts'
import { quotaSuolo, type Superficie } from './tiles.ts'
import { versoGradi, versoUtm, type Fuso } from './utm.ts'

/**
 * Colore dell'ombra: un blu profondo leggermente freddo, che si legge bene sia
 * su mappa chiara sia su mappa scura.
 */
export const SHADE_RGB: [number, number, number] = [28, 42, 84]
export const MAX_OPACITY = 0.62

const R_TERRA = 6378137.0
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** Ogni quanti pixel si ricalcola per intero la posizione, invece di stimarla. */
const PASSO_CONTROLLO = 16

/**
 * Quanti pixel d'immagine per cella del modello, al massimo.
 *
 * Fra due celle la maschera ammorbidita e' quasi una retta, e l'interpolazione
 * della scheda grafica fra quattro campioni per cella e' indistinguibile da
 * quella esatta. Salire oltre vuol dire calcolare pixel che non aggiungono
 * niente, e mandare alla mappa un'immagine piu' pesante per nulla.
 */
const SOVRACAMPIONAMENTO = 4

/**
 * Da quanti pixel per cella in su la maschera viene ammorbidita, e dove la
 * dose arriva al massimo.
 *
 * L'ammorbidimento serve solo contro i quadretti, cioe' quando una cella del
 * modello copre parecchi pixel di schermo. Da lontano, dove una cella vale un
 * pixel o poco piu', gli stessi quadretti non ci sono e sfumare butterebbe via
 * dettaglio vero: la dose scende a zero da sola.
 */
const MORBIDEZZA_DA = 20
const MORBIDEZZA_A = 4

/**
 * Ammorbidisce la maschera con un binomiale 1-2-1 dosato da `peso`.
 *
 * A piena dose il bordo dell'ombra si allarga di circa una cella: su un
 * modello a un metro sono i due metri scarsi di penombra che il sole, che non
 * e' un punto ma un disco di mezzo grado, disegna davvero a una cinquantina di
 * metri dall'ostacolo. Il filtro e' separabile, quindi sono due passate lineari
 * sulla griglia: rispetto allo shadow casting che l'ha prodotta non si sente.
 */
function sfuma(
  fattore: Float32Array<ArrayBufferLike>,
  larghezza: number,
  altezza: number,
  peso: number,
): Float32Array<ArrayBufferLike> {
  if (peso <= 0) return fattore
  // Il binomiale scritto come "il valore piu' un quarto della sua curvatura":
  // pesarlo diventa pesare la correzione, e a dose piena torna 1-2-1.
  const k = 0.25 * Math.min(1, peso)
  const mezzo = new Float32Array(fattore.length)
  const fuori = new Float32Array(fattore.length)

  for (let r = 0; r < altezza; r++) {
    const base = r * larghezza
    for (let c = 0; c < larghezza; c++) {
      const qui = fattore[base + c]
      const sx = fattore[base + (c > 0 ? c - 1 : 0)]
      const dx = fattore[base + (c < larghezza - 1 ? c + 1 : larghezza - 1)]
      mezzo[base + c] = qui + k * (sx - 2 * qui + dx)
    }
  }
  for (let r = 0; r < altezza; r++) {
    const base = r * larghezza
    const su = (r > 0 ? r - 1 : 0) * larghezza
    const giu = (r < altezza - 1 ? r + 1 : altezza - 1) * larghezza
    for (let c = 0; c < larghezza; c++) {
      const qui = mezzo[base + c]
      fuori[base + c] = qui + k * (mezzo[su + c] - 2 * qui + mezzo[giu + c])
    }
  }
  return fuori
}

export function mercatoreY(lat: number): number {
  const l = Math.min(85.051129, Math.max(-85.051129, lat))
  return R_TERRA * Math.log(Math.tan(Math.PI / 4 + (l * RAD) / 2))
}

export function latDaMercatore(y: number): number {
  return (2 * Math.atan(Math.exp(y / R_TERRA)) - Math.PI / 2) * DEG
}

/**
 * Quanti metri per lato prima di spezzare un lato dell'impronta, rispetto al
 * passo con cui si cerca il terreno.
 *
 * Spezzare serve solo a far seguire il rilievo al bordo lontano dell'ombra: piu'
 * fitto di cosi' si spende per descrivere ondulazioni che il terreno, letto su
 * celle da due metri, nemmeno conosce.
 */
const LATO_MAX_MULTIPLO = 5
const LATO_MAX_MINIMO = 10

interface Inquadratura {
  fuso: Fuso
  azimuthDeg: number
  elevationDeg: number
  maxDistance: number
  larghezza: number
  altezza: number
  /** metri di terreno per pixel d'immagine */
  passo: number
  /** origine e dimensioni del riquadro in Web Mercator */
  mx0: number
  my1: number
  larghezzaM: number
  altezzaM: number
}

/**
 * Aggiunge alla maschera le ombre degli edifici, costruite in geometria.
 *
 * I vertici nascono in UTM e vanno portati nel riquadro dell'immagine, che e' in
 * Web Mercator: e' la stessa catena che il ciclo del raster percorre al
 * contrario, un vertice alla volta invece che per interpolazione, perche' qui i
 * punti sono pochi e non stanno su una griglia.
 *
 * L'ombra di ogni edificio entra nella maschera in una volta sola, con tutti i
 * suoi pezzi: e' cosi' che le giunzioni interne spariscono.
 */
function disegnaEdifici(
  edifici: Edificio[],
  superficie: Superficie,
  rilievo: Float32Array,
  ombre: Float32Array,
  q: Inquadratura,
): void {
  // Il passo di ricerca non scende sotto la cella del modello -- sotto non c'e'
  // terreno da leggere -- ne' sotto il pixel dell'immagine, che e' il dettaglio
  // che si vedra' davvero.
  const passoMarcia = Math.max(superficie.pixelSize, q.passo)
  const suolo = {
    quote: rilievo,
    ostacoli: superficie.dsm,
    width: superficie.width,
    height: superficie.height,
    pixelSize: superficie.pixelSize,
    inv: invertiAffine(superficie.transform),
  }

  // Il riquadro visto, in UTM: serve a scartare gli edifici la cui ombra non
  // puo' arrivarci.
  const angoli: [number, number][] = [
    [q.mx0, q.my1],
    [q.mx0 + q.larghezzaM, q.my1],
    [q.mx0, q.my1 - q.altezzaM],
    [q.mx0 + q.larghezzaM, q.my1 - q.altezzaM],
  ]
  let vx0 = Infinity
  let vy0 = Infinity
  let vx1 = -Infinity
  let vy1 = -Infinity
  for (const [mx, my] of angoli) {
    const [x, y] = versoUtm((mx / R_TERRA) * DEG, latDaMercatore(my), q.fuso)
    if (x < vx0) vx0 = x
    if (x > vx1) vx1 = x
    if (y < vy0) vy0 = y
    if (y > vy1) vy1 = y
  }

  const ombreggiate = ombreEdifici(edifici, suolo, {
    azimuthDeg: q.azimuthDeg,
    elevationDeg: q.elevationDeg,
    vista: [vx0, vy0, vx1, vy1],
    passo: passoMarcia,
    suddivisione: Math.max(LATO_MAX_MULTIPLO * passoMarcia, LATO_MAX_MINIMO),
    portata: q.maxDistance,
  })

  /** Da metri UTM a pixel dell'immagine, vertice per vertice. */
  const inPixel = (xy: Float64Array, out: Float64Array): Float64Array => {
    for (let i = 0; i < xy.length; i += 2) {
      const [lon, lat] = versoGradi(xy[i], xy[i + 1], q.fuso)
      out[i] = ((lon * RAD * R_TERRA - q.mx0) / q.larghezzaM) * q.larghezza
      out[i + 1] = ((q.my1 - mercatoreY(lat)) / q.altezzaM) * q.altezza
    }
    return out
  }

  // Le impronte si raccolgono a parte: alla fine ritagliano via l'ombra che
  // cadrebbe sugli edifici. Un tetto illuminato e' illuminato, e comunque sulla
  // mappa quel posto lo occupa il volume estruso; per chi cammina conta l'ombra
  // che sta a terra.
  const impronte = new Float32Array(ombre.length)
  const pezzi: Pezzo[] = []
  const coperte: Pezzo[] = []
  // I pezzi di un edificio sono finiti quando comincia quello dopo, quindi la
  // stessa memoria puo' servirli tutti: in una citta' sono qualche decina di
  // migliaia di vettori risparmiati per ogni fotogramma.
  const scorta: Float64Array[] = []
  let quanti = 0
  const presta = (lunghezza: number): Float64Array => {
    let v = scorta[quanti]
    if (v === undefined || v.length < lunghezza) {
      v = new Float64Array(lunghezza)
      scorta[quanti] = v
    }
    quanti++
    return v.length === lunghezza ? v : v.subarray(0, lunghezza)
  }

  for (const ombra of ombreggiate) {
    pezzi.length = 0
    coperte.length = 0
    quanti = 0
    for (let k = 0; k < ombra.anelli.length; k++) {
      // Il contorno riempie, i cortili bucano.
      const verso = k === 0 ? 1 : -1
      const quanti2 = ombra.anelli[k].base.length
      const base = inPixel(ombra.anelli[k].base, presta(quanti2))
      const punta = inPixel(ombra.anelli[k].punta, presta(quanti2))
      pezzi.push({ xy: base, verso }, { xy: punta, verso })
      coperte.push({ xy: base, verso })

      // Un quadrilatero per lato, a coprire quello che l'ombra spazza fra il
      // piede del muro e la sua punta. Questi riempiono sempre: il vuoto di un
      // cortile e' gia' stato tolto dai due anelli.
      const n = quanti2 / 2
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const xy = presta(8)
        xy[0] = base[i * 2]
        xy[1] = base[i * 2 + 1]
        xy[2] = base[j * 2]
        xy[3] = base[j * 2 + 1]
        xy[4] = punta[j * 2]
        xy[5] = punta[j * 2 + 1]
        xy[6] = punta[i * 2]
        xy[7] = punta[i * 2 + 1]
        pezzi.push({ xy, verso: 1 })
      }
    }
    riempi(pezzi, q.larghezza, q.altezza, ombre)
    riempi(coperte, q.larghezza, q.altezza, impronte)
  }

  for (let i = 0; i < ombre.length; i++) {
    if (impronte[i] > 0) ombre[i] *= 1 - impronte[i]
  }
}

/** I quattro vertici dell'immagine: alto-sx, alto-dx, basso-dx, basso-sx. */
export type QuattroAngoli = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
]

export interface Ombre {
  larghezza: number
  altezza: number
  /** RGBA, pronta per una `ImageData` */
  pixel: Uint8ClampedArray<ArrayBuffer>
  angoli: QuattroAngoli
  elevation: number
  azimuth: number
}

/**
 * Disegna le ombre di un istante sul riquadro geografico indicato.
 *
 * Le ombre arrivano da due parti che si sommano prendendo la piu' scura. Il
 * raster porta quelle del terreno e delle chiome, che sono diffuse per natura e
 * dal raster sono descritte bene. Gli edifici, se l'area li porta, arrivano
 * invece come geometria, dagli stessi poligoni che la mappa estrude: sono loro
 * a dover avere il bordo dritto, perche' e' accanto a un muro che si vede se il
 * bordo e' storto.
 *
 * @param superficie mosaico gia' composto, in coordinate UTM
 * @param bounds riquadro da coprire in gradi (ovest, sud, est, nord)
 * @param latoMax lato massimo dell'immagine prodotta, in pixel
 * @param edifici impronte in UTM; senza, gli edifici restano al raster
 */
export function disegnaOmbre(
  superficie: Superficie,
  fuso: Fuso,
  bounds: [number, number, number, number],
  azimuthDeg: number,
  elevationDeg: number,
  latoMax: number,
  maxDistance: number,
  edifici: Edificio[] | null = null,
): Ombre {
  const [ovest, sud, est, nord] = bounds

  // Riquadro di uscita in Web Mercator, dove la mappa lo disegna senza
  // deformarlo, con pixel quadrati.
  const mx0 = ovest * RAD * R_TERRA
  const mx1 = est * RAD * R_TERRA
  const my0 = mercatoreY(sud)
  const my1 = mercatoreY(nord)
  const larghezzaM = mx1 - mx0
  const altezzaM = my1 - my0

  // Con gli edifici in geometria il raster non deve rifarli: parte dal terreno
  // nudo, e gli restano il rilievo e le chiome. Se l'area non porta il piano del
  // costruito, `quotaSuolo` ritorna il DSM e il raster fa tutto come prima.
  const geometrici = edifici !== null && edifici.length > 0 && superficie.built !== null
  const rilievo = geometrici ? quotaSuolo(superficie) : superficie.dsm

  const lato = Math.max(larghezzaM, altezzaM)
  // Il limite basso non e' piu' la cella del modello ma una sua frazione: le
  // ombre restano calcolate cella per cella, e' solo l'immagine che le mostra
  // ad andare fino a dove arriva lo schermo, invece di lasciare l'ingrandimento
  // alla scheda grafica. Con gli edifici in geometria il limite cade del tutto:
  // li' non si sta ingrandendo una griglia, si sta disegnando uno spigolo, e uno
  // spigolo vale la risoluzione che lo schermo ha davvero.
  const passo = geometrici
    ? lato / latoMax
    : Math.max(lato / latoMax, superficie.pixelSize / SOVRACAMPIONAMENTO)
  const larghezza = Math.max(1, Math.round(larghezzaM / passo))
  const altezza = Math.max(1, Math.round(altezzaM / passo))

  const grezzo = sunFactor(
    rilievo,
    superficie.width,
    superficie.height,
    superficie.pixelSize,
    azimuthDeg,
    elevationDeg,
    superficie.canopy,
    superficie.tau,
    maxDistance,
  )

  // Quanti pixel dell'immagine copre una cella: e' il fattore d'ingrandimento
  // che si vedrebbe a quadretti, ed e' quindi anche la dose di sfumatura che
  // serve per non vederli.
  const perCella = superficie.pixelSize / passo
  const fattore = sfuma(
    grezzo,
    superficie.width,
    superficie.height,
    (perCella - MORBIDEZZA_DA) / (MORBIDEZZA_A - MORBIDEZZA_DA),
  )

  // L'ombra si raccoglie prima in un canale solo, in virgola mobile: e' quello
  // che le due sorgenti si contendono prendendo la piu' scura, e diventa colore
  // una volta sola alla fine.
  const ombre = new Float32Array(larghezza * altezza)
  const inv = invertiAffine(superficie.transform)
  const ultimaCol = superficie.width - 1
  const ultimaRiga = superficie.height - 1

  // Riga per riga: la latitudine e' costante, la longitudine cresce in modo
  // esattamente lineare, e le posizioni si ricavano da pochi punti guida.
  // Le guide non sono tenute in metri UTM ma gia' convertite in riga e colonna
  // della griglia, che e' l'unica cosa di cui il ciclo ha bisogno: fra una
  // guida e l'altra restano una retta come lo erano i metri, e ogni pixel
  // costa due addizioni invece di una trasformazione affine.
  const nGuide = Math.ceil(larghezza / PASSO_CONTROLLO) + 1
  const guideCol = new Float64Array(nGuide)
  const guideRiga = new Float64Array(nGuide)
  const larghezzaSup = superficie.width

  for (let r = 0; r < altezza; r++) {
    const my = my1 - ((r + 0.5) * altezzaM) / altezza
    const lat = latDaMercatore(my)
    for (let g = 0; g < nGuide; g++) {
      const c = Math.min(larghezza - 1, g * PASSO_CONTROLLO)
      const lon = ((mx0 + ((c + 0.5) * larghezzaM) / larghezza) / R_TERRA) * DEG
      const [x, y] = versoUtm(lon, lat, fuso)
      // Contate dai centri delle celle: sono quelli fra cui si interpola, non
      // gli spigoli.
      guideCol[g] = x * inv.a + y * inv.b + inv.c - 0.5
      guideRiga[g] = x * inv.d + y * inv.e + inv.f - 0.5
    }

    const base = r * larghezza
    for (let g = 0; g + 1 < nGuide; g++) {
      const da = g * PASSO_CONTROLLO
      if (da >= larghezza) break
      const a = Math.min(larghezza - 1, (g + 1) * PASSO_CONTROLLO)
      const salti = a - da
      const dcol = salti === 0 ? 0 : (guideCol[g + 1] - guideCol[g]) / salti
      const driga = salti === 0 ? 0 : (guideRiga[g + 1] - guideRiga[g]) / salti
      let cx = guideCol[g]
      let cy = guideRiga[g]

      const fine = Math.min(larghezza, da + PASSO_CONTROLLO)
      for (let c = da; c < fine; c++, cx += dcol, cy += driga) {
        let ombra = 0
        // Fuori dalla superficie disponibile si lascia trasparente: e' la
        // stessa convenzione del backend, dove il nodata valeva pieno sole.
        if (cx >= -0.5 && cy >= -0.5 && cx <= ultimaCol + 0.5 && cy <= ultimaRiga + 0.5) {
          const c0 = cx < 0 ? 0 : cx > ultimaCol ? ultimaCol : Math.floor(cx)
          const r0 = cy < 0 ? 0 : cy > ultimaRiga ? ultimaRiga : Math.floor(cy)
          const c1 = c0 < ultimaCol ? c0 + 1 : ultimaCol
          const r1 = r0 < ultimaRiga ? r0 + 1 : ultimaRiga
          // Sulla mezza cella di bordo, dove non c'e' una cella di la', il peso
          // finisce tutto su quella di qua: l'ombra non sfuma verso il nulla.
          const fx = cx < c0 ? 0 : cx - c0 > 1 ? 1 : cx - c0
          const fy = cy < r0 ? 0 : cy - r0 > 1 ? 1 : cy - r0
          const alto = r0 * larghezzaSup
          const basso = r1 * larghezzaSup
          const sopra = fattore[alto + c0] + fx * (fattore[alto + c1] - fattore[alto + c0])
          const sotto = fattore[basso + c0] + fx * (fattore[basso + c1] - fattore[basso + c0])
          ombra = 1 - (sopra + fy * (sotto - sopra))
        }
        ombre[base + c] = ombra
      }
    }
  }

  if (geometrici) {
    disegnaEdifici(edifici, superficie, rilievo, ombre, {
      fuso,
      azimuthDeg,
      elevationDeg,
      maxDistance,
      larghezza,
      altezza,
      passo,
      mx0,
      my1,
      larghezzaM,
      altezzaM,
    })
  }

  const pixel = new Uint8ClampedArray(larghezza * altezza * 4)
  const [rosso, verde, blu] = SHADE_RGB
  for (let i = 0, p = 0; i < ombre.length; i++, p += 4) {
    pixel[p] = rosso
    pixel[p + 1] = verde
    pixel[p + 2] = blu
    pixel[p + 3] = ombre[i] * MAX_OPACITY * 255
  }

  return {
    larghezza,
    altezza,
    pixel,
    angoli: [
      [ovest, nord],
      [est, nord],
      [est, sud],
      [ovest, sud],
    ],
    elevation: elevationDeg,
    azimuth: azimuthDeg,
  }
}
