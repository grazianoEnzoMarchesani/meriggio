# Piano: ombre calcolate live e ritagliate, invece del precalcolo giornaliero

Handoff per una chat dedicata. Non implementare nella chat che ha scritto questo
file: è stata usata solo per misurare e validare l'idea, il contesto è pesante.
Questo documento contiene tutto il necessario per partire senza dover rifare le
misure.

## Il problema che risolve

Oggi (`backend/ombra/bake.py`, funzione `bake_day`) il calcolo delle ombre per
il routing precalcola **l'intera giornata su tutta l'area preparata** (60-65
istanti × l'intero raster) al primo utente che chiede quel giorno per quella
città, e lo salva in `.npz`. Misurato su Ascoli (la città più piccola del
progetto, raster 2343×2349 px):

- da riga di comando, in isolamento: **146-190 s**
- passando dall'app reale (thread in background dentro `api.py`, sul
  portatile con altri programmi aperti): **434 s** (7 min 14 s)

Una parallelizzazione su processi (gia' applicata in `bake.py`, vedi sotto) ha
dato solo ~23% di guadagno: l'algoritmo di shadow casting
(`shadow.py:shadow_mask`) sposta ripetutamente array enormi in memoria, quindi
e' limitato dalla banda di memoria, non dalla CPU — aggiungere core aiuta poco
e su una macchina condivisa la contesa lo peggiora.

## L'idea, confermata con un test reale

Il vero spreco non è "un giorno intero", è **"tutta la città"**. Un singolo
istante, calcolato con `shadow.sun_factor` su un ritaglio del raster invece
che sul raster intero, è drammaticamente più veloce. Test fatto su Ascoli
(`load_surfaces` + `sun_factor`, tre orari diversi per coprire angoli di sole
bassi e alti):

| Istante (elevazione sole) | Raster intero (2343×2349) | Ritaglio 500×500 px (1×1 km) | Ritaglio 1500×1500 px (3×3 km) |
|---|---|---|---|
| mattina, elev. 16.9° | 5977 ms | 56 ms | 1453 ms |
| mezzogiorno, elev. 57.8° | 1279 ms | 13 ms | 261 ms |
| sera, elev. 8.7° | 5362 ms | 80 ms | 1856 ms |

Un ritaglio 1×1 km costa 75-100× meno del raster intero. Il costo scala con il
**numero di pixel** del ritaglio (quadraticamente col lato), non con la
posizione del sole in sé (l'elevazione bassa aumenta le iterazioni del ciclo
in `shadow_mask`, ma l'effetto dominante resta la dimensione dell'array).

## Design proposto

Sostituire, per il **solo routing**, il precalcolo giornaliero con un calcolo
live per-richiesta, ritagliato su area e orari del tragitto:

1. In `api.py`, l'handler `/api/percorso` calcola prima il rettangolo che
   contiene partenza e arrivo, con un margine (da tarare: vedi "Punti aperti"
   sotto).
2. Ritaglia `dsm`/`cdsm`/`tau` (gia' caricati per l'area, via `load_surfaces`)
   su quel rettangolo — semplice slicing numpy, costo trascurabile.
3. Calcola quanti istanti servono davvero: non piu' 60-65 (tutta la
   giornata), ma solo quelli fra la partenza e la durata plausibile del
   tragitto, a passi di `COST_BIN_MINUTES` (gia' 2 minuti in `router.py`).
   Consiglio: calcolare prima il percorso "piu' rapido" (nessun costo di
   sole, gia' cosi' in `compute_route`) per sapere la durata plausibile, poi
   dimensionare gli istanti su quello con un margine (es. 1.5-2×, i percorsi
   che evitano il sole possono allungarsi).
4. Per ogni istante necessario, `sun_factor` sul raster ritagliato, poi
   `sample_points` solo sui nodi-campione del grafo che cadono dentro (o
   vicino a) il ritaglio — i tratti fuori dal ritaglio restano al valore di
   default "pieno sole" (convenzione gia' esistente in `sample_points`,
   `default=1.0`), che e' l'assunzione prudente gia' usata oggi per i punti
   fuori raster.
5. Costruire con questi dati la stessa struttura che oggi arriva da
   `DayExposure` (o una classe equivalente costruita al volo), cosi'
   `router.py` (Dijkstra dipendente dal tempo, `_cost_multipliers`,
   `_dijkstra`) non deve cambiare affatto: consuma la stessa interfaccia,
   cambia solo da dove arrivano i dati.
6. Il flusso 503 + polling (`_prepara_in_background`, `_in_preparazione`,
   l'endpoint `/api/aree/{slug}/ombre/stato`) diventa inutile per il routing:
   la richiesta risponde in-linea, senza bisogno di un job in background.

## Cosa NON serve più cambiare

`shadow.py` non richiede modifiche: `shadow_mask`/`sun_factor` già accettano
array di qualsiasi dimensione, il test sopra li ha usati così com'è oggi su
ritagli senza toccare il codice.

## Punti aperti da decidere nella nuova sessione (non ancora risolti qui)

- **Margine del ritaglio**: troppo stretto rischia che Dijkstra esplori fuori
  dal ritaglio durante un tragitto che evita il sole (finirebbe trattato come
  "pieno sole" li', sottostimando il vantaggio di un percorso in ombra appena
  fuori dal bordo). Troppo largo vanifica il guadagno. Punto di partenza
  ragionevole: bbox(partenza, arrivo) allargato di una frazione della
  distanza fra i due punti (es. 40-60%), con un minimo assoluto (es. 400-500
  m) per tragitti molto brevi.
- **Numero di istanti per richiesta**: dimensionarli sulla durata del
  percorso più rapido (vedi punto 3 sopra), non su un valore fisso.
- **Serve ancora il multiprocessing?** Con un ritaglio piccolo, anche 20-30
  istanti in sequenza su un solo processo sembrano gia' rapidi (nel caso
  peggiore misurato, ~80 ms/istante × 30 ≈ 2.4 s totali, tutto single-thread,
  nessun overhead di avvio processi). Da verificare con un test end-to-end
  prima di reintrodurre `ProcessPoolExecutor`: l'overhead di avvio processi
  (visto nei test precedenti, alcuni secondi) potrebbe costare più di quanto
  fa risparmiare su un carico cosi' piccolo.
- **Cosa resta di `bake_day`/`DayExposure`/le cartelle `bake/*.npz`**: se il
  routing smette di usarle, decidere se eliminarle (sono codice morto) o
  tenerle per altri usi (es. statistiche aggregate tipo "% rete in ombra in
  un giorno", oggi calcolate come sottoprodotto del bake in `stats.json`/log).
- **L'immagine di sfondo (`render.py:shadow_overlay`, endpoint
  `/api/aree/{slug}/ombre.png`)** oggi calcola gia' un solo istante alla
  volta (gia' "live", vedi conversazione precedente), ma sul raster
  **intero** (colonna "raster intero" della tabella sopra: 1.3-6 s per
  istante nuovo). Ritagliarla sull'area effettivamente visibile in mappa
  userebbe la stessa tecnica e la renderebbe altrettanto piu' rapida — utile
  ma secondario rispetto al routing, che e' il blocco vero oggi.

## Stato del codice al momento dell'handoff

- `backend/ombra/bake.py` e' gia' stato modificato per parallelizzare
  `bake_day` su piu' processi (funzioni `_init_worker`/`_compute_step`,
  `ProcessPoolExecutor`). Funziona (verificato anche dentro il thread di
  `api.py`), ma da solo non risolve il problema di fondo: resta li' come
  riferimento, probabilmente da rimuovere o ridurre a fallback una volta
  implementato il calcolo live ritagliato.
- Nessun'altra modifica applicata. Il resto del piano sopra e' da
  implementare da zero nella nuova sessione.

## Esito: implementato

Il piano e' stato realizzato in `backend/ombra/live.py`, con
`backend/ombra/exposure.py` a fare da interfaccia comune verso il router.
`shadow.py` non e' stato toccato, come previsto. Segue la risposta misurata
ai punti che erano rimasti aperti.

**Un punto che il piano non aveva previsto, e che si e' rivelato decisivo.**
L'ombra che cade dentro un riquadro e' quasi sempre proiettata da fuori: un
ritaglio nudo sbaglia fino all'1,7% dei pixel con il sole basso. Allargarlo in
tutte le direzioni corregge l'errore ma quadruplica la spesa. Allargarlo solo
sui lati **da cui arriva il sole** da' la stessa accuratezza a un terzo del
costo (ritaglio 1,5 km di sera: 950x950 px in 383 ms contro 1150x1150 px in
1070 ms, entrambi con 0,26% di errore). L'ombra non risale mai verso il sole,
quindi gli altri due lati sono spesa pura.

**Margine del ritaglio: 15% della diagonale, fra 250 e 500 m.** Non stimato ma
misurato: su 1821 percorsi ombreggiati di Ascoli, lo scarto del percorso in
ombra dal riquadro di quello piu' rapido e' zero nella meta' dei casi, 87 m al
novantesimo percentile, 319 m al novantanovesimo. I 40-60% della distanza
ipotizzati nel piano erano sovrastimati di quasi un ordine di grandezza, e la
spesa cresce col quadrato del lato: la prima versione, tarata a occhio su
quei valori, impiegava fino a 175 s per richiesta.

**Il riquadro segue il percorso piu' rapido, non la congiungente.** Una strada
che gira attorno a un fiume o a un dirupo resta cosi' dentro il ritaglio.

**Numero di istanti: durata del percorso piu' rapido x 1,5 + 10 minuti**, a
passi di `bake_step_minutes` (15). Sulle prove il percorso in ombra non si e'
mai allungato di piu' di due minuti e mezzo rispetto al piu' rapido.

**Multiprocessing: non serve.** Un istante su un ritaglio tipico costa fra 10
e 100 ms: l'avvio dei processi costerebbe piu' di quanto farebbe risparmiare.
Tutto in sequenza, in un solo processo.

**Risoluzione: resta quella piena della superficie.** Sottocampiare a 4 m
costerebbe otto volte meno ed e' quello che si fa gia' per l'immagine di
sfondo, ma qui cambiava il percorso scelto in 10 casi su 42: i vicoli del
centro storico sono larghi pochi pixel e sottocampiare ne perde l'ombra. La
velocita' e' venuta invece dal troncare la proiezione dell'ombra alla cornice
effettivamente letta (`max_distance` in `sun_factor`): dimezza il tempo senza
cambiare di nulla il risultato, perche' gli ostacoli che proietterebbero
ombre piu' lunghe sono comunque fuori dal ritaglio.

**Cosa resta di `bake_day`:** e' rimasto come strumento fuori linea, con il
comando `ombra ombre`, ma e' fuori da ogni percorso di richiesta. `prepara`
non lo esegue piu' in automatico: lo fa solo se si passa `--giorno`, cosi'
preparare un'area nuova non paga piu' minuti per un file che l'app non legge.
`DayExposure` e' diventata `exposure.Exposure`, che serve sia i valori
calcolati al momento sia quelli riletti da un `.npz`. I `.npz` gia' su disco
non sono stati toccati. Il flusso 503 + polling e' sparito da `api.py`, dal
client TypeScript e dal pannello.

**Verifica.** 42 percorsi (tre distanze, tre orari, tre modalita', due
valori di alpha) calcolati sia dal precalcolo del 2026-07-30 sia dal vivo:
scarto medio sulla percentuale di ombra 0,08 punti, massimo 1,80; percorso
identico in 39 casi su 42, e i tre diversi sono pari-merito su tragitti da
2,5 km dove le due alternative differiscono di meno di due punti di ombra.

**Tempi per richiesta** (portatile, calcolo compreso nella risposta HTTP):

| tragitto | tempo |
|---|---|
| 684 m, a piedi/bici/carrozzina, mattina-mezzogiorno-sera | 0,08 - 0,47 s |
| 1178 m | 0,42 - 2,25 s |
| 2557 m (attraversa tutta l'area) | 1,3 - 8,2 s |

Il caso peggiore resta l'attraversamento completo della citta' al tramonto
(49 minuti a piedi, sole radente), dove il ritaglio coincide ormai con
l'intera Ascoli e restano sette istanti da calcolare. Contro i 434 s che
costava il primo utente di ogni giornata, e senza piu' nulla da precalcolare
ne' da tenere su disco.
