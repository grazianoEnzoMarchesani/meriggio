# Piano: riscrittura client-side, niente backend in produzione

Handoff per una chat dedicata all'implementazione. Questo documento contiene
il disegno completo: formato dei dati, cosa si riusa del Python esistente,
come si porta ogni algoritmo in TypeScript, il flusso applicativo, l'hosting
e le fasi di lavoro. Non implementare qui: apri una sessione nuova con questo
file come contesto.

## Obiettivo

Oggi (vedi [piano-ombre-live.md](piano-ombre-live.md)) il calcolo delle ombre
per il routing è già live e ritagliato — quello va bene. Il problema è
architetturale: serve un server FastAPI **sempre acceso** che deve girare da
qualche parte. L'obiettivo di questo piano è eliminarlo del tutto in
produzione: l'utente apre una pagina statica, il calcolo (ombre + percorso)
avviene nel browser, nessuna richiesta a un server applicativo.

Il backend Python non sparisce: **cambia ruolo**. Da "servizio che risponde
in tempo reale" a "script che lanci tu una volta per città", il cui output
sono file statici da caricare ovuncomo (GitHub Pages, per iniziare).

## Cosa si riusa e cosa si riscrive

| Modulo oggi | Sorte | Motivo |
|---|---|---|
| `aoi.py`, `sources.py`, `surface.py`, `graph.py` | **Riusati quasi invariati** | Restano l'unico modo sensato di scaricare/processare TINITALY, Global Building Atlas, ETH Canopy, Copernicus, OSM. Girano offline, sul tuo Mac, una volta per città. |
| `bake.py` | **Eliminato** | Già di fatto morto codice (vedi piano-ombre-live.md), non serve al nuovo disegno. |
| nuovo `export.py` | **Da scrivere** | Prende `dsm.tif`/`cdsm.tif`/`tcd.tif`/`graph.npz` già costruiti e li serializza nel formato a tasselli per il client (dettagli sotto). |
| `shadow.py` | **Portato in TypeScript** | Algoritmo puro (shift-and-max su array), nessuna dipendenza geospaziale. Porting meccanico. |
| `solar.py` | **Portato in TypeScript** | Formule NOAA, solo matematica scalare/vettoriale. Porting meccanico, va **validato** contro i valori di riferimento già verificati (70,58° solstizio d'estate ad Ascoli). |
| `router.py` | **Portato in TypeScript** | Dijkstra dipendente dal tempo + euristica A*: algoritmo "normale", non geospaziale. |
| `graph.py` (building) | **Resta Python**, solo l'output cambia formato | La costruzione del grafo da OSM resta offline; cambia solo come viene salvato per il client. |
| `render.py`, `api.py` | **Eliminati** | Non serve più un'API HTTP: il client ha già tutto quello che gli serve nei file statici. |
| `pyproj` (UTM ↔ WGS84) | Sostituito da **proj4js** (o formule dirette, essendo sempre UTM) | Nessuna libreria Python nel browser. |
| `scipy.spatial.cKDTree` | Sostituito da un **KD-tree minimale fatto a mano** (~40 righe) o `kdbush` (npm, piccolissimo) | Serve solo per "nodo più vicino a un punto cliccato". |
| `scipy.sparse.csgraph.connected_components` | Sostituito da **union-find fatto a mano** (~20 righe) | Usato in `choose_component`, banale da riscrivere. |

## Formato dati per città (l'esportazione)

### Tasselli di superficie

Griglia di tasselli quadrati, lato **512 px a 2 m** (= 1024×1024 m), stessa
risoluzione di oggi. Per ogni tassello, tre layer:

- `dsm` (terreno + edifici, opaco)
- `cdsm` (terreno + chiome)
- `tau` (trasmissività della chioma, 0-100)

**Quantizzazione**: quote in centimetri, `Int16` (range ±327 m dal minimo
locale del tassello, ampiamente sufficiente — nessuna città italiana ha 327 m
di dislivello in 1×1 km salvo casi estremi da gestire con un offset per
tassello). `tau` in `Uint8` (0-100 già nativo). Compressione: ogni tassello
salvato come PNG (un canale per `dsm`/`cdsm` splittato in due byte alto/basso
dentro i canali R/G, `tau` nel canale B — tecnica identica ai Terrain-RGB di
Mapbox) — la compressione PNG lossless su dati di elevazione reali (superfici
lisce a tratti) tipicamente dimezza ulteriormente il peso rispetto al binario
grezzo. Un tassello 512×512×3 canali ≈ 250-400 KB dopo compressione.

Ascoli (raster 2343×2349 px a 2 m) diventa così **~25 tasselli**, qualche MB
totali invece di 50-70 MB grezzi — e soprattutto: **si scaricano solo quelli
del corridoio del percorso**, non l'intera città (stessa idea già validata
per il calcolo live, applicata qui al download invece che al calcolo).

### Manifest per città

Un JSON piccolo (`ascoli-piceno/manifest.json`) con: bounds, centro,
`utm_epsg`, `timezone`, risoluzione, griglia dei tasselli (origine + step +
elenco `{tile_x, tile_y, url, z_offset}`), url del grafo. Il frontend lo
scarica per intero all'apertura di una città (poche KB, non è un problema).

### Grafo stradale compatto

Non serve tassellare il grafo: anche per una città media pesa poche centinaia
di KB — molto meno dei raster. Si esporta `graph.npz` in un formato binario
compatto leggibile da JS senza librerie:

- un header piccolo (contatori: n_nodi, n_archi, n_campioni)
- una sequenza di `TypedArray` concatenate (stesso ordine di oggi:
  `node_xy`, `node_lonlat`, `edge_u`, `edge_v`, `edge_len`, `edge_slope`,
  `edge_flags`, `edge_rough`, `sample_offset`, `sample_xy`, `adj_start`,
  `adj_target`, `adj_edge`), con le stringhe (`names`) serializzate a parte
  in JSON (sono poche decine).

Nel browser questo si legge con un singolo `ArrayBuffer` + viste
`Float64Array`/`Int32Array`/`Uint8Array` a offset noti — esattamente come fa
oggi `np.load` lato Python, senza bisogno di un parser complesso (niente
`.npz`/zip: un binario piatto è più semplice da leggere in JS).

## Porting degli algoritmi

### `solar.ts` (da `solar.py`)

Porting diretto: le formule NOAA (`solar_position`, `sun_times`,
`clear_sky_irradiance`, `solar_load`) sono matematica scalare pura, nessuna
dipendenza. Da validare a fine porting con lo stesso test già fatto in
Python: elevazione al solstizio d'estate/inverno ad Ascoli, mezzogiorno
solare al secondo.

### `shadow.ts` (da `shadow.py`)

Il cuore dell'app. `shadow_mask` (righe 28-126) è un ciclo che trasla un
array 2D e tiene il massimo cumulato — porta bene su `Float32Array` in un
**Web Worker** (per non bloccare il thread UI). Punti da preservare esatti
nel porting, perché sono la parte "furba" dell'algoritmo:

- il calcolo del passo (`east_west_dominant`, `step_len`) che garantisce
  campionamento ≤ 1 pixel;
- la finestra sorgente/destinazione (righe 108-116) per lo shift senza
  allocare un nuovo array a ogni iterazione;
- `max_distance` che tronca la proiezione (dimezza il costo senza cambiare
  il risultato, già misurato);
- il trattamento separato di edifici (occluder = receiver) e vegetazione
  (occluder = max(dsm, cdsm), receiver = dsm) in `sun_factor` — è il pezzo
  che nel README è segnalato come concettualmente delicato (l'ombra
  dell'albero va sul terreno, non sulla chioma stessa).

`canopy_transmissivity` e `sample_points` sono trasformazioni banali,
porting meccanico.

**Verifica di parità numerica**: prima di fidarsi del porting, calcolare
`sun_factor` in Python e in TS sullo stesso tassello sintetico (stesso `dsm`,
stesso sole) e confrontare pixel per pixel. Scarto atteso: zero o
arrotondamento in virgola mobile, non di più — è la stessa identica
sequenza di operazioni.

### `router.ts` (da `router.py` + `graph.py`)

- `edge_speeds` (Tobler a piedi, penalità marcate per bici/carrozzina):
  porting diretto, pura matematica su array.
- `_cost_multipliers`, `_dijkstra` (righe 78-249): Dijkstra dipendente dal
  tempo con euristica A*, già scritto in modo esplicito con code di
  priorità (`heapq` → `TinyQueue`/binary heap fatto a mano in JS, o
  implementazione a array visto che i grafi cittadini sono piccoli).
  Nessuna dipendenza esterna in questa parte.
- `choose_component` (connected components + KD-tree): la parte che usa
  scipy. Da riscrivere con union-find (banale, il grafo è già in forma
  CSR/liste di adiacenza) e un KD-tree minimale per `snap`.

### Coordinate: UTM ↔ WGS84

`pyproj` fa solo trasformazioni tra WGS84 e un singolo fuso UTM fisso per
area (calcolato una volta in `aoi.utm_epsg`). Non serve una libreria
generale: le formule di proiezione UTM dirette e inverse sono ~30 righe di
matematica, oppure si usa `proj4js` (npm, leggerissimo) passandogli
semplicemente il codice EPSG già presente nel manifest.

## Flusso applicativo lato client

1. Apertura app → fetch del manifest della città (o di un indice
   `cities.json` con bounds di tutte le città disponibili, per scegliere
   quella giusta da posizione GPS o selezione manuale).
2. Fetch del grafo binario per quella città (una volta, tenuto in cache
   IndexedDB/Cache Storage per riuso offline).
3. Utente sceglie partenza/arrivo (click sulla mappa o "usa la mia
   posizione" — vedi nota sotto).
4. **Nel Web Worker**: calcola prima il percorso più rapido (nessun costo
   sole) sul grafo già in memoria — istantaneo, è solo Dijkstra su un grafo
   piccolo.
5. Dal percorso più rapido si ricava il corridoio (bbox allargato lato-sole,
   15% della diagonale fra 250-500 m — parametri già misurati e validati in
   `piano-ombre-live.md`) e la durata plausibile (→ numero di istanti).
6. Si calcolano quali **tasselli** intersecano il corridoio e si scaricano
   solo quelli (tipicamente 1-4 tasselli, poche centinaia di KB — cache
   Service Worker per non riscaricarli se l'utente ripete un percorso
   simile).
7. Per ogni istante necessario: `sun_factor` sul mosaico dei tasselli
   scaricati (stessa identica funzione di oggi, in JS). Tempo atteso, per
   analogia coi numeri già misurati in Python su ritagli comparabili
   (10-100 ms per istante su un ritaglio 500×500-1500×1500 px): del tutto
   fattibile anche su un telefono di fascia media dentro un Worker.
8. Dijkstra dipendente dal tempo con questi dati di esposizione → percorso
   ombreggiato, confrontato col più rapido.
9. L'immagine di ombre sulla mappa (oggi `render.py:shadow_overlay`) diventa
   un canvas disegnato lato client dagli stessi tasselli, ritagliato sul
   viewport corrente della mappa — nessuna richiesta di rete oltre ai
   tasselli già scaricati.

### Aggiunta consigliata: geolocalizzazione

Nessun `navigator.geolocation` nel frontend attuale (verificato). Con
un'app puramente client-side, usata per strada, un pulsante "usa la mia
posizione" come punto di partenza è a costo quasi zero e cambia molto
l'usabilità reale. Richiede HTTPS (GitHub Pages lo dà gratis di default).

## Hosting

- **Codice + frontend build**: GitHub, deploy su **GitHub Pages** (gratis,
  HTTPS incluso, si aggiorna con `git push` + una action di build, oppure
  build manuale e push della cartella `dist/`).
- **Dati (tasselli + grafi)**: nello stesso repo/Pages finché il totale resta
  sotto qualche centinaio di MB (vedi tabella limiti sopra). Se in futuro
  servono molte città o aree più grandi: stessa cartella ma sincronizzata
  su **Cloudflare R2** (10 GB gratis, zero banda in uscita), referenziata
  dagli URL nel manifest — cambio trasparente per il frontend, che vede solo
  URL diversi.
- Nessun server da amministrare, riavviare, monitorare. Preparare una città
  nuova resta `ombra.cli prepara` + il nuovo comando di esportazione sul tuo
  Mac; il risultato è una cartella da committare/sincronizzare.

## Fasi di lavoro (ordine consigliato)

1. **`export.py`**: dal set di dati già preparato per Ascoli, generare
   tasselli + manifest + grafo binario. Verificabile da solo, senza toccare
   il frontend.
2. **`solar.ts`**: porting + validazione numerica contro `solar.py` (stessi
   istanti, stesso confronto già fatto ad Ascoli).
3. **`shadow.ts`**: porting + validazione pixel-per-pixel contro `shadow.py`
   su un tassello sintetico piccolo, poi su un tassello reale di Ascoli.
4. **Router + grafo in JS**: porting di `graph.py` (solo lettura del
   binario) e `router.ts`, testato con partenza/arrivo noti e confronto
   del percorso trovato oggi dal backend Python.
5. **Integrazione worker + UI**: sostituire le chiamate `api.ts` con le
   funzioni locali, mantenendo l'interfaccia dati (`RisultatoPercorso` ecc.)
   il più possibile invariata per non dover riscrivere i componenti React
   (`MapView.tsx`, `Timeline.tsx`, `SunDial.tsx`, `Panel.tsx` restano quasi
   uguali: cambiano solo *da dove* arrivano i dati).
6. **Rendering ombre su canvas** al posto di `ombre.png`.
7. **Rimozione del backend FastAPI** (`api.py`, `render.py`, dipendenza da
   uvicorn in produzione — restano solo come strumenti offline se servono
   ancora per debug).
8. **Deploy su GitHub Pages** e test reale da smartphone in rete mobile.

## Rischi da verificare, non ipotesi

- **Parità numerica** Python↔JS: da validare esplicitamente (passo 2-3
  sopra), non da assumere. Il rischio maggiore è nell'aritmetica dei bordi
  di `shadow_mask` (gli indici `src_r0`/`dst_r0` ecc.), che va portata
  operazione per operazione, non "reinventata".
- **Prestazioni su telefoni di fascia bassa**: i numeri di riferimento
  (10-100 ms/istante) sono misurati su Python/numpy su portatile. JS con
  typed array in un Worker è generalmente comparabile per questo tipo di
  calcolo (niente overhead di interprete Python, ma nessuna vettorizzazione
  SIMD nativa come numpy) — da misurare presto col porting minimo (passo 3),
  non alla fine. Se risultasse insufficiente su hardware datato, la via
  d'uscita è WebGL/WebGPU (il calcolo si presta benissimo a un compute
  shader), ma è probabile non serva: i ritagli sono piccoli per costruzione.
- **Dimensione dei tasselli per città grandi**: se in futuro si copre un
  centro storico molto esteso (Roma, Milano), verificare che il numero di
  tasselli per corridoio resti piccolo anche lì — potrebbe servire una
  dimensione di tassello diversa (es. 256 px) per centri molto irregolari.

## Esito: implementato

Il backend FastAPI non esiste più: `api.py`, `render.py` e `bake.py` sono stati
cancellati, e con loro `fastapi`, `uvicorn` e `pillow` dalle dipendenze. Quello
che resta del Python prepara le aree e produce i valori con cui si verifica il
porting. Segue la risposta ai punti che il piano lasciava aperti, più le due
cose che il piano non aveva previsto e che hanno cambiato il disegno.

**La cosa decisiva: per il routing non serve il raster.** Il piano dava per
scontato di portare `shadow_mask` così com'era e calcolare l'ombra su tutto il
ritaglio, poi campionarla nei punti del grafo. Misurato: un ritaglio di 1,5 km
di lato al tramonto costa 1,4 s per istante, e il collo di bottiglia è la banda
di memoria — trecento passate su nove megabyte di array — non il numero di
operazioni. Su un telefono sarebbe stato inusabile.

Ma gli scostamenti con cui l'algoritmo trasla la superficie **dipendono solo dal
passo, non dal pixel**. L'orizzonte di un singolo punto si può quindi calcolare
da solo, senza traslare niente, e il massimo è commutativo: il numero che esce è
identico bit per bit. I punti in cui il grafo chiede l'ombra sono qualche
migliaio, i pixel del ritaglio qualche milione. Stesso risultato, **settanta
volte meno lavoro**: il caso peggiore passa da 1,4 s a 20 ms per istante.
`sunFactor` su tutto il raster resta, ma solo per disegnare le ombre sulla
mappa, dove i punti da sapere sono davvero tutti.

L'ipotesi di ripiego del piano — WebGL o WebGPU se le prestazioni non
bastassero — non è servita, e la strada era un'altra: non fare il calcolo più
in fretta, farne di meno.

**Formato dei tasselli: binario compresso, non PNG.** Il piano proponeva la
tecnica dei Terrain-RGB di Mapbox, ma i dati sono sei byte per pixel (quota su
due, chioma su uno, densità arborea su uno, costruito su uno) e in un PNG a tre
canali non ci stanno. Il quarto canale non è utilizzabile: la canvas
premoltiplica l'alfa e corrompe gli altri tre. Un blocco binario con la stessa
differenza di riga che userebbe il PNG, compresso con `gzip` e scompattato con
`DecompressionStream`, evita il problema e comprime uguale. Ascoli sta in
**4,4 MB di tasselli** (25 tasselli da 180 kB), 436 kB di grafo, 676 kB di
veduta d'insieme e 1,1 MB di edifici: 6,6 MB in tutto, di cui un tragitto tipico
scarica qualche centinaio di kilobyte.

Il piano del **costruito** (`dsm - dtm`, versione 2 del formato) è arrivato
dopo, per disegnare le ombre degli edifici in geometria invece che per pixel: al
client serve il terreno nudo, sia per sapere da che quota parte un muro sia per
sapere dove la sua ombra tocca terra. Viaggia come differenza e non come seconda
superficie perché è zero quasi ovunque e costante dentro ogni edificio: le due
superfici intere sarebbero state due volte lo stesso profilo di collina, così
invece il tassello medio passa da 175 a 180 kB: **meno del 3%**.

**Grafo: 944 kB grezzi, 436 kB compressi.** Rispetto al `.npz` sono cadute tre
cose. I punti di campionamento dell'ombra erano due terzi del peso e si
ricostruiscono dagli estremi dei tratti: si porta solo quanti ne ha ciascuno,
perché rifare quel conto in virgola mobile potrebbe arrotondare diversamente. Le
quote dei nodi servivano solo alle pendenze, già calcolate. L'identificativo OSM
della via non lo legge nessuno. Le coordinate metriche viaggiano come
millimetri interi rispetto a un'origine.

**Aggiunta non prevista: una veduta d'insieme a 8 m.** Disegnare le ombre di
tutta la città avrebbe richiesto tutti i tasselli, cioè 4,3 MB per mostrare un
dettaglio che a quello zoom non si vede. L'esportazione produce quindi anche
l'intera area sottocampionata di quattro, in un blocco da 652 kB, che serve
finché un pixel dello schermo vale più di 8 m di terreno. Sotto quella soglia si
passa ai tasselli veri.

**Parità numerica: verificata, non assunta.** `web/test/` confronta le due
implementazioni sui valori che produce `python -m ombra.cli riferimenti`:

| verifica | esito |
|---|---|
| posizione del sole, 520 istanti su cinque località | scarto < 1e-9 gradi |
| alba, tramonto, mezzogiorno solare su otto giorni | scarto ≤ 1 ms |
| `sun_factor`, quattro scene × dodici angoli | **identico, pixel per pixel** |
| calcolo per punti contro calcolo su raster | **identico, ogni pixel** |
| UTM contro pyproj, cinque fusi e l'emisfero sud | scarto < 1 cm |
| 24 percorsi (3 tragitti × 3 orari × modalità) | **geometria identica** |

Il porting ha sbagliato una cosa sola, e il confronto l'ha presa: numpy converte
uno scalare Python a 32 bit *prima* di sommarlo a un array float32, mentre
sommare in doppia precisione e arrotondare dopo dà l'ultimo bit diverso. Si
vedeva su 41 pixel di trasmissività della chioma su 4096.

**Costo della quantizzazione.** Le quote passano da float32 a centimetri interi.
Sul centro di Ascoli questo cambia lo 0,0% dei pixel d'ombra con il sole alto e
lo 0,05% nel caso peggiore (sole a 3-8 gradi, quando le ombre sono lunghissime):
una decina di pixel su trentaseimila. Il ritaglio del corridoio, già misurato a
suo tempo, incide dello 0,003-0,31%.

**Velocità.** I 24 percorsi di riferimento, che il backend Python calcola in
24 s, nel browser costano 2,2 s in tutto — un ordine di grandezza meno, perché
il grosso non è il Dijkstra ma le ombre, e quelle ora si calcolano solo dove
servono.

**Aggiunte all'interfaccia.** Il pulsante «la mia posizione» (che il piano
consigliava) e gli orari letti sull'orologio dell'area invece che su quello del
dispositivo: chi programma da altrove un percorso ad Ascoli intende le nove ad
Ascoli. Il fuso lo risolve `Intl`, che è già nella piattaforma.

**Quello che ancora esce in rete** è solo la ricerca degli indirizzi, che è
Nominatim di OpenStreetMap e non è mai stato codice nostro. Se non risponde
restano il clic sulla mappa e il pulsante della posizione.
