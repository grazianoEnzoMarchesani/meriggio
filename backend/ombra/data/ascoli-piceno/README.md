# pums_traffico.csv — note sulla trascrizione

Fonte: Comune di Ascoli Piceno, PUMS, "AQ2_Conteggi automatici di traffico",
TPS Pro srl, maggio 2025 (141 pagine). Trascritto a mano dal PDF in chat,
non generato da un parser: prima di usarlo per calibrare il modello di
dispersione, vale la pena un controllo a campione contro il PDF originale,
specie sulle colonne di picco elencate sotto.

## Cosa contiene

Solo le **11 sezioni correnti monodirezionali → 21 righe** (§2 del PDF,
`ID/Strada/Da/A/Data`), non le 12 intersezioni con manovre di svolta (§3) né
il rilievo pedoni/cicli (§4/§5): queste ultime due parti del PDF non sono
state trascritte perché il modello di dispersione (OSPM) lavora su tratti di
strada, non su nodi-intersezione o flussi pedonali. Se in futuro serve un
indice di esposizione anche per chi cammina, i dati sono nel PDF (§4) ma
vanno aggiunti a parte.

## Colonne

- `gruppo`: `cordone` (le 8 sezioni del centro storico, le più affidabili
  per calibrare la dispersione in canyon stradale), `pedonale` (04A/04B/06B/
  08A/08B, incluse nel cordone ma a basso traffico veicolare), `periferica`
  (21A/21B/22A/22B/23A/23B, extraurbane, traffico molto basso — utili solo
  come punti di controllo per il fallback tipologico OSM, non per calibrare
  il canyon urbano).
- `*_14h`: totali sull'intero rilievo di 14 ore (06:00–20:00), presi
  **parola per parola** dalla tabella "Composizione veicolare" di ogni
  sezione — questi sono i numeri più affidabili del file, bassa probabilità
  di errore di trascrizione.
- `picco_mattino/mezzodi/pomeriggio_veic_h`: veicoli/ora (tutte le classi
  sommate) nelle tre fasce di punta **cittadine** (7:45–8:45, 12:30–13:30,
  17:00–18:00, identificate nel PDF dalla cumulata del cordone — non sono
  necessariamente il picco locale della singola sezione, che a volte cade
  altrove). Presi dalla colonna "flusso orario su base 60'" delle tabelle
  DATI DI TRAFFICO GIORNALIERO, riga per riga alle tre ore esatte.
  **Meno affidabili delle colonne `_14h`**: trascritti da tabelle OCR dense,
  specialmente sulle sezioni a basso traffico (21A/21B/22A/22B/23A/23B/08A/
  08B) dove i valori sono piccoli e un errore di trascrizione pesa
  proporzionalmente di più. Le sezioni del cordone (01–07) sono state
  controllate per coerenza interna (autoveicoli rilevati × 4 = flusso base
  15') dove il PDF lo rendeva verificabile.

## Cosa manca, voluto

- **Composizione veicolare per classe nelle tre fasce di punta**: era
  segnata come mancante in una versione precedente di questo file, perché si
  pensava richiedesse OCR manuale su tabelle scannerizzate troppo dense per
  essere affidabile. Non è più vero: vedi `pums_traffico_15min.csv` sotto,
  che copre l'intera giornata (non solo le 3 fasce) a risoluzione di 15
  minuti già scomposta per classe — quindi questo punto è superato, non
  manca più nulla qui salvo le due voci seguenti.
- **Geometria/associazione ai tratti OSM**: non in questo CSV. Il PDF non dà
  coordinate precise delle sezioni (solo foto e planimetrie); le coordinate
  approssimate stanno invece in `pums_traffico_vie.csv` (vedi sotto), e
  l'aggancio ai tratti del grafo vero e proprio lo fa
  `backend/ombra/traffico.py`.
- **Le 12 intersezioni e i dati pedoni/cicli**: vedi sopra, fuori scopo per
  ora.

# pums_traffico_15min.csv — serie oraria a 15 minuti, per classe veicolare

Stessa fonte del CSV sopra (§2 del PDF), ma dalla terza pagina di ogni
sezione ("DATABASE"), non dalla prima ("Composizione veicolare") né dalla
seconda ("DATI DI TRAFFICO GIORNALIERO"): quella terza tabella riporta, per
ogni sezione, un conteggio ogni 15 minuti dalle 06:00 alle 19:45 (56 righe),
già scomposto per le stesse 7 classi veicolari dei totali `_14h` (bici,
moto, auto, comm_leggeri, pesanti_isolati, autobus, pesanti_combinati). È il
dato che permette una vera variazione oraria dell'indice di traffico, invece
dell'approssimazione "mix di classi costante durante il giorno" che sarebbe
servita usando solo i 3 picchi di `pums_traffico.csv`.

Colonne: `id, ora, bici, moto, auto, comm_leggeri, pesanti_isolati, autobus,
pesanti_combinati` — `ora` è l'inizio del quarto d'ora in formato `HH:MM`
(fuso locale, stesso giorno del rilievo di `pums_traffico.csv`). 21 sezioni
× 56 righe = 1176 righe dati.

Trascrizione: lettura multimodale diretta delle pagine del PDF (le tabelle
sono immagini incorporate, non testo estraibile — `pdftotext` non vede
nulla al loro interno), non OCR automatico. Verificata riga per riga (la
colonna "Totale" della tabella originale è la somma delle 7 colonne di
classe sulla stessa riga) e per somma di colonna sulle 56 righe contro i
totali `*_14h` già trascritti in `pums_traffico.csv`, che sono la verità di
riferimento: ogni colonna di ogni sezione torna esatta contro quei totali.
Alcuni errori di lettura iniziali (cifre singole scambiate, es. "83" letto
al posto di "63") sono stati trovati e corretti proprio grazie a questo
confronto — è il motivo per cui il controllo è stato fatto per colonna e non
solo a campione.

Non include ancora: le composizioni per classe delle 12 intersezioni (§3,
manovre di svolta) né i conteggi pedoni/cicli (§4/§5) — stesso motivo di
esclusione già spiegato sopra per `pums_traffico.csv` (il modello lavora su
tratti di strada, non su nodi-intersezione o flussi pedonali).

# pums_traffico_vie.csv — coordinate approssimate delle sezioni

Colonne `id, lon_da, lat_da, lon_a, lat_a` (WGS84), una riga per ognuna delle
21 sezioni di `pums_traffico.csv` (stesso `id`). Non sono un rilievo: sono le
coordinate dei due estremi approssimativi di ogni sezione, ricavate cercando
i nomi delle colonne `strada`/`da`/`a` dentro l'estratto OSM già scaricato
per costruire il grafo di Ascoli
(`backend/data/cache/osm/net_13.5541_42.8382_13.5957_42.8690.json`, la
stessa fonte di `graph.py`) — non da un servizio di geocoding generico, e non
inventate: per ogni sezione del gruppo `cordone`/`pedonale` si è cercata la
via `strada` (o, quando non taggata come via propria — è il caso dei ponti
"Via Ponte Nuovo"/"Ponte di Sant'Antonio", assenti come nome OSM — il punto
di giunzione fra le vie `da` e `a`) e presa una coppia di punti distinti
lungo di essa, non un singolo punto degenere anche quando `da` e `a` OSM
condividono lo stesso nodo (è il caso di 01A/01B e 04B: in quel caso i due
estremi sono stati spostati di circa 35–40 m lungo la via, cosi' la sezione
resta un tratto vero e non un punto).

`traffico.py` userà questi due estremi per agganciarsi ai nodi del grafo più
vicini e prendere il cammino più breve fra loro (stesso principio del
"nearest node" già usato in `router.py`), poi confronterà il nome via
dominante dei tratti trovati con la colonna `strada` come controllo di
coerenza — quindi queste coordinate non devono essere esatte, solo abbastanza
vicine da agganciarsi al tratto giusto e non a uno parallelo.

Le **sei sezioni `periferica`** (21A/21B, 22A/22B, 23A/23B) sono lasciate
**senza coordinate** (colonne vuote): i loro toponimi ("Via Capitano Angelo
Zanettelli", "Casamurana", "SP119", "Frazione Arli", "Via Caprignano", "Fraz.
Monterocco", "Cimitero Comunale Ascoli Piceno") non compaiono nell'estratto
OSM usato per il grafo di Ascoli — coerente con quanto dice `pums_traffico.csv`
README sopra, cioè che sono sezioni extraurbane, fuori dall'area di ~3,4×3,5 km
attorno al centro storico che il progetto prepara oggi. Non è un dato mancante
per errore: quel gruppo serve solo come controllo del fallback tipologico
OSM (vedi sopra), mai per calibrare il canyon urbano, quindi la loro assenza
dal grafo preparato non toglie nulla al calcolo — `traffico.py` deve
saltarle con un log informativo, non un warning, quando le colonne sono vuote.
