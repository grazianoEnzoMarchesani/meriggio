/**
 * Le ombre degli edifici come geometria, non come pixel.
 *
 * Il motore di `shadow.ts` lavora sulla griglia del modello, e va benissimo per
 * decidere se un tratto di strada e' al sole: li' la domanda e' "questo punto",
 * e la cella da due metri e' la precisione del dato. Sulla mappa pero' quella
 * stessa cella si vede, e si vede male: accanto a un edificio estruso, che ha
 * spigoli veri, l'ombra a gradini sembra un errore di calcolo anche quando il
 * calcolo e' giusto.
 *
 * Qui l'ombra si costruisce dagli stessi poligoni che disegnano le estrusioni.
 * L'ombra di un prisma su un piano e' la somma di Minkowski della sua impronta
 * con il segmento che va dal piede alla punta dell'ombra: in pratica l'impronta,
 * la sua copia traslata, e un quadrilatero per ogni lato a fare da collegamento.
 * Nessuna griglia di mezzo, quindi il bordo resta una retta a qualsiasi
 * ingrandimento.
 *
 * **La punta pero' non sta su un piano.** Ascoli e' su un colle, e un'ombra
 * lunga che scende lungo un versante arriva molto piu' in la' di dove la
 * metterebbe la trigonometria del suolo orizzontale. Allora per ogni vertice si
 * segue il raggio solare finche' non incontra il terreno, che e' esattamente
 * quello che fa lo shadow casting, solo su una manciata di punti invece che su
 * tutta la griglia. Il bordo lontano dell'ombra smette di essere una retta e
 * diventa una spezzata che segue il rilievo: resta geometria, con i vertici in
 * posizione continua, e non torna a essere una scala.
 *
 * Restano fuori da qui il terreno che ombreggia se stesso e le chiome, che non
 * hanno un poligono: quelli continuano a venire dal raster.
 */

import { versoUtm, type Fuso } from './utm.ts'

const RAD = Math.PI / 180

/** Un edificio in coordinate UTM: contorno, eventuali cortili, altezza. */
export interface Edificio {
  /** anelli x,y alternati e aperti; il primo e' il contorno, gli altri cortili */
  anelli: Float64Array[]
  altezza: number
  /** riquadro del solo contorno: x0, y0, x1, y1 */
  riquadro: [number, number, number, number]
}

/**
 * L'ombra di un edificio, anello per anello.
 *
 * Di ogni anello si tiene il contorno a terra e la punta dell'ombra dei suoi
 * vertici: chi disegna ricava da questi due il pezzo di ombra di ogni lato.
 */
export interface OmbraEdificio {
  anelli: { base: Float64Array; punta: Float64Array }[]
}

interface GeoJsonEdifici {
  features: {
    properties: { height?: number } | null
    geometry: { type: string; coordinates: number[][][] }
  }[]
}

/**
 * Legge il file degli edifici e lo porta in UTM una volta per tutte.
 *
 * E' lo stesso file che la mappa usa per le estrusioni, quindi l'ombra e il
 * volume che la proietta non possono scollarsi.
 */
export function leggiEdifici(bytes: Uint8Array, fuso: Fuso): Edificio[] {
  const dati: GeoJsonEdifici = JSON.parse(new TextDecoder().decode(bytes))
  const out: Edificio[] = []

  for (const f of dati.features) {
    const altezza = f.properties?.height ?? 0
    if (!(altezza > 0) || f.geometry.type !== 'Polygon') continue

    const anelli: Float64Array[] = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity

    for (const anello of f.geometry.coordinates) {
      // Il GeoJSON chiude l'anello ripetendo il primo vertice: qui gli anelli
      // sono aperti, e il lato di chiusura lo mette chi cammina sui lati.
      const chiuso =
        anello.length > 1 &&
        anello[0][0] === anello[anello.length - 1][0] &&
        anello[0][1] === anello[anello.length - 1][1]
      const n = chiuso ? anello.length - 1 : anello.length
      if (n < 3) continue

      const xy = new Float64Array(n * 2)
      for (let i = 0; i < n; i++) {
        const [x, y] = versoUtm(anello[i][0], anello[i][1], fuso)
        xy[i * 2] = x
        xy[i * 2 + 1] = y
        if (anelli.length === 0) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
      }
      anelli.push(xy)
    }

    if (anelli.length > 0) out.push({ anelli, altezza, riquadro: [x0, y0, x1, y1] })
  }
  return out
}

/**
 * Le due superfici che servono a un'ombra, e come interrogarle.
 *
 * Sono le stesse due che lo shadow casting tiene distinte: da dove parte
 * l'ombra e su cosa va a finire. Il piede del muro sta sul **terreno**, perche'
 * l'altezza dell'edificio si conta da li'; il raggio pero' viaggia sopra la
 * **superficie**, tetti compresi, e si ferma al primo che incontra. E' questa
 * distinzione a fare la differenza in un centro storico, dove il palazzo di
 * fronte interrompe l'ombra dopo pochi metri invece di lasciarla correre per
 * quaranta.
 */
export interface Suolo {
  /** terreno nudo: da qui si conta l'altezza dell'edificio */
  quote: Float32Array
  /** terreno piu' costruito: e' quello che ferma il raggio */
  ostacoli: Float32Array
  width: number
  height: number
  pixelSize: number
  /** trasformazione inversa: da UTM a colonna e riga */
  inv: { a: number; b: number; c: number; d: number; e: number; f: number }
}

/** Quota di una delle due superfici in un punto, interpolata fra i vicini. */
function quotaDi(
  s: Suolo,
  griglia: Float32Array,
  x: number,
  y: number,
): number {
  const cx = x * s.inv.a + y * s.inv.b + s.inv.c - 0.5
  const cy = x * s.inv.d + y * s.inv.e + s.inv.f - 0.5
  const ultimaCol = s.width - 1
  const ultimaRiga = s.height - 1
  const c0 = cx < 0 ? 0 : cx > ultimaCol ? ultimaCol : Math.floor(cx)
  const r0 = cy < 0 ? 0 : cy > ultimaRiga ? ultimaRiga : Math.floor(cy)
  const c1 = c0 < ultimaCol ? c0 + 1 : ultimaCol
  const r1 = r0 < ultimaRiga ? r0 + 1 : ultimaRiga
  const fx = cx < c0 ? 0 : cx - c0 > 1 ? 1 : cx - c0
  const fy = cy < r0 ? 0 : cy - r0 > 1 ? 1 : cy - r0
  const alto = r0 * s.width
  const basso = r1 * s.width
  const sopra = griglia[alto + c0] + fx * (griglia[alto + c1] - griglia[alto + c0])
  const sotto = griglia[basso + c0] + fx * (griglia[basso + c1] - griglia[basso + c0])
  return sopra + fy * (sotto - sopra)
}

/**
 * Quanto lontano arriva l'ombra di un vertice, seguendo il raggio solare.
 *
 * Il raggio parte dalla cima del muro e scende di `tan(elevazione)` per ogni
 * metro percorso: dove passa sotto la superficie, li' finisce l'ombra. Il punto
 * di incontro si prende interpolando fra i due passi che lo stringono, cosi' la
 * distanza non e' un multiplo del passo e la punta non torna a essere
 * quantizzata.
 *
 * Sui vertici del lato illuminato il raggio rientra subito sopra il tetto di
 * casa propria e la distanza viene zero: e' giusto cosi', l'ombra di quel muro
 * sta dietro l'edificio e la disegnano gli altri lati.
 */
function distanzaOmbra(
  suolo: Suolo,
  x: number,
  y: number,
  altezza: number,
  dirX: number,
  dirY: number,
  tanElevazione: number,
  passo: number,
  limite: number,
): number {
  const cima = quotaDi(suolo, suolo.quote, x, y) + altezza
  // Quanto la cima del muro sopravanza cio' che ha sotto di se': sul lato
  // illuminato e' zero, perche' sotto c'e' gia' il proprio tetto.
  let precedente = cima - quotaDi(suolo, suolo.ostacoli, x, y)
  if (precedente <= 0) return 0
  let t = 0

  while (t < limite) {
    const prossimo = Math.min(t + passo, limite)
    const dislivello =
      cima -
      prossimo * tanElevazione -
      quotaDi(suolo, suolo.ostacoli, x + dirX * prossimo, y + dirY * prossimo)
    if (dislivello <= 0) {
      // Fra `t` e `prossimo` il raggio ha incrociato il terreno.
      const f = precedente / (precedente - dislivello)
      return t + f * (prossimo - t)
    }
    precedente = dislivello
    t = prossimo
  }
  return limite
}

/** Inserisce vertici finche' nessun lato supera `massimo` metri. */
function suddividi(anello: Float64Array, massimo: number): Float64Array {
  const n = anello.length / 2
  const pezzi: number[] = []
  for (let i = 0; i < n; i++) {
    const x0 = anello[i * 2]
    const y0 = anello[i * 2 + 1]
    const j = (i + 1) % n
    const dx = anello[j * 2] - x0
    const dy = anello[j * 2 + 1] - y0
    const quanti = Math.max(1, Math.ceil(Math.hypot(dx, dy) / massimo))
    for (let k = 0; k < quanti; k++) {
      pezzi.push(x0 + (dx * k) / quanti, y0 + (dy * k) / quanti)
    }
  }
  return Float64Array.from(pezzi)
}

/**
 * Quante volte l'ombra su suolo orizzontale puo' allungarsi scendendo.
 *
 * Serve solo a sapere quando smettere di cercare: se il raggio non ha ancora
 * incontrato il terreno dopo quattro volte la lunghezza che avrebbe in piano,
 * vuol dire che sta sorvolando una valle, e la sua punta e' cosi' lontana e
 * cosi' sfumata dall'atmosfera che inseguirla oltre non aggiunge niente.
 */
const ALLUNGAMENTO_MAX = 4

export interface RichiestaOmbre {
  azimuthDeg: number
  elevationDeg: number
  /** riquadro da coprire in UTM: x0, y0, x1, y1 */
  vista: [number, number, number, number]
  /** passo con cui si cerca la punta lungo il raggio, in metri */
  passo: number
  /** lunghezza massima di un lato prima di essere spezzato, in metri */
  suddivisione: number
  /** oltre questa distanza l'ombra non si insegue piu' */
  portata: number
}

/**
 * Le ombre di tutti gli edifici che possono cadere dentro il riquadro visto.
 *
 * Un edificio si scarta se nemmeno la sua ombra piu' lunga puo' entrare nella
 * vista: e' il grosso del lavoro risparmiato quando si guarda un isolato in una
 * citta' di tremila edifici.
 */
export function ombreEdifici(
  edifici: Edificio[],
  suolo: Suolo,
  r: RichiestaOmbre,
): OmbraEdificio[] {
  const out: OmbraEdificio[] = []
  if (r.elevationDeg <= 0) return out

  const a = r.azimuthDeg * RAD
  // L'ombra va dalla parte opposta al sole: l'azimut e' contato da nord in
  // senso orario, quindi verso il sole si va di (sin, cos) su (est, nord).
  const dirX = -Math.sin(a)
  const dirY = -Math.cos(a)
  const tanEl = Math.tan(r.elevationDeg * RAD)
  const [vx0, vy0, vx1, vy1] = r.vista

  for (const e of edifici) {
    const limite = Math.min(r.portata, (ALLUNGAMENTO_MAX * e.altezza) / tanEl)
    // Riquadro dell'ombra: quello dell'edificio piu' quello della sua punta.
    const [bx0, by0, bx1, by1] = e.riquadro
    const sx = dirX * limite
    const sy = dirY * limite
    if (
      Math.max(bx1, bx1 + sx) < vx0 ||
      Math.min(bx0, bx0 + sx) > vx1 ||
      Math.max(by1, by1 + sy) < vy0 ||
      Math.min(by0, by0 + sy) > vy1
    ) {
      continue
    }

    const anelli: { base: Float64Array; punta: Float64Array }[] = []
    for (const originale of e.anelli) {
      // Un lato lungo va spezzato prima di cercarne la punta, altrimenti fra un
      // vertice e l'altro l'ombra taglierebbe dritta sopra il rilievo.
      const base = suddividi(originale, r.suddivisione)
      const m = base.length / 2
      const punta = new Float64Array(m * 2)
      for (let i = 0; i < m; i++) {
        const x = base[i * 2]
        const y = base[i * 2 + 1]
        const t = distanzaOmbra(
          suolo, x, y, e.altezza, dirX, dirY, tanEl, r.passo, limite,
        )
        punta[i * 2] = x + dirX * t
        punta[i * 2 + 1] = y + dirY * t
      }
      anelli.push({ base, punta })
    }
    if (anelli.length > 0) out.push({ anelli })
  }

  return out
}
