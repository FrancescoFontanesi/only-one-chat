# Adapter Claude Code CLI

Stato: iterazione 1. Un turno headless alla volta, in sola lettura, nel profilo personale
dell'utente ([ADR 0006](decisions/0006-personal-cli-profiles.md)).

Codice: `packages/adapters/src/claude/` (`turn.ts`, `executable.ts`), con
`src/environment.ts` e `src/process-tree.ts` condivisi con Codex. Test:
`test/claude-turn.test.ts`, con il fake `test/fixtures/fake-claude.mjs` che riproduce
l'output registrato da Claude Code 2.1.308 (`test/fixtures/claude/2.1.308/turn-ok.jsonl`,
redatto e controllato da `test/fixtures-leaks.test.ts`).

## Eseguibile

`resolveClaudeExecutable({ configuredPath?, env? })` applica le regole di Codex
(`src/executable.ts`): percorso assoluto configurato oppure `claude.exe` (Windows) o
`claude` (POSIX) nel `PATH`; rifiuta `.cmd`, `.bat` e `.ps1`; non cerca i binari inclusi
nell'estensione VS Code o nell'app desktop. Il lancio avviene senza shell.

Binario usato per le verifiche: Claude Code 2.1.308 (canale `stable`), da
`https://downloads.claude.ai/claude-code-releases/2.1.308/win32-x64/claude.exe`, sha256
`c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53` conforme al
`manifest.json` della release, firma Authenticode valida di "Anthropic, PBC". Non è stato
eseguito `claude install`.

## Flag (verificati con `claude --help` 2.1.308)

| Flag                                        | Scopo                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| `-p`                                        | headless (non interattivo)                                    |
| `--input-format stream-json`                | prompt come messaggio JSON su stdin, niente quoting sull'argv |
| `--output-format stream-json` + `--verbose` | eventi JSONL in streaming (`--verbose` è richiesto)           |
| `--tools Read,Grep,Glob`                    | solo strumenti di lettura e ricerca                           |
| `--disallowedTools Bash,PowerShell,Edit,…`  | rinforzo: shell, scrittura, modifica e rete negate            |
| `--strict-mcp-config`                       | nessun server MCP (vedi sotto)                                |
| `--permission-prompts none`                 | ciò che chiederebbe un permesso viene negato                  |
| `--permission-mode default`                 | esplicito: il `defaultMode` dei settings non si applica       |
| `--model <alias>`, `--effort <level>`       | da configurazione (iterazione 1: `haiku`, `low`)              |
| `--append-system-prompt <testo>`            | istruzioni di ruolo passate dal runtime                       |
| `--resume <session id>`                     | continua una sessione precedente                              |

Testo di `--help` per `--permission-prompts`: _"Who answers permission prompts with
--print: "host" (the SDK host or --permission-prompt-tool) or "none" (nobody: anything
that would prompt is denied automatically; the permission mode still decides everything
else)"_. Quindi `none` significa **rifiuta senza chiedere**; per questo la modalità è
passata esplicita. `default` non compare fra le scelte elencate da `--help` (`acceptEdits`,
`auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`) ma è accettato (un valore
inventato viene rifiutato) e `init` lo riporta come `permissionMode: "default"`: se
riporta altro, il turno viene fermato con `permission_mode`.

Mai `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
`--permission-mode bypassPermissions` o `acceptEdits`. Non si usa `--restricted` né
`--bare`, che ignorerebbero i settings e gli hook dell'utente (per esempio rtk).

`--tools ""` da solo non basta: nel turno di diagnosi restavano attivi gli strumenti MCP
dei connettori claude.ai, fra cui "Claude Docs" con `create`, `update` e `delete`, che
scrivono su un servizio esterno.

## Eventi

| Evento (`type`/`subtype`) | Campi usati                                                                  | Diventa            |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `system` / `init`         | `session_id`, `model`, `apiKeySource`, `permissionMode`, `tools`             | `init` + controlli |
| `rate_limit_event`        | `rate_limit_info` (`five_hour`, `seven_day`, `overageStatus`)                | `rate_limit`       |
| `assistant`               | blocchi `text` e `tool_use` di `message.content`                             | `text`, `tool_use` |
| `result`                  | `result`, `is_error`, `api_error_status`, `session_id`, `permission_denials` | esito del turno    |
| altri                     | —                                                                            | `other`            |

Lo streaming è per messaggio: ogni messaggio dell'assistente arriva quando è completo.
`--include-partial-messages` darebbe i delta di testo, ma non è stato registrato dal CLI
reale e quindi non è usato.

L'evento `init` arriva **solo dopo** il primo messaggio su stdin (verificato: senza
prompt nessun evento in 12 s). Per questo il controllo della fatturazione avviene anche
prima del turno.

## Controllo della fatturazione

1. Prima del turno, `claude auth status --json` (nessuna quota). Si prosegue solo con
   `loggedIn: true`, `apiProvider: "firstParty"` e `authMethod: "claude.ai"`; altrimenti
   `ClaudeError` `not_logged_in`, `unsupported_provider` (Bedrock, Vertex, …, fatturati a
   parte) o `api_key`, e il prompt non viene mai inviato. Il login si fa nel terminale
   (`claude auth login`).
2. Un `ANTHROPIC_BASE_URL` nell'ambiente (proxy o base URL personalizzato) rende la
   subscription non verificabile: rifiuto `provider_not_verified`, salvo
   `allowUnverifiedProvider`; l'esito riporta allora `billing: "unverified_provider"`.
3. All'evento `init`, `apiKeySource` deve essere `"none"`: altrimenti l'albero di
   processi viene terminato subito e il turno rifiutato con `api_key`.

## Limite di utilizzo (429)

Con il limite della subscription esaurito, Claude risponde senza inferenza (modello
`<synthetic>`, costo 0): `rate_limit_event` con `status: "rejected"` e un `result` con
`is_error: true`, `api_error_status: 429`, `api_error: "usage_limit_reached"` e il testo
del CLI (per esempio "You've hit your session limit · resets 1:50pm"). L'agente lo
trasforma in `ClaudeError` `usage_limit`, con un messaggio chiaro e **nessun nuovo
tentativo**; il ciclo si ferma con `failed`. Fixture reale e redatta:
`turn-usage-limit.jsonl`.

## Sotto-agenti

Con una policy del runtime l'adapter aggiunge lo strumento `Agent` (in `init` compare come
`Task`) e `--forward-subagent-text`, e impone modello, effort e profondità con l'ambiente del
processo figlio. Lo stream reale (`turn-subagent.jsonl`) ha il `tool_use` `Agent`, i
messaggi del sotto-agente con `parent_tool_use_id`, `agent_id` e `subagent_type`, gli eventi
`system` `task_started`, `task_progress`, `task_updated` e `task_notification`, e il
`tool_result` finale. Dettagli e verifica: [subagents.md](subagents.md).

## Etichetta

Ogni risposta porta l'identità osservata dall'adapter, non quella che il modello dichiara:
`Claude Code`, il `model` di `init` (per esempio `claude-haiku-5-5`), l'effort passato e
l'id di sessione. Il runtime ne scrive l'etichetta.

## Ambiente, cwd, sessione, terminazione

- Ambiente dell'utente meno le sole chiavi API (`src/environment.ts`); base URL e proxy
  passano.
- `cwd` = workspace. L'id di sessione viene da `init` (e da `result`).
- `stop()` termina l'intero albero (`taskkill /T /F` su Windows, process group su POSIX:
  Claude parte `detached` solo su POSIX) e rifiuta il turno con `stopped`; è idempotente.
- Dopo `result` si chiude stdin; `done` si risolve solo quando il processo è uscito, e
  dopo `shutdownTimeoutMs` (default 5 s) l'albero viene terminato.

## Limiti noti

- Un base URL impostato nell'`env` dei settings di Claude, e non nell'ambiente, non è
  visibile: `init` non lo riporta e i file di configurazione non vengono aperti.
  `apiKeySource` e `auth status` restano i controlli effettivi.
- `total_cost_usd` del `result` è una stima nominale anche con la subscription.
- Il controllo `init` arriva dopo l'invio del primo prompt: protegge i turni successivi
  e interrompe quello in corso, mentre il controllo preventivo è `auth status`.
- Le sessioni vengono salvate nel profilo dell'utente (nessun
  `--no-session-persistence`), così `--resume` funziona.
- `claude doctor` segnala l'auto-update attivo: un binario configurato a mano potrebbe
  aggiornarsi da solo.
