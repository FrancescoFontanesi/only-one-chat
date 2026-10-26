# Sandbox

Scenari per provare il sistema su compiti di codice veri e confrontare configurazioni
diverse (un solo modello contro agenti coordinati), misurando funzionamento, token, quota e
tempo. Modalità di permessi: [ADR 0008](../docs/decisions/0008-sandbox-mode.md).

## Struttura

| Percorso                             | Contenuto                                                      |
| ------------------------------------ | -------------------------------------------------------------- |
| `scenarios/<nome>/prompt.md`         | la richiesta dell'utente, uguale per tutti i sistemi           |
| `scenarios/<nome>/systems.json`      | i sistemi a confronto: CLI, modelli, effort, sotto-agenti      |
| `scenarios/<nome>/hidden-tests.json` | test di accettazione nascosti, eseguiti dopo ogni run          |
| `scenarios/<nome>/reference/`        | implementazione di riferimento: prova che i test sono coerenti |
| `results/`                           | un JSON e un riepilogo markdown per ogni run reale, redatti    |

Il runner è `dev/bench.ts`; `tests/sandbox-scenarios.test.ts` controlla che ogni
implementazione di riferimento superi i propri test nascosti.

## Un run

```powershell
$env:CODEX_EXECUTABLE = 'F:\dev-tools\codex\0.164.0\bin\bin\codex.exe'
$env:CLAUDE_EXECUTABLE = 'F:\dev-tools\claude\2.1.308\bin\claude.exe'
pnpm bench --system A          # oppure B; --scenario calc è il predefinito
pnpm bench --system A --fake   # tutto sui fake: nessun turno reale, nessuna quota
```

- **Cartella di lavoro.** Ogni run lavora in una cartella nuova e vuota, fuori dal
  repository: `%LOCALAPPDATA%\only-one-chat\sandbox\<run>`. Gli agenti non vedono quindi
  `AGENTS.md`, `CLAUDE.md`, i test nascosti o la soluzione di riferimento.
- **Approvazioni.** I messaggi fra agenti sono approvati in automatico, ma registrati nel log
  (`%LOCALAPPDATA%\only-one-chat\logs\bench-<run>.jsonl`).
- **Esecuzione di codice.** Claude scrive file e lancia solo i comandi della whitelist
  (`sandboxCommands`), ma il codice che esegue è scritto da un modello. Usa scenari innocui
  (vedi l'ADR).

## Scenario `calc`

Una calcolatrice da riga di comando in Python: lexer, parser con precedenze e potenza
associativa a destra, variabili, funzioni, errori con colonna, modalità `-e` e script da
stdin. I test nascosti sono 30.

| Sistema | Configurazione                                                                                         | Turni |
| ------- | ------------------------------------------------------------------------------------------------------ | ----- |
| A       | Codex Sol 6.1 medium pianifica e giudica; Claude Sonnet 5.5 low esegue; sotto-agenti Luna e Haiku, low | 3     |
| B       | Claude Opus 5.5 medium, un solo turno, senza sotto-agenti                                              | 1     |

## Cosa si misura e limiti

- **Funzionamento**: test nascosti superati e, per A, se il verdetto di Codex li rispecchia.
- **Token** per modello, come li contano i CLI. I tokenizer sono diversi, quindi i numeri dei
  due provider non si sommano fra loro.
- **Costo nominale di Claude**: il prezzo di listino che il CLI riporta, anche con
  l'abbonamento.
- **Quota di Codex**: prima e dopo, in percentuali intere, lette senza consumare quota. È
  rumorosa: la spostano anche gli altri client Codex dell'utente.
- **Quota di Claude**: Claude la riporta solo all'inizio di un turno, quindi il runner
  racchiude il sistema fra due sonde, un turno minimo di Haiku senza strumenti prima e dopo.
  Il costo delle sonde è registrato a parte, mai nei totali del sistema. La differenza
  comprende il piccolo consumo della prima sonda. `--no-claude-quota` le salta.
- **Tempo**: totale e per turno.
- **Profilo personale.** I due CLI caricano `AGENTS.md`, `CLAUDE.md`, gli hook e rtk
  dell'utente: è un fattore di disturbo, registrato e non rimosso.
- **Un run per sistema** è indicativo, non statistico.
