# 0019. Skill, domande del leader e turno visibile

Stato: Accettata (iterazione 3).

## Contesto

- **Le skill dei CLI vanno usate dalla chat.** Codex e Claude hanno le loro skill. L'utente
  vuole invocarle da sé e lasciare che il modello le scelga da solo, come fanno i due CLI.
- **I comandi dei CLI non devono passare dalla chat.** Provato con Claude Code 2.1.318 in `-p`:
  - `/plan` è rifiutato dal CLI;
  - `/clear` resetta davvero la conversazione (`conversation_reset`);
  - lo stesso testo con uno spazio davanti arriva al modello come testo.
- **La plan mode di Codex resta esclusa.** Si attiva solo con `collaborationMode`, che richiede
  `experimentalApi`, vietata dall'ADR 0006.
- **Le domande con scelte servono mentre il modello lavora,** non come testo in fondo a una
  risposta. Provato con Codex 0.164.0 (`gpt-6-luna`, effort low):
  - con `features.default_mode_request_user_input` nella configurazione della sessione,
    l'app-server inoltra `item/tool/requestUserInput` anche in un turno normale, senza API
    sperimentale;
  - la richiesta porta domanda, opzioni e "Altro" (`isOther`);
  - il turno aspetta la risposta e continua.
- **Claude** pone domande solo con il canale stdio dei permessi (`--permission-prompt-tool
stdio`), che cambierebbe come sono collegati i suoi permessi.
- **Le decisioni le prende il leader con l'utente.** L'implementatore riceve un brief che le
  contiene già. Se gliene manca una si ferma e lo scrive nel rapporto (ADR 0018).
- **Il turno oggi è solo domanda e risposta:**
  - i messaggi intermedi di Codex finiscono uniti alla risposta;
  - il ragionamento e il piano del turno si perdono;
  - dei comandi si vede solo l'avvio.

  L'app-server di Codex, su cui è costruita la sua estensione per VS Code, riporta invece:
  - la fase di ogni messaggio (`commentary`, `final_answer`);
  - il riassunto del ragionamento;
  - comando, output, exit code e durata;
  - patch dei file e piano del turno.

## Decisione

1. **Skill.**
   - **`$` nel riquadro** elenca le skill di chi ricevi, lette dal CLI stesso: `skills/list` per
     Codex, l'evento di avvio di Claude. La skill scelta parte nel formato nativo:
     - per Codex, un input `skill` con nome e percorso;
     - per Claude, `/nome` in testa al messaggio.
   - **Il modello sceglie le skill da solo:** Codex lo fa già; a Claude si aggiunge lo strumento
     `Skill`, per entrambi i ruoli.
   - **Il leader resta in sola lettura anche quando usa una skill** (ADR 0018).
2. **Guardia sul `/`.**
   - **`/` nel riquadro resta ai comandi del prodotto.**
   - **Un messaggio che inizia con `/` e non nomina una skill di chi lo riceve** parte con uno
     spazio davanti: arriva come testo, e nessun comando del CLI (`/clear`, `/plan`, `/compact`…)
     parte dalla chat.
3. **Domande del leader a metà turno.**
   - **Solo il leader, solo con Codex.** Sulla sessione del leader si attiva
     `features.default_mode_request_user_input`; l'implementatore non ce l'ha.
   - **La scheda prende il posto del riquadro** mentre il turno aspetta:
     - una domanda con opzioni è a scelta singola, con "Altro" a testo libero quando il modello
       lo prevede;
     - una domanda senza opzioni è a risposta libera;
     - più domande si scorrono a passi.
   - **Invia** passa le risposte al modello nello stesso turno.
   - **Ferma** interrompe il turno, come per i permessi.
   - **Nel thread** resta il riepilogo domanda → risposta.
   - Una domanda segreta (`isSecret`) non si mostra in chiaro né si salva.
   - TODO(questions): domande con Claude come leader, quando servirà, con il canale stdio dei
     permessi e un nuovo ADR.
4. **Il turno visibile.** Un turno è una sequenza di passi, nell'ordine in cui avvengono:
   - messaggi intermedi, distinti dalla risposta finale;
   - ragionamento, compresso:
     - con Codex il riassunto, chiesto con `summary: auto`;
     - con Claude solo la sua presenza, perché il testo non arriva;
   - comandi, con exit code, durata e output espandibile;
   - file modificati, con il diff;
   - piano del turno, con i passi spuntati;
   - domande;
   - in fondo, quanto ha lavorato.

   Il runtime li riceve dagli adapter come passi con un id, e il thread li aggiorna in posto. La
   cronologia tiene ogni output fino a un limite.

## Conseguenze

- **Un comando del CLI non si può dare dalla chat,** nemmeno di proposito: quelli utili passano
  dal prodotto (handoff, nuova chat).
- **Lo strumento `Skill` dà a Claude istruzioni nuove,** ma non strumenti nuovi: quello che una
  skill gli chiede di fare resta soggetto ai permessi del ruolo.
- **Se all'implementatore manca una decisione,** ferma il lavoro e la segnala nel rapporto: il
  leader la chiede all'utente con la scheda e manda un seguito. Lo standard del rapporto lo
  preciserà.
- **L'opzione delle domande in un turno normale è di Codex e non è documentata come stabile:**
  una versione futura potrebbe cambiarla. In quel caso il leader risponde a parole come prima.
