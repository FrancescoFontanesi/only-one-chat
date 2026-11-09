# 0020. Prompt di ruolo, brief e rapporto

Stato: Accettata (iterazione 3). Precisa l'ADR 0018 (formati del brief e del rapporto).

## Contesto

- **I prompt di ruolo erano sommari** e il formato del rapporto era troppo semplice.
- **Il formato non va inventato:** va preso dallo stato dell'arte e adattato.
- **Il brief del leader non deve chiedere un rapporto:** il formato del rapporto appartiene al
  ruolo dell'implementatore.
- **Le fonti consultate:**
  - **Anthropic, sistema di ricerca multi-agente.** Ogni delega di un orchestratore porta un
    obiettivo, un formato di output, le indicazioni su strumenti e fonti e i confini del compito.
    Una delega vaga produce lavoro duplicato o buchi. L'impegno va commisurato al compito, con
    euristiche più che regole rigide. Chi esegue restituisce un risultato condensato e
    riferimenti ai propri prodotti.
  - **Anthropic, best practice di prompting.** Istruzioni chiare, con il perché; sezioni separate;
    un ruolo esplicito. Testi di esempio contro la sovra-ingegnerizzazione, contro le soluzioni
    costruite sui test e contro le affermazioni su codice non letto; azioni reversibili sì,
    distruttive no.
  - **OpenAI, guida ai prompt per Codex** (febbraio 2026). Prompt di sistema a sezioni (autonomia
    e persistenza, esplorazione, implementazione, presentazione del lavoro); agire con ipotesi
    ragionevoli e finire nello stesso turno. Il resoconto apre con cosa è cambiato, poi dove e
    perché, riporta l'output dei comandi e dice come verificare ciò che non è stato verificato.
  - **OpenAI, guida GPT-5.5.** Prompt centrati sul risultato: obiettivo, criteri di successo,
    vincoli, contesto, regole di arresto. SEMPRE e MAI solo per i veri invarianti; il prompt più
    corto che funziona.

## Decisione

1. **Due prompt di ruolo, del prodotto, uguali per Codex e Claude**: `leaderInstructions` e
   `IMPLEMENTER_ROLE_INSTRUCTIONS` nel runtime.
   - **Il testo sta in due file Markdown,** `packages/runtime/prompts/leader.md` e
     `implementer.md`, da leggere e modificare così come li leggono i modelli: la build li
     include come testo, `{{implementer}}` e `{{ask}}` li riempie il runtime, le regole sui
     sotto-agenti le aggiunge in coda. Prettier non li tocca.
   - **Si aggiungono al prompt di sistema del CLI e alle istruzioni del repository**
     (AGENTS.md, CLAUDE.md), che il CLI carica da sé: per Codex come `developerInstructions`, per
     Claude come `--append-system-prompt`.
   - **Dopo il prompt di ruolo vengono le istruzioni dell'utente per quel ruolo**, dalle
     impostazioni (ADR 0013).
   - **Restano in italiano;** passarli all'inglese è una traduzione.
   - **I prompt della modalità gateway e dei benchmark (ADR 0009) non cambiano,** perché i
     confronti restino paragonabili.
2. **Il brief** (nel blocco `<<<DELEGA #id`) è centrato sul risultato, con sezioni fisse,
   omettendo quelle che non servono:
   1. Obiettivo, col perché;
   2. Contesto, con i file come `@percorso`;
   3. Vincoli, solo gli invarianti;
   4. Criteri di accettazione, numerati e verificabili, con i comandi di verifica;
   5. Confini;
   6. Fermati se.

   Altre regole:
   - per un seguito bastano Obiettivo e Criteri;
   - dei passi solo quando l'ordine conta;
   - il brief non chiede un rapporto.

3. **Il brief dalla web app** ha le stesse sezioni e i suoi marcatori,
   `<<<OOC-BRIEF v1 project=<id> track=<slug>` … `OOC-BRIEF>>>`. Il leader lo riceve con i
   marcatori, non preceduto da una frase.
4. **Il rapporto** fa parte del ruolo dell'implementatore, tra `<<<RAPPORTO` e `RAPPORTO>>>`:
   1. Esito (`completato`, `parziale` o `bloccato`);
   2. Modifiche;
   3. Verifica, per criterio;
   4. Decisioni;
   5. Bloccato su, cioè la decisione che manca, come domanda per il leader;
   6. Fuori ambito.

   Una sezione vuota dice "nessuno".
   - **Con un brief il rapporto c'è sempre.**
   - **Con un messaggio diretto** c'è se l'implementatore ha toccato più di un file o eseguito
     verifiche; altrimenti basta una riga.
   - **Il thread lo mostra come una scheda** con l'esito; le sezioni che dicono "nessuno" non si
     mostrano.

5. **La valutazione del leader** segue i passi del suo prompt:
   1. legge l'esito;
   2. confronta ogni criterio con i fatti;
   3. porta all'utente ciò che blocca;
   4. riferisce.

   Il messaggio del turno di valutazione passa solo il rapporto e i fatti.

6. **I sotto-agenti dell'implementatore** si possono usare anche senza richiesta, per le letture
   ampie, mai per modificare file. Modello, effort e numero restano imposti dal runtime (D13).
7. **Le scelte minori del leader** si dichiarano sempre: nessuna decisione resta all'insaputa
   dell'utente.

## Conseguenze

- **Un brief e un rapporto hanno sempre la stessa forma,** quindi il leader trova l'esito e ciò
  che blocca sempre nello stesso posto.
- **Il formato del rapporto vive in un solo posto,** il ruolo dell'implementatore: un brief che lo
  ripetesse non serve più.
- **Le istruzioni del progetto ChatGPT vanno scritte nello stesso formato del brief,** con i
  marcatori. TODO(web-brief): testo delle istruzioni del progetto.
