# 0030. Controlli sul diff fra i fatti verificati

Stato: Accettata. Estende l'ADR 0010 (fatti verificati dal runtime). Primo passo della
[roadmap](../roadmap.md).

## Contesto

- **Chi scrive il codice può far passare i controlli cambiando i controlli:** un test tolto o
  saltato, una regola di lint disattivata, un tipo forzato, una soglia abbassata.
- **I fatti dicevano solo quali file sono cambiati** (per hash) e l'esito del comando di
  verifica, se configurato. Il leader doveva fidarsi del rapporto o aprire i file.
- **Il checkpoint di ogni messaggio (ADR 0014) registra già** il contenuto di ogni file prima e
  dopo: i controlli non chiedono altro, né un modello né una dipendenza.

## Decisione

1. **Ai fatti si aggiunge una sezione** "Controlli sul diff, fatti dal runtime (segnalazioni da
   verificare, non prove)", dopo i file cambiati e la verifica. Il confronto è fra la cartella
   prima del messaggio dell'utente e adesso, quindi copre l'intera richiesta, anche i giri del
   revisore. Va al leader, al revisore e al riquadro dei fatti nel thread.
2. **Cosa segnala** (`apps/vscode/src/session/shortcuts.ts`, solo testo, nessun modello):
   - un file di test eliminato;
   - in un file di test già esistente, meno casi di test o meno asserzioni;
   - in un file di test, `skip`, `only` e simili aggiunti;
   - in qualunque file, aggiunti `eslint-disable`, `@ts-ignore`, `@ts-expect-error`,
     `@ts-nocheck`, `# type: ignore`, `# noqa`, `as any`, `: any`;
   - un lockfile cambiato;
   - un file che decide cosa si controlla: configurazione di ESLint, TypeScript, Vitest, Jest,
     pytest, tox, pre-commit, flussi della CI, hook di husky.
3. **Sono segnalazioni, non verdetti.** Un test spostato in un altro file appare come test
   eliminato; un lockfile cambia legittimamente con una dipendenza prevista dal brief. Il leader
   le riporta all'utente se il rapporto non le spiega nelle Decisioni; il revisore parte da lì.
4. **Dove i controlli non si possono fare** lo dicono: senza checkpoint della cartella (troppi
   file, cartella illeggibile) la sezione lo scrive; i file troppo grandi per il checkpoint e i
   binari non si controllano e sono elencati.

## Conseguenze

- **Non costa quota:** una lettura dei file cambiati, già registrati.
- **Il rapporto ha un riscontro** per ciò che dichiara su test e controlli: il confronto non
  dipende dalla fiducia.
- **Non fatto, dalla roadmap:**
  - i file fuori dai Confini del brief e la superficie pubblica cambiata, che chiedono di leggere
    il brief e di sapere cos'è "pubblico" in ogni linguaggio;
  - il confronto fra "ho eseguito i test" nel rapporto e i comandi dei passi del turno, che chiede
    di collegare i passi di ogni turno ai fatti.
- **Falsi allarmi:** le espressioni sono sul testo, non sulla sintassi. `x as any` in un commento
  o in una stringa conta. Va bene finché è una segnalazione; un controllo sul sintassi tree ha un
  costo che non si giustifica ora.
