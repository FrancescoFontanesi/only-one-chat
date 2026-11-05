# 0016. La chat, il pannello Squad e le impostazioni dal canvas di design

Stato: Accettata (iterazione 3). Sostituisce le viste laterali dell'ADR 0012.

## Contesto

- **L'utente ha disegnato l'interfaccia** nel canvas "Only One Chat — riorganizzazione UI"
  (claude.ai), con il design system Cyber Nihilism: tre tavole, Chat, Squad e Impostazioni; le
  altre sono marcate da eliminare.
- **Dove il canvas e il backend divergono, vale il backend attuale** (indicazione dell'utente):
  si disegna solo ciò che il backend fa.

## Decisione

### Stile

- **Il CSS del canvas e del design system è copiato in `media/cn/`:**
  - `oo.css`: il foglio v4 del canvas, con i token del design system; tolte le classi della
    prima Squad a grafo, che nessuna tavola usa, e quelle della Squad e delle impostazioni del
    canvas, ricomposte sulle reference del design system;
  - `bundle.css`: le regole del design system usate qui (bottoni, tag, campi, frame, slab,
    spec, meter, accent, cursore, Lattice), senza l'import da Google Fonts; senza i segni agli
    angoli, che il design system ha tolto (ogni box è un rettangolo semplice);
  - `fonts.css`: Rajdhani e JetBrains Mono serviti dall'estensione (SIL OFL 1.1), perché la CSP
    della webview non carica nulla dalla rete;
  - `app.css`: ciò che la webview reale aggiunge alle tavole statiche: altezza piena con il solo
    thread che scorre, il riquadro con i suoi strumenti, il registro degli
    strumenti nei turni, i popover, il movimento, le barre di scorrimento, le opzioni a parole e
    il misuratore a livelli, Squad e Impostazioni, che si impilano quando il pannello è stretto.
- **Il tema segue quello di VS Code:** Signal se scuro, Print se chiaro.
- **Niente `bundle.js`:** scrive stili inline, che la CSP blocca. Il movimento del design system
  è ricostruito in `webview/motion.tsx` con gli stessi algoritmi e tempi (Decode, Reveal construct
  e ascii, Type, Progress, Counter, Flash, Scramble), scrivendo solo nodi di testo, classi, proprietà CSSOM
  e pixel di canvas; fermo con `prefers-reduced-motion`.
- **Niente menu a tendina:** in Squad e nelle impostazioni le opzioni sono parole, come il
  bottone di testo del design system: la scelta in inchiostro fra parentesi, le altre attenuate,
  il puntatore inverte (`Opts`, `role="radio"`). Reasoning e permessi sono un misuratore a
  livelli (`Scale`): celle piene fino al livello scelto; sotto il puntatore i livelli che si
  aggiungerebbero sono a mezzatinta 1-bit, quelli che si toglierebbero vuoti, e il nome si
  decodifica accanto. Nella chat, dove il testo esposto pesa, una scelta mostra solo ciò che è
  scelto (`Pick`): una chiave, una tacca per opzione (piena quella scelta) e il nome; sotto il
  puntatore la tacca va a mezzatinta e il nome si decodifica in quello dell'opzione guardata, che
  si descrive accanto; un clic su una tacca la sceglie, sul nome passa alla successiva, le
  frecce scorrono; la scelta nuova lampeggia una volta, invertita.
- **La Lattice** (struttura alternativa del design system: una griglia di celle con le linee
  calcolate dalla geometria reale delle celle, i bordi in comune come una linea) è disegnata da
  `webview/lattice.tsx` in un SVG sopra le celle, perché `bundle.js` usa stili inline; geometria
  pura in `latticeGeometry.ts`, con test. Come nel design system le linee sono spezzate per
  default: perimetro aperto (si tengono i lati chiesti, come la linea in comune fra due Lattice
  impilate), ogni linea lascia liberi 6 px su ciascun lato del pixel di un incrocio, dove sta
  un + di 7 px centrato (3 px liberi fra il + e ogni linea, sui due assi, anche negli angoli),
  salvo gli incroci fitti (meno di 64 px sulla stessa linea) e i bordi delle celle invertite. Il
  calcolo è in pixel interi. Il + è un tono sopra le linee che taglia (`--ink-disabled` su
  `--line`; nel riquadro con il fuoco `--ink-muted` su `--line-strong`), non in inchiostro come
  nel design system: richiesta dell'utente. Le linee
  continue con i nodi sul perimetro restano un'opzione.
- **Prestazioni.** Le linee della Lattice si ridisegnano solo quando la geometria può essere
  cambiata (la radice o una sua cella cambia dimensione, celle che arrivano o se ne vanno) e
  non se le misure sono le stesse: prima si ridisegnavano a ogni render e a ogni testo cambiato
  in una cella, con un layout forzato a ogni chunk di una risposta e a ogni scatto di un
  progresso. La lavagna di Squad misura i blocchi solo quando cambiano posto o dimensione; il
  thread scorre in fondo al più una volta per fotogramma; la corona e i segni fissi delle ghiere
  si calcolano una volta. Niente `memo` di Preact sugli elementi del thread e sulle ghiere: con
  Preact 10.29 i figli di un componente che salta il render tengono il genitore del render
  precedente, e ogni render ne tratteneva uno (misurato: +20 MB in 60 s con Squad aperto).
- **Movimento, con il budget del design system, dove si interagisce;** le impostazioni sono
  ferme. Niente testo che compare una volta sola all'apertura: un testo si decodifica quando
  cambia, non quando appare. Lo stato nella barra si decodifica a ogni cambio; un bottone si
  rimescola al passaggio del puntatore (un solo ascoltatore per la vista); un messaggio sotto il
  puntatore disegna a passi una tacca sulla sua linea, inverte l'autore e fa entrare le sue
  azioni; le scelte del riquadro reagiscono come sopra; le linee del riquadro si scuriscono mentre si
  scrive. Ciò che arriva a chat aperta (un messaggio inviato, un turno, un rapporto, i
  fatti, le modifiche) entra con Construct, come risposta a ciò che l'utente ha fatto; ciò che si
  carica con la chat è già lì. Un turno in corso ha il tag LIVE, il cursore e lo spinner
  sull'ultima azione; il riquadro mostra IN CORSO a celle; un permesso lampeggia tre volte
  (Flash). In Squad, aperto dall'utente, i frame entrano con Reveal e i modelli si decodificano.
  Le maschere leggono i colori una volta sola, non a ogni cella e passo.

### Chat

- **Barra:** cartella, titolo e stato nel percorso (PRONTO, IN CORSO, ASPETTA TE, NON PRONTO),
  SIMULAZIONE con i CLI finti, STORICO, + NUOVA, IMPOSTAZIONI, SQUAD con il numero di richieste
  in attesa.
- **Thread a una colonna,** più larga del riquadro: lo supera del 15% della sua colonna su
  ciascun lato, mai oltre le ghiere; senza ghiere la colonna del riquadro è il 70% del pannello;
  sotto i 640 px entrambi a tutta larghezza.
- **I messaggi:** ogni messaggio apre con una riga (chi, modello, stato) che porta le
  sue azioni (COPIA; ↺ RIPRISTINA QUI sui tuoi); i turni con la via, gli strumenti come registro
  da terminale (gli ultimi mentre lavora, tutti con + N AZIONI), i sotto-agenti, il piede con
  contesto, output, tempo e costo nominale; deleghe (D01) e rapporti
  (R01) come righe con il testo apribile; i fatti verificati; le modifiche; gli avvisi (un
  evento informativo è una riga sottile; un errore ha RIPROVA e COPIA DETTAGLI).
- **Dock:** ciò che aspetta l'utente prende il posto del riquadro: un permesso come unica Slab
  della vista (tasti 1, 2, 3; Esc nega), una delega o un rapporto da approvare (modificabile;
  APPROVA, APPROVA ORIGINALE o MODIFICATO, ANNULLA); altrimenti il riquadro.
- **Il riquadro è una cella Lattice** chiusa sui quattro lati, con un + a ogni angolo (le linee
  si scuriscono mentre si scrive, sono tenui se la chat non è pronta): il testo e, sotto una
  linea rientrata, una riga con il destinatario (A: LEADER o IMPLEMENTATORE, uno per messaggio),
  la via (solo il nome; le tacche si aprono sopra sotto il puntatore o il fuoco) e le deleghe
  come `Pick`, il contesto della sessione a cui si scrive e l'invio. Niente bottoni @ FILE e /
  COMANDI: `@` e `/` si scrivono nel testo. Il testo cresce con ciò che si scrive fino a circa un
  terzo del pannello, poi scorre.
- **Accanto al riquadro, due ghiere** (la tavola v5 del canvas "Pannelli laterali — Ruoli e
  Utilizzo" come riferimento, adattata al backend; `Hud.tsx`, geometria in `hudGeometry.ts` con
  test), solo da 1000 px: 216 × 192 ciascuna, a 24 px dal riquadro, che è alto come loro; un
  connettore tratteggiato e una freccia le agganciano al centro del suo bordo. Ogni ghiera è
  parte di un grande cerchio con il centro fuori dalla vista, rivolto al riquadro: una scala con
  un segno per voce che gira fino a quella scelta (clic sull'etichetta, trascinamento o rotella
  sulla scala, frecce) e una corona ferma. Tutti i comandi sono in vista, niente si apre sotto il
  puntatore e niente gira in loop: la scala gira, un arco si riempie e un nome si decodifica
  solo quando ciò che mostrano cambia.
  - A sinistra, **R/ Parli con**: il destinatario del messaggio, scelto sulla sua etichetta
    (LDR, IMP) o sull'anello più esterno (clic, rotella); la scala gira fino a lui. Il mirino
    regola il reasoning: i suoi archi sono i livelli del modello, dal basso verso l'alto
    (trascinamento o clic su un segmento, rotella, frecce); la lettura sta sopra il divisore di
    mezzo (RSN, livello, posizione), sotto il nome e il provider con lo stato. Sotto il divisore:
    il modello, poi per il leader la via su un rullo (la scelta al centro, la precedente e la
    successiva attenuate sopra e sotto; la rotella lo fa scorrere, un clic su una vicina la
    sceglie, frecce; al cambio scorre di una riga a scatti; il suo modello resta quello della
    chat), per l'implementatore il modello (↕ passa
    al successivo, nella stessa sessione) e HANDOFF (ADR 0017). Destinatario e via escono così
    dal piede del riquadro, dove restano solo quando le ghiere non si vedono.
  - A destra, **U/ Utilizzo**: il provider di chi riceve il messaggio (si può girare sull'altro),
    la finestra di 5 ore come arco pieno e numero, la settimanale come arco tratteggiato e in
    celle, il rinnovo, se è il provider di chi riceve il messaggio.
- **Perché la chat non può partire** (nessuna cartella, cartella non attendibile) sta in cima al
  thread, sopra la chat nuova, non più sopra il riquadro.
- **`@` è solo per i file**, mai per i ruoli: due ruoli nello stesso messaggio non sono previsti.
  `@impl` non è più un comando: il destinatario arriva all'host come campo del messaggio e la
  chat lo registra nel messaggio (`to`); le chat salvate prima, con `@impl` in testa, si leggono
  come allora.
- **`/` all'inizio del testo** elenca i comandi: le vie, il destinatario, allega, nuova chat (o
  ferma), Squad, impostazioni. Un comando scelto cambia i controlli e sparisce dal testo; uno
  scritto per intero resta un prefisso che l'host legge come prima.
- **Allegati:** `@` apre l'elenco dei file; il file scelto diventa un'etichetta sopra il testo.
  All'invio le etichette diventano un'ultima riga di menzioni `@percorso`, che l'host legge come
  prima (ADR 0015); il thread mostra le etichette, non quella riga.

### Squad

- **Un pannello sopra la chat**, con il velo a mezzatinta, composto come una sola Lattice senza
  spazi vuoti (linee in comune, un + a ogni incrocio, anche sul perimetro chiuso): la barra; la
  testa della lavagna (legenda e zoom) e la lavagna; le schede Eventi, In attesa, Modifiche e la
  loro lista; a destra la testa e i campi del ruolo selezionato, poi ciò che aspetta te (cella
  invertita, l'unico accento, che lampeggia quando arriva; piana quando non c'è niente); il
  piede. Gli agenti sulla lavagna sono pannelli a vertici a croce (`Crossed`: modello, come è
  impostato, contesto, che cosa fa, sotto-agenti, token; la testa seleziona il ruolo; il
  selezionato ha le croci in inchiostro). La scheda Modelli e la fascia degli eventi che
  scorrono sono tolte; il pannello dell'utilizzo (contesto dei ruoli, finestre dei provider) è
  tolto per ora: l'host continua a mandare i dati (`TODO(squad)` in `App.tsx`).
- **Sostituisce le viste laterali** Ruoli, Attività e Utilizzo, che sono tolte.
- **I campi del ruolo scrivono le impostazioni** come faceva la vista Ruoli; il modello del
  leader resta bloccato nella chat, un altro provider vale dalla chat successiva.

### Impostazioni

- **Le slide stampate a Lattice del design system** (RefLatticeSlidesPrint): una pila di
  Lattice sulle stesse quattordici colonne (un margine di 48 px, dodici, un margine), linee
  spezzate con un + agli incroci, celle fitte. La copertina: il marchio, le sezioni distribuite
  e l'uscita (VS CODE ↗, CHAT); il titolo fra parentesi, centrato, con quante sezioni e dove si
  salva; la ricerca e SALVA PER (UTENTE · CARTELLA); la riga dei CLI finti, invertita. Poi un
  foglio per sezione: una riga di testata (indice e titolo; ONLY/ONE · IMPOSTAZIONI e la pagina,
  02 / 04), i margini, la colonna di testa (titolo, a che cosa serve, quante voci) con un solo
  numerale gigante che esce dal fondo; ogni voce è una riga di testata (numero, nome; da dove
  viene il valore, RIPRISTINA) sopra due celle (che cosa è; il valore). I ruoli sono due voci,
  A e B, con il modello e i campi. In fondo una riga con dove si salva e la pagina. Nessun
  movimento: niente Reveal né Decode. Sotto i 900 px ogni cella va a tutta larghezza, in ordine.

### Del canvas non si implementa, perché il backend non lo fa

- BLOCCA E RISPONDI AL LEADER;
- le deleghe automatiche come righe del thread (il backend non le segnala);
- gli orari dei messaggi;
- la coda dei messaggi;
- lo stato dei sotto-agenti conclusi nella tabella dei ruoli (l'attività ne segue solo quelli
  attivi).

## Conseguenze

- **Nuovi messaggi fra webview e host,** solo d'interfaccia: `showChat`, `manageTrust`, `copy`,
  e la chat riceve i dati della Squad (`roles`, `monitor`, `usage`, `setRole`, `refreshModels`).
- **L'utilizzo di Codex** si legge all'apertura della chat e ogni due minuti mentre è in vista.
