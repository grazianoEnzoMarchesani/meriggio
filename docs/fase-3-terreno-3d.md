# Fase 3 — il rilievo in tre dimensioni

Passaggio di consegne, 1 agosto 2026. Le fasi 1 e 2 sono fatte e verificate; qui
c'è cosa è cambiato, cosa serve alla fase 3, e le trappole già pagate.

---

## Da dove nasce

L'anteprima delle ombre era pixelata: il modello di superficie è una griglia a
2 m, quindi il bordo di un'ombra *era* una scala a gradini, e accanto a un
edificio estruso — che ha spigoli veri — sembrava un errore di calcolo anche
quando il calcolo era giusto.

La decisione presa insieme all'autore: **assetto ibrido**. Gli edifici fanno
ombra in geometria, dagli stessi poligoni che la mappa estrude; terreno e chiome
restano al raster, dove la sfumatura è onesta perché l'ombra di un albero *è*
sfumata. La punta dell'ombra viene proiettata sul terreno vero (non su un piano
orizzontale), perché ad Ascoli un'ombra lunga che scende un versante arriva
decine di metri più in là.

Da lì la domanda che apre la fase 3: *«se poi continuo a vedere tutto piatto,
che cosa ci faccio? dovrà vedersi comunque in 3D»*.

---

## Cosa c'è adesso

### Fase 1 — il terreno viaggia al client

`export.py` scrive un piano in più nei tasselli: non il DTM intero ma
`dsm - dtm`, l'altezza del **costruito**. È zero quasi ovunque e costante dentro
ogni edificio, quindi il gzip lo azzera quasi: il tassello medio è passato da
175 a 180 kB. Il client ricava il terreno sottraendo.

- formato tasselli **versione 2**, intestazione 28 byte `<4sHHHHffff`
  (magic, versione, flag, w, h, z_offset, z_scale, canopy_scale, built_scale);
- piani in coda nell'ordine: quota `u16`, chioma `u8`, densità arborea `u8`,
  costruito `u8`. `FLAG_BUILT = 4`;
- `built_scale` parte da 0,25 m e raddoppia finché l'edificio più alto del
  tassello ci sta in un byte;
- la **versione 1 si legge ancora** (intestazione 24 byte, nessun costruito): un
  export vecchio resta utilizzabile, semplicemente senza terreno separato.

Lato client, `quotaSuolo(superficie)` in `tiles.ts` restituisce il terreno nudo.
Verificato contro `dtm.tif`: scarto massimo **0,13 m**, medio 0,01 m.

### Fase 2 — le ombre degli edifici in geometria

- **`src/ombra/edifici.ts`** — legge `buildings.geojson` e lo porta in UTM una
  volta sola; costruisce l'ombra come somma di Minkowski dell'impronta con il
  raggio solare (impronta + copia traslata + un quadrilatero per lato), e per
  ogni vertice insegue il raggio finché non incontra qualcosa.
- **`src/ombra/rasterizza.ts`** — riempie i poligoni con i bordi sfumati, in JS
  puro (niente `Path2D`: deve girare nel worker e nei test in node). Otto
  sotto-righe per riga, copertura esatta in orizzontale, avvolgimento non-zero
  perché i pezzi si fondano senza cuciture. Gli intervalli pieni sono segnati
  solo agli estremi e riaperti da una somma cumulata: senza questo costava
  200 ms per fotogramma.
- **`src/ombra/overlay.ts`** — mette insieme le due maschere prendendo la più
  scura, e ritaglia via l'ombra che cadrebbe sulle impronte.

---

## Quello che serve sapere prima di toccare la fase 3

### Il DTM c'è già, ovunque serva

| dove | cosa |
|---|---|
| backend | `data/aoi/ascoli-piceno/dtm.tif` — 2343×2349 a 2 m, EPSG:32633, **99,9–690,8 m slm**, 591 m di dislivello |
| esportato | dentro i tasselli come `dsm - dtm`, ricostruibile esattamente |
| client | `quotaSuolo(superficie)` |

Ascoli è su un colle e il dislivello dell'area è di **591 m**: il rilievo si
vede, ma alla scala della valle più che a quella della strada. Vale la pena
verificarlo presto con un'esagerazione a 1 prima di costruirci sopra.

### MapLibre: cosa accetta e cosa no

Versione in uso: **maplibre-gl 6**.

- `map.setTerrain({ source, exaggeration })` esiste
  (`maplibre-gl.d.ts:13682`) e vuole una sorgente **`raster-dem`**: tessere PNG
  in XYZ Web Mercator, codifica `terrarium` o `mapbox`.
  Terrarium: `quota = (R * 256 + G + B / 256) - 32768`.
- `addProtocol` esiste (`maplibre-gl.d.ts:9850`): si potrebbero servire le
  tessere da JS riproiettando i nostri tasselli UTM al volo, invece di
  esportarle. Più codice, e la riproiezione finirebbe sul telefono.
- **Solo certi layer vengono drappeggiati sul terreno.** Nel bundle:

  ```js
  LAYERS_TO_TEXTURES = { background, fill, line, raster, hillshade, "color-relief" }
  ```

  Le **custom layer non ci sono**. È il motivo per cui l'ombra è rimasta
  un'immagine (`type: 'raster'`, che drappeggia) e non una custom layer con
  stencil: quella si sarebbe rotta proprio accendendo il terreno. Se in futuro
  si vuole passare a WebGL per le ombre, questo vincolo va riaffrontato.
- `maxPitch: 70` è già impostato in `MapView.tsx`.

### Le estrusioni si appoggiano al rilievo — verificato, sì

Risposto leggendo lo shader invece di fidarsi dell'occhio: nel bundle di
sviluppo (`maplibre-gl-dev.mjs`) il vertex shader di `fillExtrusion` ha un ramo
`#ifdef TERRAIN3D` che chiama `get_elevation(a_centroid)` e lo somma sia a
`base` che a `height` prima di proiettare il vertice. Quando `setTerrain` è
attivo MapLibre definisce `TERRAIN3D` per quel layer, quindi gli edifici
seguono il rilievo — non restano a quota zero mentre il terreno si solleva
sotto. Il dubbio della fase precedente era legittimo (non c'era prova nel
bundle minificato) ma la risposta era già scritta nel sorgente, bastava
cercarla nel bundle di sviluppo invece che in quello minificato.

---

## Il piano — fatto

1. **Esportare le tessere di quota.** `export_terrain` in `export.py`: warp
   tassello per tassello da `dtm.tif` (EPSG:32633) a EPSG:3857 con
   `rasterio.warp.reproject` (bilineare), poi codifica Terrarium
   (`R*256+G+B/256-32768`, precisione 1/256 m) e PNG con Pillow, che è
   rientrata come dipendenza solo per questo (vedi `requirements.txt`).
   Deciso: **z12–z15**, tassello **256 px** (lo standard Terrarium). Per
   Ascoli sono 53 tessere, 3,5 MB in tutto — un decimo del peso della
   superficie. Voce `terrain` nel manifesto, `null` se l'area non ha
   `dtm.tif`. Verificato il valore decodificato di una tessera contro il DTM
   sorgente in un punto: scarto 0,25 m (il tassello a z15 è ~4,8 m/px, lo
   scarto è dentro il ricampionamento atteso).
2. **Accendere il terreno.** Sorgente `raster-dem` costruita da
   `motore.terreno(slug)` (che legge il template `terrain/{z}/{x}/{y}.png`
   dal manifesto) e `setTerrain` in `MapView.tsx`, ricreati insieme agli
   edifici quando cambia l'area. La manopola è nel pannello ("Rilievo 3D",
   0–3, passo 0,25, default 1,5): sposta solo `exaggeration`, e a 0 chiama
   `setTerrain(null)` invece di lasciare la sorgente attiva a esagerazione
   nulla. Le estrusioni si appoggiano al rilievo (verificato sopra); l'immagine
   delle ombre resta un layer `raster`, quindi si drappeggia com'era già
   previsto, senza correzioni.
3. **Guardato.** Alla scala di quartiere (zoom ~15, pitch alto) il rilievo si
   vede chiaramente: i versanti a nord della città portano ombre di chioma
   che seguono il pendio, non un piano piatto. Alla scala di strada dentro il
   centro storico — che sta su un terrazzo di travertino quasi piano — il
   rilievo onestamente non si nota, ed è il terreno reale a essere piatto lì,
   non un limite del rendering: verificato spostandosi verso valle, dove il
   DTM scende sul serio. Il default a 1,5 è un punto di partenza ragionevole;
   la manopola resta per chi vuole esagerare di più guardando dai bordi
   dell'area, dove il dislivello è reale.

---

## Trappole già pagate

Sono errori fatti davvero in fase 2. Costano ore se ripetuti.

- **Il magazzino dei dati sopravvive al ricaricamento forzato.** `rete.ts` tiene
  i file in Cache Storage di proposito. Cambiando il formato dei tasselli, il
  client continuava a leggersi quelli vecchi e falliva con «tassello di
  versione 1» anche dopo la riesportazione. Ora il nome della cache porta la
  versione del formato (`ombra-dati-v${VERSIONE_TASSELLI}`) e un giro di pulizia
  butta gli scaffali vecchi. **Se la fase 3 cambia ancora il formato, la
  versione va alzata lì.**
- **Il raster e la geometria rispondono a due domande diverse.** Il raster dice
  «questo *tetto* è in ombra?», la geometria «questo *terreno* è in ombra?». In
  un centro storico i tetti sono metà della superficie: dipingendo anche le
  impronte si arrivava al 90% di scuro contro il 27% del motore. Le impronte ora
  ritagliano via l'ombra.
- **Il raggio deve fermarsi sugli edifici, non solo sul terreno.** Il piede del
  muro si conta dal terreno, ma il raggio viaggia sopra la superficie: senza
  questo le ombre correvano per quaranta metri attraversando i palazzi.
- **Mercatore non è UTM.** Il riquadro dell'immagine è in metri Mercatore, che
  ad Ascoli sono 1,364 volte i metri veri (1/cos 42,85°). Chi confronta una
  distanza a terra con un numero di pixel deve passare da lì.
- **Guardare le immagini non basta a fare diagnosi.** Su questo lavoro ho
  sbagliato due diagnosi di fila fidandomi dell'occhio; le ho risolte misurando:
  prima verificando il motore raster su una scena costruita a mano (blocco di
  9 m a 14,6°: ombra di 34 m, attesa 34,6), poi confrontando le due maschere
  pixel per pixel. Stessa lezione in fase 3: la domanda sulle estrusioni sopra
  non l'ho risolta guardando uno screenshot ma leggendo lo shader.
- **Chromium headless e i blob delle ombre.** Verificando in un browser vero
  (Playwright, non i test `node --test`) compare in console
  `InvalidStateError: The source image could not be decoded` sull'immagine
  delle ombre — capita anche a terreno spento, quindi non c'entra con questa
  fase. Non l'ho inseguito oltre: non ho trovato prova che accada fuori da
  Chromium headless, ma non l'ho nemmeno escluso in un browser vero. Se
  qualcuno lo rivede, prima cosa da controllare.

---

## Come si verifica

Dalla cartella `web/`:

```
npx tsc -b && npx oxlint
npx node --test "test/**/*.test.ts"     # 25 test
npm run anteprima -- 19:00 220 /tmp/sera.png   # come si vede, senza browser
npm run prestazioni
```

Dalla cartella `backend/`:

```
.venv/bin/python -m ombra.cli esporta --area ascoli-piceno
```

I test che coprono il lavoro nuovo:

- `test/edifici.test.ts` — le ombre geometriche confrontate con `sunFactor` (che
  è verificato contro il Python) su suolo aperto e lontano dai bordi:
  disaccordo **0,17% / 0,11% / 3,75%** alle 9, alle 13:30 e alle 19.
- `test/rasterizza.test.ts` — sette figure di cui l'area si sa a mente.
- `test/tiles.test.ts` — include un tassello di versione 1 costruito byte per
  byte, a bloccare la compatibilità all'indietro.

Tempi attuali (portatile, un istante, immagine a risoluzione di schermo):

| inquadratura | tempo |
|---|---|
| strada (65 m) | 71 ms |
| isolato (220 m) | 98 ms |
| quartiere (976 m) | 228 ms |
| città (3,4 km) | 1094 ms |

---

## Aperto, e non toccato di proposito

**La soglia della veduta d'insieme** (`area.ts`, `usaVeduta`). Alla scala della
città il client scarica e macina i tasselli a 2 m invece della veduta a 8 m:
sono ~900 ms di `sunFactor` su 1847×1856 celle, cioè quasi tutto il secondo
della riga «città» qui sopra. Le ombre geometriche lì pesano 105 ms. È una riga,
ma tocca anche la rete e il routing, quindi va deciso e non fatto di slancio —
segnalato all'autore, che non ha ancora scelto.
