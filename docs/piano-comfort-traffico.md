# Piano: comfort da traffico/inquinamento, secondo asse accanto all'ombra

Handoff per una chat dedicata. Non implementare nella chat che ha scritto
questo file: è stata usata solo per discutere la strategia e verificare due
cose (limiti reali delle API meteo, struttura del progetto), il contesto è
pesante. Questo documento contiene tutto il necessario per partire senza dover
rifare le ricerche né rileggere la conversazione originale o il PDF del PUMS.

---

## Il problema che risolve

Oggi Ombra ottimizza un solo asse di comfort: quanto sole si prende lungo un
percorso (`web/src/ombra/exposure.ts` + `router.ts`, costo
`tempo × (1 + α × esposizione × carico_solare)`). L'idea discussa con l'autore
è aggiungere un secondo asse — quanto traffico/inquinamento si respira lungo
la strada — usando come input reale i conteggi di traffico di un rilievo
ufficiale del PUMS di Ascoli Piceno (TPS Pro srl, maggio 2025, documento
"AQ2_Conteggi automatici di traffico").

Il problema di fondo: quei conteggi sono **puntuali** (poche sezioni stradali
e intersezioni monitorate per pochi giorni), mentre serve un valore per
**ogni tratto** del grafo stradale che Ombra già usa per il routing. Questo
documento descrive come è stata decisa la spazializzazione, con quali dati e
quali vincoli architetturali.

---

## Vincoli architetturali da rispettare (letti dal codice, non assunti)

Ombra è **una pagina statica**: il calcolo di ombre e percorso avviene nel
browser (`web/src/ombra/`), non su un server. Il Python in `backend/` gira
solo una volta per città, offline, per preparare i file statici che finiscono
in `web/public/dati/` e vengono committati. Non c'è nessun servizio acceso in
mezzo — l'app funziona anche da un telefono in rete mobile, senza backend da
tenere su.

Conseguenze dirette per questo lavoro:

- **Niente chiamate API lato server.** Se serve un dato "live" (il vento di
  adesso), va richiamato **direttamente dal browser** verso un'API pubblica
  che accetta richieste da JS client-side senza chiave né proxy. Open-Meteo
  (vedi sotto) va bene per questo, coerente con l'architettura esistente.
- **La cache dei dati scaricati va gestita come già fa `rete.ts`** (Cache
  Storage, nome della cache che porta la versione del formato — vedi
  "trappole già pagate" in `docs/fase-3-terreno-3d.md`). Qualunque nuova
  chiamata di rete ricorrente va cache-ata allo stesso modo, non richiamata a
  ogni richiesta utente.
- **L'app deve continuare a funzionare offline/senza rete.** Se il fetch del
  vento live fallisce (aereo, rete assente), il comfort da traffico deve
  degradare a un valore di default già incluso nell'export statico, non
  rompere il routing.
- Esiste già un'infrastruttura gemella Python/TypeScript con test di parità
  numerica (`web/test/`, confronta l'implementazione TS contro i valori di
  riferimento prodotti da Python). Qualunque nuova formula va replicata nelle
  due lingue e verificata allo stesso modo.

---

## Cosa esiste già da riusare

- **Geometria degli edifici**: `backend/ombra/surface.py` e
  `web/src/ombra/edifici.ts` leggono già `buildings.geojson` in UTM. Da qui si
  può derivare il rapporto altezza/larghezza del canyon stradale (H/W) per
  ogni tratto, che serve al modello di dispersione (vedi sotto) — non va
  ricostruito da zero, è lo stesso dato usato per le ombre degli edifici.
- **Grafo stradale già segmentato**: `backend/ombra/graph.py` /
  `web/src/ombra/graph.ts` tagliano la rete OSM in tratti da ~25 m, con
  attributi per tratto (lunghezza, pendenza, scomodità del fondo, permessi per
  modalità). Il nuovo indice di esposizione al traffico è **un attributo in
  più su questi stessi tratti**, non un nuovo grafo.
- **Pattern esposizione/costo già pronto**: `exposure.py`/`.ts` produce una
  matrice `[istanti × tratti]` che `router.py`/`.ts` consuma dentro un
  Dijkstra dipendente dal tempo, pesata da un fattore `α` regolabile
  dall'utente. Il nuovo asse può riusare la stessa interfaccia (matrice
  tempo×tratto, peso regolabile) invece di inventarne una diversa.
- **Formato tasselli versionato**: se il nuovo attributo entra nel grafo
  binario esportato, va versionato come già fatto per i tasselli (fase 3:
  header con versione, retrocompatibilità con export vecchi).

---

## Dati traffico: PUMS Ascoli Piceno (sintesi, il PDF originale è di 141 pagine)

Fonte: Comune di Ascoli Piceno, PUMS, "AQ2_Conteggi automatici di traffico",
TPS Pro srl, maggio 2025. Rilievi con Miovision Scout (precisione >95%),
14 ore consecutive (6:00–20:00) nei giorni 19–21 marzo 2025. Se la prossima
sessione deve andare oltre questa sintesi, il PDF va riallegato: non è stato
salvato come file, solo letto.

**21 sezioni stradali monodirezionali** (conteggio veicoli/15min per 7 classi:
bici, moto, autovetture, comm. leggeri, pesanti isolati, autobus, pesanti
combinati):

| ID | Strada | Da | A | Data |
|---|---|---|---|---|
| 01A/01B | Viale Treviri | Largo Porta Romana | Piazza Cecco d'Ascoli | 21/03 |
| 02A/02B | Ponte Romano di Solestá | Via Berardo Tucci | Via Elisabetta Trebbiani | 21/03 |
| 03A/03B | Via Ponte Nuovo | Via Piave | Lungotronto Emidio Bartolomei | 21/03 |
| 04A | Via Porta Tufilla | Ponte di Sant'Antonio | Lungotronto Emidio Bartolomei | 21/03 |
| 04B | Ponte di Sant'Antonio | Via Porta Tufilla | Via del Ponte Vecchio | 21/03 |
| 05A/05B | Ponte Maggiore | Via Genova | Via delle Terme | 21/03 |
| 06B | Via Porta Torricella | Lungocastello Sisto V | Via Adriatico | 21/03 |
| 07A/07B | Ponte Cartaro | Via Mediterraneo | Lungocastello Sisto V | 21/03 |
| 08A/08B | Via della Rimembranza | Via della Fortezza Pia | Via Emidio Pacifici Mazzoni | 21/03 |
| 21A/21B | Via Capitano Angelo Zanettelli | Via dei Trattati | Casamurana | 20/03 |
| 22A/22B | SP119 | SS4 | Frazione Arli | 20/03 |
| 23A/23B | Via Caprignano | Fraz. Monterocco | Cimitero Comunale | 20/03 |

Le sezioni 01–08 sono il "cordone del centro storico" (8 punti bidirezionali);
21–23 sono periferiche/extraurbane. Composizione veicolare tipica: **85–99%
autovetture**, il resto commerciali leggeri (tipicamente 5–10%) e pesanti
(di solito <3%, tranne dove passano linee bus: Via Ponte Nuovo 03B ha 4,9%
autobus, Ponte Maggiore 05A/05B ha fino a 8,6% autobus — sono gli assi con
più traffico pubblico su gomma).

**12 intersezioni con manovre di svolta** (conteggi separati per manovra,
nelle 3 fasce di punta):

9 Viale Treviri–Circonvallazione Ovest · 10 Circonvallazione Ovest–Via
Monterocco–Via Bengasi · 11 Strada Venarottese · 12 Circonvallazione
Nord–Via Sant'Emidio alle Grotte · 13 Circonvallazione Nord–Via Nazario
Sauro · 14 Via delle Zeppelle–Via Po · 15 Viale Costantino Rozzi–
Circonvallazione Nord · 16 Viale della Repubblica–Via Santi Filippo e
Giacomo · 17 Via delle Primule–Via Tevere · 18 Via dei Girasoli–Via delle
Primule · 19 Via Erasmo Mari–Via Napoli · 20 Via Adriatico–rampe SS4.

**3 fasce orarie di punta** (identificate dalla cumulata dei flussi al
cordone del centro storico, valori di picco): mattino **7:45–8:45** (3899
veic.), mezzodì **12:30–13:30** (3349 veic.), pomeriggio **17:00–18:00**
(3663 veic.). Questa curva a tre picchi è il profilo diurno da normalizzare
e riusare per scalare l'esposizione ora per ora (vedi strategia sotto).

**8 sezioni + 3 intersezioni con rilievo pedoni/cicli** (utile se in futuro si
vuole un indice di esposizione anche per chi cammina, non solo per chi guida):
le stesse 8 sezioni del cordone, più le intersezioni 3 (Ponte Nuovo–
Lungotronto Emidio Bartolomei–Via Torquato Tasso), 6 (Lungocastellano Sisto
V–Via Porta Torricella), 8 (Viale della Rimembranza–Str. per Rosara–Via
Emidio Pacifici Mazzoni).

---

## Dati vento/inquinamento: Open-Meteo (non OpenWeatherMap — vedi trappola sotto)

Verificato con ricerca indipendente durante la conversazione, non solo
assunto:

- **Open-Meteo.com**: nessuna API key, nessun account. Limite non commerciale
  **10.000 chiamate/giorno, 5.000/ora, 600/minuto**. Endpoint pubblici,
  richiamabili direttamente da fetch nel browser (CORS ok).
- **Historical Archive API** (`archive-api.open-meteo.com/v1/archive`): dà
  vento orario storico (`wind_speed_10m`, `wind_direction_10m`) per
  **qualsiasi data passata**, quindi anche per i giorni esatti del rilievo
  PUMS (19–21 marzo 2025) — utile per calibrare il modello contro condizioni
  meteo reali di quei giorni, senza bisogno di un piano a pagamento.
- **Air Quality API** (basata su CAMS, Copernicus Atmosphere Monitoring
  Service): storico e forecast di PM10, PM2.5, NO₂, O₃, CO. Può fare da
  **fondo/baseline regionale** su cui sommare l'incremento locale stimato
  dal traffico, invece di partire da zero.
- Coordinate Ascoli Piceno già note e usate in un test precedente:
  **42.8546 N, 13.5753 E**.
- Endpoint esatti/parametri da riverificare in fase di implementazione (i
  nomi dei campi possono cambiare leggermente tra versioni dell'API).

---

## Strategia scelta (decisa in conversazione, motivata)

Discusse cinque strategie di spazializzazione dei conteggi puntuali su tutta
la rete stradale:

1. Buffer/decadimento a distanza (stile mappatura acustica) — economico,
   riusa gli edifici come schermo.
2. **Dispersione fisica da sorgente lineare, stile OSPM (street canyon
   model)** — più realistico; OSPM prende in input un solo vento "sopra i
   tetti" e calcola internamente la ricircolazione nel canyon dal rapporto
   H/W — quindi un vento a griglia larga (Open-Meteo) è l'input corretto
   atteso dal modello, non un'approssimazione fuori standard.
3. Classificazione per tipologia stradale (OSM) — copre anche i tratti mai
   misurati, meno preciso.
4. Land-use regression — richiede più punti di calibrazione di quanti ne
   abbiamo (21).
5. Profilo temporale condiviso — la curva a tre picchi del cordone, riusata
   per scalare qualunque mappa statica ora per ora senza rifare il calcolo
   spaziale per ogni ora.

**Scelta**: combinare 2 (dove i conteggi PUMS calibrano) + 3 (fallback
tipologico sui tratti mai misurati, calibrato sul rapporto osservato per
tipologia nei punti noti) + 5 (profilo diurno condiviso), con eventuale
baseline CAMS come fondo. Non ancora implementata: questa è la parte che
tocca alla nuova sessione.

---

## Design proposto

1. **Dataset ausiliario Ascoli-specifico**: trascrivere le tabelle PUMS (sopra)
   in `backend/ombra/data/ascoli-piceno/pums_traffico.csv` (o simile) — per
   sezione: via, geometria approssimata (da associare ai tratti OSM più
   vicini), conteggi per classe veicolare nelle 3 fasce di punta, indice
   veicoli-equivalenti già calcolato dal PDF (pesa i mezzi pesanti più delle
   auto — è già nella tabella "TOTALE VEICOLI EQUIVALENTI" dei report PUMS).
2. **Nuovo modulo backend** (nome indicativo `backend/ombra/traffico.py`,
   sullo stile di `exposure.py`): in fase di `prepara`/`esporta`, per ogni
   tratto del grafo (25 m) calcola un indice statico di esposizione al
   traffico:
   - se il tratto cade su/vicino a una sezione PUMS nota → usa il conteggio
     reale, pesato per classe veicolare;
   - altrimenti → classificazione OSM (`highway=primary/secondary/
     residential/...`) calibrata sul rapporto medio osservato tra tipologia e
     conteggio nei punti noti;
   - calcola anche il rapporto H/W del canyon dal dato edifici già caricato
     da `surface.py`;
   - applica la dispersione stile OSPM usando un vento "tipico" (climatologia
     stagionale, o il vento storico dei giorni PUMS se si vuole calibrare
     contro quei giorni specifici — sono due usi diversi, non confonderli: il
     primo serve per la mappa statica esportata, il secondo solo per
     validare che il modello sia sensato);
   - salva il risultato come coefficiente statico per tratto **più** i
     coefficienti orari normalizzati della curva a tre picchi (mattino/
     mezzodì/pomeriggio + notte/morbida), così l'ora del giorno scala il
     valore senza dover rifare la dispersione ogni volta.
3. **Export**: aggiungere l'indice come attributo in più nel grafo binario
   (`export.py`/`graph.ts`), versionando il formato se cambia la struttura
   del file (stessa disciplina della fase 3 sui tasselli).
4. **Nuovo modulo web** (nome indicativo `web/src/ombra/traffico.ts`,
   parallelo a `exposure.ts`): legge il coefficiente statico + orario dal
   grafo, e — se online — puo' migliorarlo con un fetch diretto (client-side,
   cache-ato) a Open-Meteo per il vento attuale, ricalcolando solo il termine
   di dispersione (non tutto da zero). Se il fetch fallisce, usa il
   coefficiente statico di default: **il routing non deve mai bloccarsi per
   un'API esterna irraggiungibile**.
5. **Router**: estendere `router.ts`/`.py` con un secondo termine di costo
   (vedi punti aperti sotto per la forma esatta: slider unico o modalità
   separata).
6. **Test**: `web/test/traffico.test.ts` sul modello degli altri test di
   parità Python/TypeScript, più un test che verifica il comportamento di
   fallback quando l'API del vento non risponde.

---

## Punti aperti da decidere nella nuova sessione (non risolti qui)

- **Ascoli-only o generalizzabile?** La calibrazione PUMS esiste solo per
  Ascoli Piceno. Per altre città (`ombra.cli prepara --luogo "Bologna"`)
  esisterebbe solo il fallback tipologico, senza validazione reale. Decidere
  se: (a) offrire il layer traffico ovunque con un disclaimer di minore
  affidabilità fuori Ascoli, o (b) offrirlo solo dove c'è calibrazione reale.
- **Slider unico o due assi separati?** Fondere sole+traffico in un solo
  parametro α (semplice per l'utente, ma nasconde che sono fenomeni diversi
  con dinamiche orarie diverse) vs. due controlli indipendenti nel pannello
  (più espressivo, più complesso da spiegare).
- **Vento bake-in vs live**: il vento "tipico" nell'export statico basta per
  l'ethos offline-friendly dell'app; il fetch live da Open-Meteo è più
  preciso ma è l'unica dipendenza di rete "facoltativa" mai introdotta finora
  in questo progetto — va deciso se vale la complessità, e va progettato bene
  il fallback.
- **Unità dell'indice**: indice composito "veicoli-equivalenti" (già presente
  nei report PUMS, pesa i mezzi pesanti) come proxy relativo, oppure provare
  a scalarlo verso µg/m³ reali usando CAMS come riferimento — la seconda
  opzione è più ambiziosa e più fragile da validare con soli 21 punti.
- **Canalizzazione del vento nella valle del Tronto**: un vento a griglia
  larga (qualunque provider) non cattura effetti locali di valle/collina.
  Da valutare se e come sanity-checkare con dati locali (es. ARPAM Marche)
  prima di dare troppo peso alla direzionalità del modello OSPM in centro
  storico.

---

## Cosa NON rifare (emerso in questa conversazione)

- **OpenWeatherMap ≠ Open-Meteo.** Nomi simili, servizi diversi: il primo
  vuole una API key e ha 1.000 chiamate/giorno gratis, il secondo non vuole
  chiave e ne ha 10.000/giorno. Verificare sempre quale dei due si sta
  citando prima di progettarci sopra.
- **Un vento a griglia larga non è "sbagliato" per OSPM** — è l'input che il
  modello si aspetta (vento "sopra i tetti", non il vento dentro il vicolo).
  Non scartare l'approccio pensando che serva per forza una centralina
  locale: quella servirebbe solo per *validare* il modello, non per farlo
  funzionare.
- **I conteggi PUMS sono un campione di 2-3 giorni di marzo 2025**, non la
  verità assoluta per quei giorni. Quando si generalizza ad altre stagioni/
  giorni, usare la *forma* del profilo diurno (relativa), non i valori
  assoluti.
- **Non richiamare l'API di rete per ogni richiesta utente senza cache**,
  anche se la quota lo permetterebbe: seguire lo stesso pattern già usato in
  `rete.ts` per i tasselli (Cache Storage, nome cache versionato).
