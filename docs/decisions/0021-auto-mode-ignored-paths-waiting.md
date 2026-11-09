# 0021. Modalità auto di Claude Code, percorsi ignorati, richieste in attesa

Stato: Accettata (iterazione 3). Modifica l'ADR 0011 (livello `auto` per Claude) e l'ADR 0008
per la sola parte dei permessi di Claude.

## Contesto

- **Il livello `auto` chiedeva troppo.** Per Claude valeva la sandbox dell'ADR 0008:
  `Edit(./**)` più i programmi di `onlyOneChat.allowedCommands`. Tutto il resto chiedeva
  all'utente, o veniva rifiutato. In una prova live Sonnet si è visto rifiutare
  `cd … && rtk ls && rtk read …`: rtk è legittimo, ma non era nella lista. Nell'estensione di
  Claude Code, in modalità auto, lo stesso comando passa senza chiedere.
- **I fatti verificati contavano file che nessun agente aveva toccato.** Un hook dell'utente
  (Graft) scrive una cache nella cartella, e il leader la vedeva fra i file cambiati. Non
  sappiamo che cosa avranno installato gli utenti, quindi l'esclusione va configurata da loro.
- **Il livello dei permessi si cambiava solo da Squad,** nell'editor del ruolo, o dalle
  impostazioni.
- **Le richieste in attesa erano tante quante una:** il pulsante Squad mostrava il numero, ma
  il pannello ne apriva solo la prima, e fuori dal pannello niente avvisava.

## Decisione

1. **`auto` è la modalità auto di Claude Code.** Per Claude il livello `auto` avvia il turno
   con `--permission-mode auto`. Restano uguali:
   - gli strumenti: Read, Grep, Glob, Write, Edit, Bash; niente PowerShell, notebook e rete;
   - le regole `Edit(./**)` e `Bash(<programma> *)`, che si applicano prima del classificatore;
   - `--strict-mcp-config`, `--permission-prompts none` e l'hook dei permessi (R9).

   Quello che chiederebbe lo decide il classificatore di Claude Code, come nell'estensione.
   Claude Code spegne da solo la modalità auto dove non è disponibile (piano, modello, fast
   mode, impostazioni): la sessione riporta `default`, il turno prosegue con le regole di prima
   e il thread lo dice una volta per sessione. Qualunque altra modalità riportata ferma il
   turno.

   `bypassPermissions` e `--dangerously-skip-permissions` restano esclusi (AGENTS.md, regola
   8). Il livello `ask` resta in modalità `default` e chiede tutto. Codex non cambia: `auto`
   è `workspace-write` con `on-request`.

2. **Percorsi ignorati.** L'impostazione `onlyOneChat.ignoredPaths` raccoglie pattern scritti
   come in un `.gitignore`: nome a qualsiasi profondità, `/` per ancorare, `/` finale per le
   cartelle, `*`, `?` e `**`; niente negazione `!`. Valgono per i fatti verificati, i
   checkpoint e la scheda delle modifiche. Non si legge il `.gitignore` del progetto: dentro ci
   sono spesso `.env` e file generati, e nasconderli alla revisione toglierebbe un controllo.
   L'impostazione è fra quelle limitate nelle cartelle non attendibili.
3. **Permessi dalla ghiera.** Per l'implementatore la ghiera di sinistra ha un selettore
   Permessi (Legge · Chiede · Auto) accanto all'handoff. Il cambio vale dal turno successivo,
   come da Squad. Il leader resta in sola lettura.
4. **Richieste in attesa.**
   - Permessi, deleghe da inviare e domande aperte sono la lista "In attesa" di Squad.
     Squad si apre su quella lista quando c'è qualcosa.
   - Un permesso si decide da lì (consenti, per la sessione, rifiuta); una delega si invia o
     si annulla. Una domanda, o una delega da modificare, porta al punto della chat.
   - Il pulsante Squad porta in alto a destra un numero, uno per richiesta.
   - All'arrivo di una richiesta nuova, sopra il riquadro della chat compare per 4 secondi
     l'avviso "Azione richiesta · Apri Squad", che apre il pannello.
   - La richiesta resta anche nel riquadro, come prima.

## Conseguenze

- Con `auto` Claude lavora come nella sua estensione: i comandi legittimi che non sono in
  lista passano. Il rischio residuo è quello della modalità auto di Claude Code, cioè un
  classificatore al posto dell'utente. Chi lo vuole evitare sceglie `Chiede`.
- Il classificatore è una chiamata di modello in più per azione dubbia, nel piano
  dell'utente: nessuna API a consumo.
- Senza modalità auto disponibile il comportamento è quello di prima, e il thread lo dice.
- Un pattern troppo largo in `ignoredPaths` nasconde modifiche vere al leader e alla
  revisione. Per questo il valore predefinito è vuoto.
