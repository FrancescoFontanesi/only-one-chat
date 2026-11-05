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
