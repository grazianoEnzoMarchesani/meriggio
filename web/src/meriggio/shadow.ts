/**
 * Motore di calcolo delle ombre su modello digitale di superficie.
 *
 * Traduzione di `shadow.py`. Implementa lo shadow casting iterativo di Ratti &
 * Richens nella formulazione di Lindberg (SOLWEIG/UMEP): invece di tracciare un
 * raggio per ogni pixel, la superficie viene traslata ripetutamente lungo la
 * direzione del sole e abbassata della quota corrispondente. Il massimo
 * cumulato di queste traslazioni descrive l'orizzonte visto da ogni pixel; dove
 * supera la quota del pixel, il pixel e' in ombra.
 *
 * Il costo e' O(n_passi) passate sull'intero raster, indipendentemente dal
 * numero di ostacoli.
 *
 * La vegetazione e' trattata a parte perche' non e' opaca: una chioma lascia
 * passare una frazione di radiazione che dipende dalla densita' fogliare.
 *
 * **Sul porting.** Il numpy originale lavora in virgola mobile a 32 bit, e qui
 * si fa lo stesso con `Float32Array` e `Math.fround` dove il valore intermedio
 * non passa da un array. L'aritmetica degli indici della finestra di
 * traslazione e' ricopiata operazione per operazione, compreso il troncamento
 * verso lo zero di `int()` e l'arrotondamento al pari di `round()`: e' la parte
 * che, riscritta "a senso", si sposterebbe di un pixel. La prova che il conto
 * torni sta in `shadow.test.ts`, che confronta i raster con quelli del Python.
 */

// Trasmissivita' della chioma: frazione di radiazione che filtra attraverso
// gli alberi. Gli estremi corrispondono a chioma molto densa e molto rada.
export const TAU_DENSE = 0.05
export const TAU_SPARSE = 0.4
export const TAU_DEFAULT = 0.18

const RAD = Math.PI / 180.0

/** Arrotondamento al pari, come `round()` di Python su un float. */
function arrotondaPari(v: number): number {
  const giu = Math.floor(v)
  const resto = v - giu
  if (resto > 0.5) return giu + 1
  if (resto < 0.5) return giu
  return giu % 2 === 0 ? giu : giu + 1
}

/** Resto sempre positivo, come `%` di Python. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/** Segno con lo zero conservato, come `np.sign`. */
function segno(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0
}

/**
 * I passi della proiezione: di quanto e' traslata la superficie al passo k e
 * di quanto e' abbassata.
 *
 * Sono gli stessi per tutti i pixel, perche' dipendono solo da k e
 * dall'angolo del sole. E' un dettaglio del tutto secondario nel codice
 * originale, dove serviva solo a scrivere il ciclo, e diventa invece il punto
 * su cui gira il calcolo nel browser: se gli scostamenti non dipendono dal
 * pixel, l'orizzonte di un singolo punto si puo' calcolare da solo, senza
 * traslare niente. Vedi `sunFactorPoints`.
 */
export interface PassiOmbra {
  drow: Int32Array
  dcol: Int32Array
  /** quota persa al passo k, gia' arrotondata a 32 bit come nell'originale */
  dz: Float32Array
}

function passiOmbra(
  rows: number,
  cols: number,
  pixelSize: number,
  azimuthDeg: number,
  elevationDeg: number,
  relief: number,
): PassiOmbra {
  const azimuth = mod(azimuthDeg, 360.0) * RAD
  const altitude = elevationDeg * RAD

  const sinAz = Math.sin(azimuth)
  const cosAz = Math.cos(azimuth)
  const signSin = segno(sinAz)
  const signCos = segno(cosAz)
  const tanAltByScale = Math.tan(altitude) * pixelSize
  const tanAz = Math.tan(azimuth)

  const pi4 = Math.PI / 4.0
  // Nei settori dove domina la componente est-ovest si avanza di un pixel per
  // colonna, altrimenti di un pixel per riga: cosi' il passo di campionamento
  // resta sempre <= 1 pixel e non si "bucano" ostacoli.
  const eastWestDominant =
    (pi4 <= azimuth && azimuth < 3 * pi4) || (5 * pi4 <= azimuth && azimuth < 7 * pi4)
  const stepLen = eastWestDominant ? Math.abs(1.0 / sinAz) : Math.abs(1.0 / cosAz)

  const drow: number[] = []
  const dcol: number[] = []
  const dz: number[] = []

  let z = 0.0
  let dr = 0.0
  let dc = 0.0
  let index = 1
  while (z < relief && Math.abs(dr) < rows && Math.abs(dc) < cols) {
    if (eastWestDominant) {
      dc = signSin * index
      dr = -signCos * Math.abs(arrotondaPari(index / tanAz))
    } else {
      dc = signSin * Math.abs(arrotondaPari(index * tanAz))
      dr = -signCos * index
    }
    // Quota persa percorrendo questa distanza lungo il raggio solare
    z = stepLen * index * tanAltByScale
    drow.push(dr)
    dcol.push(dc)
    dz.push(z)
    index += 1
  }

  return { drow: Int32Array.from(drow), dcol: Int32Array.from(dcol), dz: Float32Array.from(dz) }
}

/** Dislivello utile della scena: oltre questa quota nessun ostacolo fa piu' ombra. */
function rilievo(occluder: Float32Array): number {
  let alto = -Infinity
  let basso = Infinity
  for (let i = 0; i < occluder.length; i++) {
    const v = occluder[i]
    if (!Number.isFinite(v)) continue
    if (v > alto) alto = v
    if (v < basso) basso = v
  }
  return alto === -Infinity ? NaN : Math.fround(alto - basso)
}

/**
 * Maschera di soleggiamento proiettando gli ostacoli su una superficie.
 *
 * @param occluder quote degli ostacoli in metri, riga 0 = nord
 * @param receiver superficie che riceve l'ombra. Se assente coincide con
 *   `occluder`, che e' il caso degli edifici: un tetto non fa ombra a se'
 *   stesso. Va invece distinta per la vegetazione, dove il suolo sotto la
 *   chioma e' in ombra pur avendo la chioma sopra di se' nello stesso pixel.
 * @param maxDistance lunghezza massima d'ombra da considerare, in metri:
 *   limita il numero di iterazioni quando il sole e' molto basso.
 * @returns 1.0 = pixel al sole, 0.0 = pixel in ombra
 */
export function shadowMask(
  occluder: Float32Array,
  width: number,
  height: number,
  pixelSize: number,
  azimuthDeg: number,
  elevationDeg: number,
  maxDistance: number | null = null,
  receiver: Float32Array | null = null,
): Float32Array {
  const rows = height
  const cols = width
  const out = new Float32Array(rows * cols)

  // Sotto l'orizzonte non c'e' luce diretta: tutto in ombra.
  if (elevationDeg <= 0.0) return out

  const surface = receiver ?? occluder

  // Dislivello massimo presente nella scena: oltre questa quota nessun
  // ostacolo puo' piu' proiettare ombra su nulla.
  let relief = rilievo(occluder)
  if (Number.isNaN(relief)) return out.fill(1.0)
  if (relief <= 0.0 && receiver === null) return out.fill(1.0)
  if (maxDistance !== null) {
    relief = Math.min(relief, maxDistance * Math.tan(elevationDeg * RAD))
  }

  // Il passo iniziale, senza traslazione, mette in ombra il suolo che ha un
  // ostacolo esattamente sopra di se': e' il caso di chi cammina sotto un
  // albero con il sole allo zenit.
  const horizon = occluder.slice()
  const passi = passiOmbra(rows, cols, pixelSize, azimuthDeg, elevationDeg, relief)

  for (let k = 0; k < passi.dz.length; k++) {
    const drow = passi.drow[k]
    const dcol = passi.dcol[k]
    const adrow = Math.abs(drow)
    const adcol = Math.abs(dcol)
    // Finestra sorgente (da dove si legge) e destinazione (dove si scrive)
    const srcR0 = Math.trunc((drow + adrow) / 2.0)
    const srcC0 = Math.trunc((dcol + adcol) / 2.0)
    const dstR0 = Math.trunc(-((drow - adrow) / 2.0))
    const dstR1 = Math.trunc(rows - (drow + adrow) / 2.0)
    const dstC0 = Math.trunc(-((dcol - adcol) / 2.0))
    const dstC1 = Math.trunc(cols - (dcol + adcol) / 2.0)

    // L'originale scrive la traslazione in un array pieno di -infinito e ne
    // fa il massimo con l'orizzonte. Fuori dalla finestra il massimo con
    // -infinito non cambia nulla, quindi si scrive direttamente sulla
    // finestra: stesso risultato, meta' della memoria toccata.
    const dzf = passi.dz[k]
    const nRighe = dstR1 - dstR0
    const nCol = dstC1 - dstC0
    for (let r = 0; r < nRighe; r++) {
      let s = (srcR0 + r) * cols + srcC0
      let d = (dstR0 + r) * cols + dstC0
      for (let c = 0; c < nCol; c++, s++, d++) {
        const v = Math.fround(occluder[s] - dzf)
        if (v > horizon[d]) horizon[d] = v
      }
    }
  }

  // Un pixel e' in ombra se l'orizzonte proiettato supera la sua quota
  for (let i = 0; i < out.length; i++) out[i] = horizon[i] <= surface[i] ? 1.0 : 0.0
  return out
}

/**
 * Trasmissivita' della chioma a partire dalla densita' di copertura.
 *
 * `tcdPercent` e' la Tree Cover Density Copernicus (0-100). Chioma densa
 * lascia passare poca luce, chioma rada molta.
 */
export function canopyTransmissivity(tcdPercent: Float32Array): Float32Array {
  // Le costanti vanno portate a 32 bit prima di entrare nel conto, non dopo:
  // e' quello che fa numpy con uno scalare Python su un array float32, e
  // sommare 0.4 in doppia precisione sposterebbe l'ultimo bit del risultato.
  const rada = Math.fround(TAU_SPARSE)
  const pendenza = Math.fround(TAU_DENSE - TAU_SPARSE)
  const out = new Float32Array(tcdPercent.length)
  for (let i = 0; i < out.length; i++) {
    const tcd = Math.fround(Math.min(100, Math.max(0, tcdPercent[i])) / 100.0)
    out[i] = Math.fround(rada + Math.fround(pendenza * tcd))
  }
  return out
}

/**
 * Frazione di radiazione diretta che raggiunge ogni pixel, in [0, 1].
 *
 * @param dsm superficie opaca (terreno + edifici), in metri
 * @param canopy altezza della chioma sopra il `dsm`, in metri. E' la forma in
 *   cui i tasselli portano la vegetazione: `max(dsm, cdsm)` del backend qui e'
 *   semplicemente `dsm + canopy`, perche' dove c'e' un edificio la chioma e'
 *   gia' stata azzerata quando la superficie e' stata costruita.
 * @param tau trasmissivita' della chioma per pixel; se assente si usa
 *   `TAU_DEFAULT`
 * @returns 1.0 pieno sole, 0.0 ombra piena di edifici o terreno, valori
 *   intermedi sotto le chiome.
 */
export function sunFactor(
  dsm: Float32Array,
  width: number,
  height: number,
  pixelSize: number,
  azimuthDeg: number,
  elevationDeg: number,
  canopy: Float32Array | null = null,
  tau: Float32Array | null = null,
  maxDistance: number | null = 1500.0,
): Float32Array {
  // Edifici e terreno: ostacolo e ricevitore coincidono, un tetto non fa
  // ombra a se' stesso.
  const built = shadowMask(
    dsm, width, height, pixelSize, azimuthDeg, elevationDeg, maxDistance,
  )

  if (canopy === null) return built

  // Chiome: l'ostacolo comprende anche la vegetazione, ma l'ombra va
  // proiettata sul suolo. Cosi' chi cammina sotto un albero risulta in ombra
  // anche con il sole allo zenit.
  const occluder = new Float32Array(dsm.length)
  for (let i = 0; i < dsm.length; i++) {
    const con = Math.fround(dsm[i] + canopy[i])
    occluder[i] = con > dsm[i] ? con : dsm[i]
  }
  const total = shadowMask(
    occluder, width, height, pixelSize, azimuthDeg, elevationDeg, maxDistance, dsm,
  )

  // Pixel al sole rispetto al costruito ma in ombra considerando le chiome:
  // sono quelli ombreggiati soltanto dagli alberi.
  for (let i = 0; i < built.length; i++) {
    if (built[i] > 0.5 && total[i] < 0.5) built[i] = tau === null ? TAU_DEFAULT : tau[i]
  }
  return built
}

/**
 * L'orizzonte visto da un singolo pixel, senza traslare nulla.
 *
 * E' la stessa formula del ciclo di `shadowMask` letta al contrario: quella
 * versione, per ogni passo k, sposta tutta la superficie e ne tiene il massimo;
 * questa, per un pixel solo, guarda dove quel massimo verrebbe da leggere.
 * Gli scostamenti sono gli stessi, il massimo e' commutativo, quindi il numero
 * che esce e' identico bit per bit.
 */
function orizzontePunto(
  occluder: Float32Array,
  cols: number,
  rows: number,
  row: number,
  col: number,
  passi: PassiOmbra,
): number {
  let h = occluder[row * cols + col]
  const { drow, dcol, dz } = passi
  for (let k = 0; k < dz.length; k++) {
    // La finestra di `shadowMask` copre il pixel al passo k solo se il pixel
    // da cui legge cade dentro il raster: fuori non c'e' nulla da proiettare.
    const r = row + drow[k]
    if (r < 0 || r >= rows) continue
    const c = col + dcol[k]
    if (c < 0 || c >= cols) continue
    const v = Math.fround(occluder[r * cols + c] - dz[k])
    if (v > h) h = v
  }
  return h
}

/**
 * Frazione di radiazione diretta che raggiunge ciascuno dei punti indicati.
 *
 * Fa lo stesso lavoro di `sunFactor` seguito da `samplePoints`, e da' gli
 * stessi numeri, ma calcola l'ombra solo dove serve saperla. Per il routing
 * fa la differenza fra l'usabile e l'inusabile: un ritaglio di un chilometro
 * quadrato sono duecentocinquantamila pixel su cui l'algoritmo passa
 * trecento volte, mentre i punti dove il grafo chiede l'ombra sono qualche
 * migliaio. Il calcolo passa da centinaia di millisecondi a pochi, ed e' il
 * motivo per cui la cosa sta in piedi anche su un telefono.
 *
 * Il raster intero resta necessario a `sunFactor`, che disegna le ombre sulla
 * mappa: li' i punti da sapere sono tutti.
 */
export function sunFactorPoints(
  dsm: Float32Array,
  width: number,
  height: number,
  pixelSize: number,
  transform: Affine,
  azimuthDeg: number,
  elevationDeg: number,
  xs: Float64Array | number[],
  ys: Float64Array | number[],
  canopy: Float32Array | null = null,
  tau: Float32Array | null = null,
  maxDistance: number | null = 1500.0,
  predefinito = 1.0,
): Float32Array {
  const n = xs.length
  const out = new Float32Array(n).fill(predefinito)
  // Sotto l'orizzonte non c'e' luce diretta: tutto in ombra, ma solo dentro
  // il raster. Fuori vale la convenzione prudente del pieno sole, la stessa
  // di `samplePoints`.
  const notte = elevationDeg <= 0.0

  const { righe, colonne } = pixelDiPunti(transform, xs, ys)

  const tettoDz =
    maxDistance === null ? Infinity : maxDistance * Math.tan(elevationDeg * RAD)
  const tabella = (occ: Float32Array): PassiOmbra => {
    const relief = Math.min(rilievo(occ), tettoDz)
    return passiOmbra(height, width, pixelSize, azimuthDeg, elevationDeg, relief)
  }

  // L'ostacolo della vegetazione: la chioma sopra la superficie opaca. Serve
  // solo se da qualche parte c'e' davvero, e si costruisce una volta per tutti
  // i punti, non una per punto.
  let occluder: Float32Array | null = null
  if (canopy !== null && !notte) {
    occluder = new Float32Array(dsm.length)
    for (let i = 0; i < dsm.length; i++) {
      const con = Math.fround(dsm[i] + canopy[i])
      occluder[i] = con > dsm[i] ? con : dsm[i]
    }
  }

  if (Number.isNaN(rilievo(dsm))) return out
  // I due passaggi hanno tabelle diverse perche' il dislivello della scena e'
  // diverso: con le chiome la quota massima e' piu' alta, e l'ombra va quindi
  // inseguita qualche passo piu' in la'. E' un dettaglio che nell'originale
  // non si vede, perche' ogni passaggio ricalcola il proprio.
  const passi = notte ? { drow: new Int32Array(0), dcol: new Int32Array(0), dz: new Float32Array(0) } : tabella(dsm)
  const passiChioma = occluder === null ? passi : tabella(occluder)

  for (let i = 0; i < n; i++) {
    const row = righe[i]
    const col = colonne[i]
    if (row < 0 || row >= height || col < 0 || col >= width) continue
    if (notte) {
      out[i] = 0.0
      continue
    }
    const p = row * width + col
    const quota = dsm[p]

    const built = orizzontePunto(dsm, width, height, row, col, passi) <= quota
    if (!built) {
      out[i] = 0.0
      continue
    }
    if (occluder === null) {
      out[i] = 1.0
      continue
    }
    // Al sole rispetto al costruito ma in ombra tenendo conto delle chiome:
    // e' un punto ombreggiato soltanto dagli alberi, e la chioma ne lascia
    // passare una frazione.
    const total = orizzontePunto(occluder, width, height, row, col, passiChioma) <= quota
    out[i] = total ? 1.0 : tau === null ? TAU_DEFAULT : tau[p]
  }
  return out
}

/**
 * Trasformazione affine di un raster, nella stessa convenzione di rasterio.
 * `a` e `e` sono le dimensioni del pixel (`e` negativa, le righe scendono),
 * `c` e `f` lo spigolo alto-sinistra.
 */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export function affineDaOrigine(x0: number, y0: number, res: number): Affine {
  return { a: res, b: 0, c: x0, d: 0, e: -res, f: y0 }
}

/**
 * Riga e colonna del pixel che contiene ciascun punto, senza controllare che
 * cada dentro il raster.
 *
 * L'inversione della trasformazione ripete quella della libreria `affine` che
 * usa rasterio, determinante compreso: `(x - c) / a` e `x * (1/a) - c * (1/a)`
 * non danno sempre lo stesso ultimo bit, e su un punto che cade esattamente
 * sul bordo di un pixel quello scarto sceglie un pixel diverso.
 */
export function invertiAffine(transform: Affine): Affine {
  const { a, b, c, d, e, f } = transform
  const idet = 1.0 / (a * e - b * d)
  const ra = e * idet
  const rb = -b * idet
  const rd = -d * idet
  const re = a * idet
  return { a: ra, b: rb, c: -c * ra - f * rb, d: rd, e: re, f: -c * rd - f * re }
}

export function pixelDiPunti(
  transform: Affine,
  xs: Float64Array | number[],
  ys: Float64Array | number[],
): { righe: Int32Array; colonne: Int32Array } {
  const { a: ra, b: rb, c: rc, d: rd, e: re, f: rf } = invertiAffine(transform)

  const n = xs.length
  const righe = new Int32Array(n)
  const colonne = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    colonne[i] = Math.floor(x * ra + y * rb + rc)
    righe[i] = Math.floor(x * rd + y * re + rf)
  }
  return { righe, colonne }
}

/**
 * Campiona un raster su coordinate proiettate, con nearest neighbour.
 *
 * I punti fuori dal raster ricevono `predefinito`: assunzione prudente,
 * fuori dall'area coperta si sta al sole.
 */
export function samplePoints(
  raster: Float32Array,
  width: number,
  height: number,
  transform: Affine,
  xs: Float64Array | number[],
  ys: Float64Array | number[],
  predefinito = 1.0,
): Float32Array {
  const { righe, colonne } = pixelDiPunti(transform, xs, ys)
  const out = new Float32Array(xs.length).fill(predefinito)
  for (let i = 0; i < xs.length; i++) {
    const row = righe[i]
    const col = colonne[i]
    if (row >= 0 && row < height && col >= 0 && col < width) {
      out[i] = raster[row * width + col]
    }
  }
  return out
}
