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
  - `oo.css`: il foglio v4 del canvas, con i token del design system; tolte solo le classi della
    prima Squad a grafo, che nessuna tavola usa;
  - `bundle.css`: le regole del design system usate qui (bottoni, tag, campi, frame, slab,
    spec, meter, accent, cursore), senza l'import da Google Fonts;
  - `fonts.css`: Rajdhani e JetBrains Mono serviti dall'estensione (SIL OFL 1.1), perché la CSP
    della webview non carica nulla dalla rete;
  - `app.css`: ciò che la webview reale aggiunge alle tavole statiche: altezza piena con il solo
    thread che scorre, i controlli a segmenti, il riquadro con i suoi strumenti, il registro degli
    strumenti nei turni, i popover, il movimento, le barre di scorrimento, Squad come livello
    sopra la chat, che scorre e si impila quando il pannello è stretto.
- **Il tema segue quello di VS Code:** Signal se scuro, Print se chiaro.
- **Niente `bundle.js`:** scrive stili inline, che la CSP blocca. Il movimento del design system
  è ricostruito in `webview/motion.tsx` con gli stessi algoritmi e tempi (Decode, Reveal construct
  e ascii, Type, Progress, Flash, Scramble), scrivendo solo nodi di testo, classi, proprietà CSSOM
  e pixel di canvas; fermo con `prefers-reduced-motion`.
- **Niente menu a tendina:** le scelte sono controlli a segmenti (l'opzione scelta è l'inversione
  tenuta, `aria-pressed`), nel riquadro, nei campi del ruolo e nelle impostazioni.
- **Movimento, con il budget del design system:** lo stato nella barra si decodifica a ogni
  cambio; il titolo della chat vuota si scrive (Type); un turno, un rapporto, i fatti e le
  modifiche che arrivano a chat aperta entrano con Construct (non ciò che si carica con la chat);
  un turno in corso ha il tag LIVE, il cursore e lo spinner sull'ultima azione; il riquadro
  mostra IN CORSO a celle; un permesso lampeggia tre volte (Flash); INVIA si rimescola al
  passaggio del puntatore.

### Chat

- **Barra:** cartella e titolo, stato (PRONTO, IN CORSO, ASPETTA TE, NON PRONTO), SIMULAZIONE con
  i CLI finti, STORICO, + NUOVA, IMPOSTAZIONI, SQUAD con il numero di richieste in attesa.
- **Thread a una colonna:** ogni messaggio apre con una riga (chi, modello, stato) che porta le
  sue azioni (COPIA; ↺ RIPRISTINA QUI sui tuoi); i turni con la via, gli strumenti come registro
  da terminale (gli ultimi mentre lavora, tutti con + N AZIONI), i sotto-agenti, il piede con
  contesto, output, tempo e costo nominale; deleghe (D01) e rapporti
  (R01) come righe con il testo apribile; i fatti verificati; le modifiche; gli avvisi (un
  evento informativo è una riga sottile; un errore ha RIPROVA e COPIA DETTAGLI).
- **Dock:** ciò che aspetta l'utente prende il posto del riquadro: un permesso come unica Slab
  della vista (tasti 1, 2, 3; Esc nega), una delega o un rapporto da approvare (modificabile;
  APPROVA, APPROVA ORIGINALE o MODIFICATO, ANNULLA); altrimenti il riquadro.
- **Il riquadro è una cornice sola** con comandi e strumenti dentro: sopra il testo il
  destinatario (LEADER o IMPLEMENTATORE, uno per messaggio), la via e il contesto; sotto, @ FILE,
  / COMANDI, le deleghe e l'invio. Il testo cresce con ciò che si scrive fino a circa un terzo del
  pannello, poi scorre.
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

- **Un pannello sopra la chat**, con il velo a mezzatinta: il flusso Tu → Leader →
  Implementatore, la tabella dei ruoli (modello, permessi, stato, contesto, sotto-agenti), le
  schede Eventi, In attesa, Modifiche, Modelli, il ruolo selezionato con i suoi campi, e
  l'utilizzo con la soglia.
- **Sostituisce le viste laterali** Ruoli, Attività e Utilizzo, che sono tolte.
- **I campi del ruolo scrivono le impostazioni** come faceva la vista Ruoli; il modello del
  leader resta bloccato nella chat, un altro provider vale dalla chat successiva.

### Impostazioni

- **La tavola Impostazioni:** colonna con le sezioni e SALVA PER, barra con la ricerca, APRI IN
  VS CODE e ← CHAT, la Slab dei CLI finti, i ruoli per le prossime chat, poi ogni impostazione
  con la sua origine (PREDEFINITO, [ UTENTE ], [ CARTELLA ]), SOLO UTENTE e RIPRISTINA.

### Del canvas non si implementa, perché il backend non lo fa

- BLOCCA E RISPONDI AL LEADER;
- le deleghe automatiche come righe del thread (il backend non le segnala);
- gli orari dei messaggi;
- l'handoff dell'implementatore (un altro provider vale dalla chat successiva);
- la coda dei messaggi;
- lo stato dei sotto-agenti conclusi nella tabella dei ruoli (l'attività ne segue solo quelli
  attivi).

## Conseguenze

- **Nuovi messaggi fra webview e host,** solo d'interfaccia: `showChat`, `manageTrust`, `copy`,
  e la chat riceve i dati della Squad (`roles`, `monitor`, `usage`, `setRole`, `refreshModels`).
- **L'utilizzo di Codex** si legge all'apertura della chat e ogni due minuti mentre è in vista.
