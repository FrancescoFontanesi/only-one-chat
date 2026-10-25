# Architecture Decision Records

Un file per ogni decisione: `NNNN-titolo.md`, con Stato, Contesto, Decisione e Conseguenze.
Una decisione superata non si cancella: si marca "Sostituita da NNNN".

| ADR                                     | Titolo                                                               | Stato              |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| [0001](0001-toolchain.md)               | Toolchain e versioni del bootstrap                                   | Accettata          |
| [0002](0002-reuse-policy.md)            | Riuso dei sorgenti di riferimento: solo reimplementazione            | Accettata          |
| [0003](0003-monorepo-layout.md)         | Layout del monorepo e package interni                                | Accettata          |
| [0004](0004-codex-app-server-client.md) | Client Codex App Server: stdio, niente shell, terminazione garantita | Accettata          |
| [0005](0005-subscription-only-auth.md)  | Solo abbonamenti: gate di autenticazione e profilo Codex dedicato    | Sostituita da 0006 |
| [0006](0006-personal-cli-profiles.md)   | Profili personali dei CLI                                            | Accettata          |
