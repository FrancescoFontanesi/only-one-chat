# Only One Chat

Estensione VS Code (`francesco-fontanesi.only-one-chat`) per coordinare più agenti AI di
coding attraverso **un'unica chat condivisa**. Un leader configurabile delega a worker e
subagent, con task persistenti, esecuzione parallela, failover in caso di quote esaurite
e permessi espliciti. Usa i CLI ufficiali e gli abbonamenti esistenti, mai API a pagamento.

> **Stato: bootstrap.** Questa base contiene solo lo scaffold: un comando apre un pannello
> Webview minimo che mostra lo stato dell'estensione. L'orchestratore e gli adapter dei
> provider **non sono ancora implementati**.

## Avvio rapido (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-environment.ps1
pnpm install --frozen-lockfile
pnpm check
```

Poi apri la cartella in VS Code, premi **F5** e lancia **Only One Chat: Open Panel**.

## Documentazione

- [Requisiti](docs/requirements.md)
- [Architettura](docs/architecture.md)
- [Sicurezza](docs/security.md)
- [Sviluppo](docs/development.md)
- [Sorgenti di riferimento](docs/reference-sources.md)
- [Decisioni (ADR)](docs/decisions/README.md)

## Struttura

```text
apps/vscode/        estensione VS Code (host + webview)
packages/runtime/   runtime di orchestrazione (senza vscode)
packages/adapters/  adapter dei CLI ufficiali (senza vscode)
tests/              test architetturali
docs/               requisiti, architettura, sicurezza, ADR
scripts/            check-environment.ps1, fetch-references.ps1
references/         sorgenti di studio (non versionati)
```

## Licenza

[MIT](LICENSE), scelta provvisoria da confermare prima di una distribuzione pubblica.
