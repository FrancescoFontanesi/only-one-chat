# Architecture Decision Records

Un file per ogni decisione: `NNNN-titolo.md`, con Stato, Contesto, Decisione e Conseguenze.
Una decisione superata non si cancella: si marca "Sostituita da NNNN".

| ADR                                               | Titolo                                                               | Stato                                         |
| ------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| [0001](0001-toolchain.md)                         | Toolchain e versioni del bootstrap                                   | Accettata                                     |
| [0002](0002-reuse-policy.md)                      | Riuso dei sorgenti di riferimento: solo reimplementazione            | Accettata                                     |
| [0003](0003-monorepo-layout.md)                   | Layout del monorepo e package interni                                | Accettata                                     |
| [0004](0004-codex-app-server-client.md)           | Client Codex App Server: stdio, niente shell, terminazione garantita | Accettata                                     |
| [0005](0005-subscription-only-auth.md)            | Solo abbonamenti: gate di autenticazione e profilo Codex dedicato    | Sostituita da 0006                            |
| [0006](0006-personal-cli-profiles.md)             | Profili personali dei CLI                                            | Accettata                                     |
| [0007](0007-subagents-visible-not-intercepted.md) | D13: sotto-agenti visibili e vincolati, non intercettati             | Accettata                                     |
| [0008](0008-sandbox-mode.md)                      | Modalità sandbox: scrittura confinata per le prove locali            | Accettata                                     |
| [0009](0009-chatgpt-web-and-three-turn-layer.md)  | Flusso principale: ChatGPT web e strato agentico a tre turni         | Sostituita in parte da 0010                   |
| [0010](0010-leader-chat-adaptive-delegation.md)   | La chat del leader come nucleo: delega adattiva fra subscription     | Accettata, in parte sostituita da 0018        |
| [0011](0011-panels-roles-approvals-continuity.md) | Pannelli, ruoli, approvazioni e continuità dell'implementatore       | Accettata in parte, sostituita da 0012 e 0018 |
| [0012](0012-layout-roles-catalog.md)              | Disposizione della chat, viste laterali, catalogo dei modelli        | Accettata                                     |
| [0013](0013-settings-page.md)                     | Pagina impostazioni e valutazione delle funzioni proposte            | Accettata                                     |
| [0014](0014-checkpoints-and-review.md)            | Checkpoint della cartella e revisione delle modifiche                | Accettata                                     |
| [0015](0015-context-and-mentions.md)              | Indicatore di contesto e file indicati con `@`                       | Accettata                                     |
| [0016](0016-chat-squad-layout.md)                 | La chat, il pannello Squad e le impostazioni dal canvas di design    | Accettata                                     |
| [0017](0017-implementer-handoff.md)               | Handoff dell'implementatore                                          | Accettata                                     |
| [0018](0018-delegation-cycle.md)                  | Ciclo della delega                                                   | Accettata                                     |
| [0019](0019-skills-questions-visible-turn.md)     | Skill, domande del leader e turno visibile                           | Accettata                                     |
| [0020](0020-role-prompts-brief-report.md)         | Prompt di ruolo, brief e rapporto                                    | Accettata                                     |
| [0021](0021-auto-mode-ignored-paths-waiting.md)   | Modalità auto di Claude Code, percorsi ignorati, richieste in attesa | Accettata                                     |
| [0022](0022-providers-per-role.md)                | Qualsiasi provider in qualsiasi ruolo, e le domande di Claude        | Accettata                                     |
| [0023](0023-board-nodes-and-acp.md)               | Nodi sulla lavagna di Squad e Antigravity tramite ACP                | Accettata                                     |
| [0024](0024-markdown-and-latex.md)                | Markdown e LaTeX nei messaggi degli agenti                           | Accettata                                     |
| [0025](0025-cli-paths-detect-pick.md)             | Trovare gli eseguibili dei CLI dalle impostazioni                    | Accettata                                     |
| [0026](0026-mention-and-attach.md)                | `@` nomina un file, + lo allega                                      | Accettata                                     |
| [0027](0027-history-and-blocks.md)                | Lo storico per chat e la ghiera per blocchi                          | Accettata                                     |
| [0028](0028-groups-on-the-dial.md)                | Gruppi e nodi singoli sulla ghiera, SQUAD nel composer               | Accettata                                     |
| [0029](0029-reviewer-findings-and-review.md)      | Il revisore: rilievi e rapporto di revisione                         | Accettata                                     |
| [0030](0030-diff-checks.md)                       | Controlli sul diff fra i fatti verificati                            | Accettata                                     |
| [0031](0031-role-contract-and-brief.md)           | Il contratto fra i ruoli e la struttura del brief                    | Accettata                                     |
| [0032](0032-change-risk.md)                       | La stima del rischio di una modifica                                 | Accettata in parte, sostituita da 0033        |
| [0033](0033-reviewer-always-and-direct.md)        | Il revisore sempre, anche sul lavoro diretto, e dall'interfaccia     | Accettata                                     |
| [0034](0034-remove-experimental-modes.md)         | Via le modalità sperimentali del runtime e la demo                   | Accettata                                     |
