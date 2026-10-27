# 0010. La chat del leader come nucleo: delega adattiva fra subscription

Stato: Accettata (iterazione 3). Sostituisce in parte l'[ADR 0009](0009-chatgpt-web-and-three-turn-layer.md):
la web app non è più il flusso principale. Del 0009 restano validi il ponte con ChatGPT
attraverso gli appunti, la cattura al focus e il formato del brief.

## Contesto

- **L'ADR 0009 aveva messo al centro ChatGPT web**, seguito da uno strato fisso di tre turni.
  Il concetto originale del prodotto (R1, R2) è diverso: **una chat sola, con un leader
  scelto dall'utente, che ragiona e delega**. L'utente vuole anche lavorare senza la web app,
  e chiedere modifiche piccole senza un brief strutturato.
- **Le prove**, un run per sistema a effort low, sono in
  [calc-functions](../../sandbox/results/calc-functions-2026-10-27-confronto.md) e
  [calc-session](../../sandbox/results/calc-session-2026-10-27-confronto.md).
  - **Il gateway pieno raddoppia il lavoro.** Esplora il codice, riscrive la specifica e
    rilegge il codice. Su un brief già deciso costa più del modello da solo e non migliora il
    codice.
  - **Il leader leggero costa circa 9 volte meno.** Inoltra il brief con le sole note e giudica
    sui fatti del runner. Con Sonnet come implementatore consuma meno di ciascun modello da
    solo, su entrambe le subscription.
  - **Su una sessione di quattro messaggi il contesto del leader resta stabile**, fra 25k e 29k
    di contesto per turno. Il modello da solo rilegge invece un contesto che cresce. Il leader
    Sol con Sonnet ha usato il 37% del contesto di Sol da solo, più $0.36 di Sonnet contro i
    $0.67 di Opus da solo.
  - **Il turno più caro del leader è stato una richiesta libera**: ha esplorato il codice prima
    di delegare.
  - **Sol come implementatore costa quanto Sol che fa tutto da solo.** Conta più chi implementa
    che chi guida.
  - **La verifica del leader sui soli fatti è utile ma non basta.** Ha trovato un difetto che
    nessun test copriva e ne ha mancato un altro.

## Decisione

1. **Il nucleo è la chat del leader.**
   - Il leader è un modello scelto in configurazione (per esempio Sol, oppure Opus), con una
     sessione che dura tutta la conversazione.
   - ChatGPT web è una fonte opzionale di brief, attraverso il ponte dell'ADR 0009.
2. **Il leader è l'interlocutore con cui si ragiona**, come la web app, ma è anche un agente
   capace di scrivere. L'implementatore è un modello esterno, su un'altra subscription, e il
   leader lo sa: non è un suo sotto-agente. Per ogni richiesta il leader sceglie la via e la
   dichiara nella prima riga della risposta ("Via: rispondo | chiedo | faccio io | delego —
   perché"):
   - **rispondo**: domande e ragionamento; per leggere il codice usa i sotto-agenti, che gli
     restituiscono una sintesi;
   - **chiedo**: manca una decisione che cambia il risultato;
   - **faccio io**: modifiche piccole e concentrate (uno o due file, poche decine di righe,
     comportamento deciso). Le scrive lui, perché un brief costerebbe più della modifica. I
     sotto-agenti non scrivono mai;
   - **delego**: modifiche più grandi, oppure quando l'utente lo chiede ("genera il prompt",
     "delega"). Il leader organizza il lavoro, spiega all'utente cosa delega e perché, e scrive
     il brief. Non esplora il codice a fondo per prepararlo: lo fa l'implementatore;
   - **brief dalla web app**, riconosciuto dal suo marcatore: non lo rigenera. Il runtime lo
     inoltra così com'è, e il leader aggiunge solo note, cioè aggiunte o correzioni mirate che
     valgono sul testo del brief.
   - **Dopo una delega**, e solo allora, il leader riceve il rapporto strutturato
     dell'implementatore con i fatti del runner, e riferisce all'utente: se è andato tutto bene,
     cosa non torna, cosa converrebbe modificare. Così il rapporto entra nella conversazione, e
     l'utente può ragionarci con il leader: le correzioni piccole le fa il leader, per quelle
     grandi parte una nuova delega.
   - **Reasoning.** Il livello di reasoning di ogni ruolo lo sceglie l'utente; l'estensione non
     lo forza. La guida d'uso consiglia i livelli per i vari casi.
3. **Il contesto del leader è la risorsa da proteggere.**
   - Gli tornano solo il rapporto dell'implementatore e i fatti del runner (file cambiati, test
     rieseguiti, test falliti per nome).
   - Mai trascrizioni o file interi.
   - Giudica sui fatti; apre un file solo se un fatto contraddice il rapporto.
4. **Il brief è il contratto unico.** Lo scrive ChatGPT oppure il leader, e il formato è lo
   stesso ([brief-format.md](../brief-format.md)).
5. **L'implementatore predefinito è il modello più economico che basta.** Nelle prove è Sonnet
   a low, in una sessione nuova per ogni delega. I ruoli restano configurazione (regola 1).
6. **Integrazione con i CLI**, verificata in queste prove:
   - **Claude.** I sotto-agenti girano in primo piano
     (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, solo sul processo figlio), altrimenti in un
     turno ripreso il risultato si perde. Uso e costo, cumulativi con `--resume`, si riportano
     per differenza fra un turno e il precedente.
   - **Codex.** Le prove girano senza gli hook del profilo dell'utente
     (`features.hooks = false`, solo per il thread), perché graft scrive nella cartella di
     lavoro.

## Conseguenze

- **R1 e R2 tornano centrali.** La sezione "Flusso principale" di
  [requirements.md](../requirements.md) rimanda a questo ADR.
- **Il runtime** ha il modo `leader`, con la sessione del leader conservata fra le richieste. I
  modi `gateway` (pieno e leggero) restano per gli esperimenti.
- **Nella sandbox anche il leader scrive** (ADR 0008), per le modifiche piccole.
- **Aperto:**
  - quanto bene il leader sceglie fra fare da sé e delegare, da misurare su richieste piccole;
  - una verifica breve e indipendente sul diff, fatta da un modello dell'altra subscription;
  - il failover del leader quando la sua quota finisce (R8);
  - l'interfaccia, che è il prossimo passo.
