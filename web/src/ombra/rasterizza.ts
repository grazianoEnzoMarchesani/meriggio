/**
 * Riempimento di poligoni con i bordi sfumati, senza passare da una canvas.
 *
 * Serve a portare l'ombra geometrica degli edifici dentro l'immagine che finisce
 * sulla mappa. Si potrebbe chiedere al browser -- un `Path2D` e una canvas fanno
 * la stessa cosa e la fanno in C -- ma il calcolo delle ombre vive in un worker
 * e nei collaudi gira in node, dove la canvas non c'e': tenerlo in JS puro
 * significa poterlo mettere alla prova con gli stessi test di tutto il resto.
 *
 * **Come si riempie.** Ogni riga di pixel viene tagliata in otto sotto-righe;
 * su ognuna si cercano le intersezioni con i lati, si ordinano, e si guarda il
 * numero di avvolgimento per sapere quali intervalli stanno dentro. In
 * orizzontale la copertura e' esatta, perche' un intervallo si sa dove comincia
 * e dove finisce dentro il pixel; in verticale sono otto livelli, abbastanza
 * perche' un bordo quasi orizzontale non mostri gradini.
 *
 * Un intervallo pieno non viene pero' scritto pixel per pixel otto volte: di
 * lui si segnano solo i due estremi, uno in positivo e uno in negativo, e alla
 * fine della riga una somma cumulata li riapre tutti in una passata sola.
 * Costa quanto la riga invece che quanto la riga per le sue sotto-righe, ed e'
 * la differenza fra un'anteprima che si aggiorna e una che si aspetta.
 *
 * **Perche' il numero di avvolgimento e non la semplice unione.** L'ombra di un
 * edificio arriva a pezzi -- l'impronta, la sua copia traslata, un
 * quadrilatero per lato -- che si sovrappongono parecchio. Sommando le
 * coperture i sovrapposti verrebbero piu' scuri; prendendone il massimo
 * resterebbe una cucitura chiara lungo ogni giunzione, dove due pezzi si
 * dividono a meta' il bordo sfumato. Contando gli avvolgimenti i pezzi diventano
 * una figura sola, senza cuciture e senza addensamenti, e i cortili si
 * bucano da soli passando con il verso opposto.
 */

/** Un pezzo da riempire: vertici x,y alternati in pixel, anello aperto. */
export interface Pezzo {
  xy: Float64Array
  /** +1 per il pieno, -1 per un vuoto da ritagliare (un cortile) */
  verso: number
}

/** Sotto-righe per riga di pixel: e' la finezza della sfumatura verticale. */
const SOTTORIGHE = 8

/**
 * Memoria di lavoro, tenuta da parte fra una figura e l'altra.
 *
 * Una citta' vuol dire qualche migliaio di chiamate per fotogramma, ciascuna su
 * una figura piccola: allocare ogni volta una decina di vettori costerebbe piu'
 * del disegno. Vivono qui e crescono quando serve, il che va bene finche' il
 * riempimento resta quello che e', un ciclo senza attese dentro.
 */
const banco = {
  ax: new Float64Array(0),
  ay: new Float64Array(0),
  bx: new Float64Array(0),
  by: new Float64Array(0),
  verso: new Int8Array(0),
  incroci: new Float64Array(0),
  sensi: new Int8Array(0),
  riga: new Float64Array(0),
  salti: new Float64Array(0),
}

function bancoLati(quanti: number): void {
  if (banco.ax.length >= quanti) return
  banco.ax = new Float64Array(quanti)
  banco.ay = new Float64Array(quanti)
  banco.bx = new Float64Array(quanti)
  banco.by = new Float64Array(quanti)
  banco.verso = new Int8Array(quanti)
  banco.incroci = new Float64Array(quanti)
  banco.sensi = new Int8Array(quanti)
}

function bancoRiga(quanti: number): void {
  if (banco.riga.length >= quanti + 1) return
  banco.riga = new Float64Array(quanti + 1)
  banco.salti = new Float64Array(quanti + 1)
}

/** Area con segno: dice da che parte gira un anello. */
export function areaSegnata(xy: Float64Array): number {
  const n = xy.length / 2
  let somma = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    somma += xy[i * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[i * 2 + 1]
  }
  return somma / 2
}

/**
 * Riempie i pezzi e ne porta la copertura dentro `copertura`, tenendo il
 * massimo fra quella che c'era e quella nuova.
 *
 * Il massimo, e non la somma, perche' `copertura` raccoglie figure diverse --
 * un edificio dopo l'altro -- e due ombre sovrapposte restano un'ombra: la
 * seconda non scurisce la prima. Dentro una stessa chiamata invece i pezzi si
 * fondono per avvolgimento, che e' la ragione per cui si passa tutta l'ombra di
 * un edificio in una volta sola.
 */
export function riempi(
  pezzi: Pezzo[],
  larghezza: number,
  altezza: number,
  copertura: Float32Array,
): void {
  // ---- lati, gia' orientati e senza gli orizzontali (non tagliano niente) --
  let quanti = 0
  for (const p of pezzi) quanti += p.xy.length / 2
  if (quanti === 0) return
  bancoLati(quanti)
  const { ax, ay, bx, by, verso, incroci, sensi } = banco

  let nLati = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity

  for (const p of pezzi) {
    const n = p.xy.length / 2
    if (n < 3) continue
    // Il verso chiesto vale comunque, qualunque sia l'ordine dei vertici.
    const area = areaSegnata(p.xy)
    if (area === 0) continue
    const segno = p.verso * (area > 0 ? 1 : -1)

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const px = p.xy[i * 2]
      const py = p.xy[i * 2 + 1]
      const qx = p.xy[j * 2]
      const qy = p.xy[j * 2 + 1]
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      if (py === qy) continue
      // Sempre memorizzato dall'alto verso il basso, con il verso a ricordare
      // da che parte andava davvero.
      if (py < qy) {
        ax[nLati] = px
        ay[nLati] = py
        bx[nLati] = qx
        by[nLati] = qy
        verso[nLati] = segno
      } else {
        ax[nLati] = qx
        ay[nLati] = qy
        bx[nLati] = px
        by[nLati] = py
        verso[nLati] = -segno
      }
      nLati++
    }
  }
  if (nLati === 0) return

  const r0 = Math.max(0, Math.floor(y0))
  const r1 = Math.min(altezza - 1, Math.ceil(y1))
  const c0 = Math.max(0, Math.floor(x0))
  const c1 = Math.min(larghezza - 1, Math.ceil(x1))
  if (r1 < r0 || c1 < c0) return

  const larghezzaRiga = c1 - c0 + 1
  bancoRiga(larghezzaRiga)
  const { riga, salti } = banco
  const peso = 1 / SOTTORIGHE

  for (let r = r0; r <= r1; r++) {
    riga.fill(0, 0, larghezzaRiga)
    salti.fill(0, 0, larghezzaRiga + 1)
    let toccata = false

    for (let s = 0; s < SOTTORIGHE; s++) {
      const y = r + (s + 0.5) / SOTTORIGHE
      let n = 0
      for (let e = 0; e < nLati; e++) {
        // Estremo alto incluso, estremo basso escluso: un vertice condiviso da
        // due lati conta una volta sola.
        if (y < ay[e] || y >= by[e]) continue
        const x = ax[e] + ((y - ay[e]) * (bx[e] - ax[e])) / (by[e] - ay[e])
        // Inserimento ordinato: gli incroci di una sotto-riga sono pochi, e un
        // confronto in linea batte un ordinamento con la sua funzione.
        let k = n
        while (k > 0 && incroci[k - 1] > x) {
          incroci[k] = incroci[k - 1]
          sensi[k] = sensi[k - 1]
          k--
        }
        incroci[k] = x
        sensi[k] = verso[e]
        n++
      }
      if (n < 2) continue

      let avvolgimento = 0
      let inizio = 0
      for (let k = 0; k < n; k++) {
        const prima = avvolgimento
        avvolgimento += sensi[k]
        if (prima === 0 && avvolgimento !== 0) {
          inizio = incroci[k]
          continue
        }
        if (prima === 0 || avvolgimento !== 0) continue

        const da = inizio < c0 ? c0 : inizio
        const fine = incroci[k] > c1 + 1 ? c1 + 1 : incroci[k]
        if (fine <= da) continue
        toccata = true

        const primo = Math.floor(da)
        const ultimo = Math.floor(fine)
        if (primo === ultimo) {
          riga[primo - c0] += (fine - da) * peso
          continue
        }
        // I due pixel di bordo per la parte che ne occupano, e il pieno in
        // mezzo segnato solo dove comincia e dove finisce.
        riga[primo - c0] += (primo + 1 - da) * peso
        salti[primo + 1 - c0] += peso
        salti[ultimo - c0] -= peso
        if (ultimo <= c1) riga[ultimo - c0] += (fine - ultimo) * peso
      }
    }

    if (!toccata) continue
    const base = r * larghezza
    let pieno = 0
    for (let c = 0; c < larghezzaRiga; c++) {
      pieno += salti[c]
      const v = riga[c] + pieno
      if (v > copertura[base + c0 + c]) {
        copertura[base + c0 + c] = v > 1 ? 1 : v
      }
    }
  }
}
