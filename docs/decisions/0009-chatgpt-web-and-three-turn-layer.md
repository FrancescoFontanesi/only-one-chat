# 0009. Flusso principale: conversazione in ChatGPT web, strato agentico a tre turni

Stato: Sostituita in parte da [0010](0010-leader-chat-adaptive-delegation.md).

- La web app come flusso principale e lo strato fisso di tre turni sono superati: il nucleo è
  la chat del leader.
- Restano validi il ponte con ChatGPT attraverso gli appunti, la cattura al focus e il
  formato del brief.
- La scelta fra gateway ed esecuzione diretta l'hanno chiarita gli esperimenti citati nel 0010.

## Contesto

- **Come lavora oggi l'utente.**
  - Ragiona con ChatGPT nella web app, che non consuma la quota di Codex.
  - Quando il ragionamento è maturo si fa generare un prompt, lo passa a un agente che
    implementa e riporta i risultati nella chat.
  - Il processo non è lineare: si conversa, si delega, si torna a conversare.
- **Cosa prevedevano R1 e R2.** Un leader dentro l'estensione, Codex, che conversa con
  l'utente. Ogni turno di conversazione consumerebbe quota, e lo stesso contesto
  accumulerebbe ragionamento, lavoro sul codice e scrittura di testi.
- **Il benchmark `calc`** ([confronto](../../sandbox/results/calc-2026-10-26-confronto.md)).
  - Un pianificatore costoso con un esecutore economico supera tutti i test, come Opus da
    solo.
  - Spende circa un terzo in costo nominale di Claude.
  - La pianificazione pesa: 96 s su 162.
- **ChatGPT web non ha un'API negli abbonamenti.**
  - Automatizzarne la pagina (leggere il DOM, simulare clic o tasti, inviare in automatico)
    contrasta con i Termini d'uso di OpenAI, che vietano di estrarre l'output in modo
    programmatico.
  - È fragile: si rompe a ogni cambio della pagina.
  - Tocca la sessione autenticata dell'utente.
  - Simple Browser di VS Code non cambia le cose: incorpora la pagina in un iframe, quindi
    con ogni probabilità chatgpt.com non si carica; e anche se si caricasse, l'estensione
    non potrebbe leggerla.

## Decisione

### Divisione del lavoro

- **Il ragionamento e l'esplorazione restano nella chat di ChatGPT web**, dentro un Progetto
  ChatGPT dedicato al repository.
  - L'estensione genera le istruzioni di progetto e l'utente le incolla una volta.
  - Dicono che la chat è di sviluppo e che il lavoro approvato va ad agenti.
  - Dicono come scrivere il brief: autosufficiente, con le decisioni già prese, senza
    lasciare all'agente ragionamenti già fatti in chat.
- **L'estensione esegue lo strato agentico**, sempre nella stessa forma.
- **ChatGPT non vede il repository.** Il brief descrive quindi l'intento e i criteri di
  accettazione; l'aggancio al codice reale lo fa lo strato agentico.

### Il ponte con ChatGPT passa dagli appunti

- **Il brief** sta in un solo blocco di codice, che si copia con il pulsante Copia di
  ChatGPT. Il blocco inizia con `<<<OOC-BRIEF v1 project=<id> track=<slug>` e finisce con `OOC-BRIEF>>>`. Il formato è in
  [brief-format.md](../brief-format.md).
- **La copia è il consenso dell'utente, il focus sceglie la finestra.**
  - Dopo aver copiato il brief, l'utente porta in primo piano la finestra di VS Code del
    progetto.
  - Quando la finestra riceve il focus (`vscode.window.onDidChangeWindowState`), e solo se
    l'ascolto è attivo, l'estensione legge gli appunti una volta
    (`vscode.env.clipboard.readText()`), riconosce il marcatore e cattura il brief.
  - Gli appunti non vengono mai interrogati a intervalli.
  - Il comando "Cattura dagli appunti" fa la stessa cosa a mano.
- **La risposta** finisce negli appunti come blocco `<<<OOC-RESULT v1`, con una notifica.
  L'utente la incolla in ChatGPT, la modifica se vuole e la invia.
- **Esclusi:**
  - leggere o scrivere la pagina di ChatGPT;
  - simulare clic o tasti;
  - inviare in automatico.

### Più finestre di VS Code

- **Il bersaglio è la finestra che riceve il focus.** Con due progetti, due chat di ChatGPT
  e due finestre di VS Code, il brief va alla finestra su cui l'utente clicca. Non serve un
  lock fra le finestre.
- **L'id di progetto è una protezione.**
  - Ogni workspace ha un `id`, generato dall'estensione e scritto nelle istruzioni del
    Progetto ChatGPT.
  - Se l'id del brief non è quello della finestra, il brief non parte: il pannello lo mostra
    con il comando "Esegui qui comunque".
- **Niente doppie catture.**
  - L'hash dell'ultimo brief catturato è condiviso fra le finestre, nello storage globale
    dell'estensione: riportare in primo piano una finestra non rilancia lo stesso brief.
  - Da verificare se `globalState` si propaga subito fra finestre aperte, o se serve un
    file.
  - Per rilanciare lo stesso brief serve un comando esplicito.

### Modalità di approvazione

- **Manuale**: il brief catturato compare nel pannello, si può modificare e parte dopo
  l'approvazione.
- **Automatica**: parte appena catturato.
- **Rifiuto**: è riservato ai problemi gravi. Produce un messaggio per ChatGPT con le note
  dell'utente, e ChatGPT riscrive il brief.
- **Il pannello mostra il flusso** (ChatGPT → gateway → implementatore → gateway → ChatGPT)
  e chi sta lavorando.

### Lo strato agentico a tre turni

1. **T1, gateway.**
   - **Configurazione.** Codex Sol 6.1 oppure Claude Opus 5.5, scelti per ruolo; effort
     basso o medio; repository in sola lettura.
   - **Cosa fa.** Non riprogetta. Aggancia il brief al codice reale (file, API, comandi di
     test), controlla coerenza e lacune e lo traduce nella specifica.
   - **Esito.** `consegna_spec`, oppure `chiedi_chiarimenti`, che torna a ChatGPT come
     risposta.
   - **Decisioni autonome.** I casi minori li può decidere da solo, ma deve elencarli nel
     campo obbligatorio `decisioni_autonome`.
2. **T2, implementatore.** Un modello economico, con scrittura confinata, esegue la
   specifica e chiude con `consegna_rapporto`.
3. **T3, gateway, nello stesso thread di T1.**
   - **Cosa legge.** Il rapporto e i fatti raccolti dal runtime (file modificati, comandi
     eseguiti con il loro esito, test); se serve, il repository.
   - **Cosa produce.** La risposta per ChatGPT, con `consegna_risposta`, che riporta anche
     le `decisioni_autonome`.
   - **Se la verifica fallisce**, lo riporta e basta: nessun giro di correzione automatico.

**Continuità.**

- Il thread del gateway si riusa fra le deleghe successive dello stesso filone di lavoro.
- L'implementatore apre una sessione nuova per ogni delega: la specifica è autosufficiente.
  Le richieste dirette dal pannello (vedi sotto) riprendono la sessione dell'ultima delega.

### Interazione diretta, domande e sotto-agenti

- **Messaggi diretti dal pannello.** Per una modifica veloce l'utente scrive al gateway o
  all'implementatore, senza passare da ChatGPT.
  - Al gateway il messaggio arriva nel suo thread, che conosce le deleghe precedenti. Il
    gateway risponde, oppure delega all'implementatore con una specifica.
  - All'implementatore il messaggio riprende la sessione dell'ultima delega.
  - Valgono gli stessi permessi e la stessa scrittura confinata delle deleghe.
- **ChatGPT resta allineato.** Quello che si fa fuori dalla chat finisce in un registro.
  La risposta successiva per ChatGPT lo riporta, e lo stesso fa il comando "Riepilogo per
  ChatGPT". Altrimenti la conversazione ragionerebbe su un progetto diverso da quello reale.
- **Domande degli agenti.** Un agente che ha bisogno di una decisione la chiede con uno
  strumento MCP del toolkit, uguale per Codex e Claude.
  - La domanda dell'implementatore va prima al gateway. Il gateway risponde se la risposta
    segue dalla specifica o dalle decisioni già prese; altrimenti la gira all'utente.
  - Nel pannello l'utente risponde direttamente, oppure manda la domanda a ChatGPT come
    blocco `<<<OOC-QUESTION` negli appunti.
  - TODO(toolkit): verificare i timeout degli strumenti MCP mentre la domanda aspetta
    (`tool_timeout_sec` in Codex, l'equivalente in Claude Code).
- **Richieste di permesso dei CLI.** Sono mediate nel pannello, come oggi.
- **Sotto-agenti interni** (Luna per Codex, Haiku per Claude). Restano visibili e vincolati
  come da [ADR 0007](0007-subagents-visible-not-intercepted.md), annidati sotto il turno che
  li ha generati. Vale per ogni ruolo e anche per i messaggi diretti.

TODO(toolkit): da fissare nel prossimo ADR:

- i quattro formati (brief, specifica, rapporto, risposta);
- gli strumenti MCP che li impongono e la condizione per chiudere un turno;
- come si identifica un filone;
- le istruzioni del Progetto ChatGPT;
- le skill dei ruoli.

### Gateway o esecuzione diretta: lo decide l'esperimento E2

**La configurazione diretta** è l'alternativa al gateway: il brief va subito
all'implementatore, e la risposta la compone il runtime dal rapporto e dai fatti.

**L'esperimento E2:**

- **Scenario su codice esistente**, per esempio una funzionalità nuova sulla calcolatrice di
  riferimento. Su una cartella vuota, come in `calc`, l'aggancio al codice di T1 non ha
  niente da agganciare.
- **Brief scritti dall'utente in ChatGPT** con le istruzioni di progetto e salvati nello
  scenario: nessuna quota Codex per la conversazione, nessuna automazione della web app.
- **Sistemi a confronto:** con gateway (Sol, Sonnet, Sol), diretto (Sonnet) ed eventualmente
  diretto con Opus.
- **Indicatori:** gli stessi del benchmark, più la qualità della risposta per ChatGPT, cioè
  se segnala i problemi e le decisioni autonome.

## Conseguenze

- **La conversazione non consuma quota Codex.** La quota si spende solo nei turni T1–T3.
- **I requisiti R1, R2, R4 e R8 si leggono alla luce di questo flusso**
  ([requirements.md](../requirements.md)):
  - la chat di ragionamento è quella di ChatGPT;
  - il pannello di VS Code mostra il flusso;
  - il ruolo configurabile, con il suo failover, è il gateway.
- **Il runtime.** Il modo `pipeline` del runtime è la base di T1–T3. I modi `loop` e
  `question` restano, ma non sono il flusso principale.
- **Sicurezza.** La lettura degli appunti è una superficie nuova: vedi T10 in
  [security.md](../security.md).
- **Ogni ciclo richiede qualche gesto manuale.**
  - Copia in ChatGPT, poi clic sulla finestra di VS Code.
  - Alla fine, incolla e invia in ChatGPT.
  - È voluto: l'utente resta nel loop e decide quale brief parte.
- **Opzioni future:**
  - il connettore MCP ufficiale di ChatGPT, con un proprio ADR, perché richiede un endpoint
    raggiungibile da internet;
  - Gemini come memoria documentale, utile soprattutto a T1.
