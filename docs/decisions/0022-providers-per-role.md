# 0022. Qualsiasi provider in qualsiasi ruolo, e le domande di Claude

Stato: Accettata (iterazione 3). Precisa l'ADR 0011 (permessi per ruolo) e l'ADR 0019 (domande
del leader).

## Contesto

- **I ruoli erano già configurabili per provider** (impostazioni e Squad), ma il backend no:
  - la chat sceglieva fra Codex e Claude in un unico `if`;
  - le domande erano solo di un leader Codex;
  - il ponte dei permessi era solo dei ruoli Claude che scrivono.
- **Claude leader con Codex implementatore partiva già,** ma senza domande.
- **In futuro arriveranno altri provider** (altri CLI, modelli locali). La chat e Squad non
  devono sapere quale provider ha un ruolo. Devono sapere di che cosa ha bisogno il ruolo.
- **Claude Code ha uno strumento per chiedere all'utente,** `AskUserQuestion`. Verificato su
  2.1.322:
  - con `-p` e `--permission-prompts none` lo strumento non c'è, anche se è in `--tools`;
  - non c'è nemmeno con `--permission-prompts host`;
  - c'è con `--permission-prompt-tool stdio`, cioè l'host dell'Agent SDK. La chiamata arriva
    sullo stream come richiesta di controllo `can_use_tool`, e l'host la approva con le
    risposte nell'input (`answers`).
  - Un hook `PermissionRequest` non basta, perché lo strumento non viene offerto.

## Decisione

1. **Una tabella dei provider** (`apps/vscode/src/session/providers.ts`). La chat descrive il
   ruolo (scelta di CLI, modello, reasoning e permesso; leader sì o no) e il provider lo
   traduce nel proprio harness. Ogni provider dichiara:
   - come crea le sessioni;
   - se chiede tramite il ponte dell'estensione (Claude) o con il proprio protocollo (Codex);
   - i nomi vietati ai sotto-agenti.

   La chat non contiene più rami per provider. Un provider nuovo è una voce della tabella più
   il suo adapter.

2. **Ogni leader ha le domande**, Codex con `requestUserInput`, Claude con `AskUserQuestion`.
3. **Il turno del leader Claude fa da host dell'SDK per le sole domande.**
   - Il turno parte con `AskUserQuestion` in `--tools` e con `--permission-prompt-tool stdio`,
     che prende il posto di `--permission-prompts none`.
   - La richiesta `can_use_tool` di `AskUserQuestion` va a `onQuestion` del turno, quindi
     passa dal runtime come quelle di Codex: è registrata nel log ed è fermata con il turno.
   - Le risposte tornano nell'input, per testo della domanda, con più scelte separate da
     virgole. Senza risposta la chiamata viene negata.
   - Ogni altra richiesta che chiederebbe viene negata subito con "Negato dal ruolo": il ruolo
     è in sola lettura, non è l'utente ad aver rifiutato. È lo stesso effetto di
     `--permission-prompts none`, con un messaggio esatto.
   - Il leader non ha ponte né hook. Gli strumenti di scrittura restano fuori da `--tools`.
4. **L'implementatore Claude non cambia:** niente domande (ADR 0019), permessi tramite l'hook
   (R9) e modalità auto (ADR 0021).

## Conseguenze

- Claude leader con Codex implementatore funziona come la coppia opposta: delega, rapporto,
  revisione e domande.
- La chat non sa più quale provider ha un ruolo. Restano per provider: gli eseguibili e i
  sotto-agenti in `ChatConfig`, la lettura dei modelli e dell'utilizzo, le etichette della UI.
- Usiamo una parte del protocollo di controllo dell'SDK (`can_use_tool`) senza l'SDK. Una
  versione di Claude Code che la cambiasse romperebbe le domande, non i permessi.
