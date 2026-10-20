# Istruzioni per gli agenti

Progetto: `agent-workspace`, un'estensione VS Code che coordina più agenti AI in
un'unica chat. Prima di lavorare leggi [docs/requirements.md](docs/requirements.md),
[docs/architecture.md](docs/architecture.md) e [docs/security.md](docs/security.md).

## Regole

1. **Il prodotto è indipendente dai provider.** Nessun provider (Codex, Claude,
   Antigravity) è cablato come coordinatore. Ruoli e modelli sono configurazione.
2. **Non toccare le autenticazioni dell'utente.** Non leggere, copiare o modificare
   `~/.codex`, `~/.claude`, i profili Antigravity, token o API key. Non cambiare la
   config globale di git, npm o dei CLI.
3. **Nessuna API a pagamento** e nessun test live che consumi quote.
4. **Modifiche piccole e verificabili.** Ogni modifica deve passare `pnpm check`. Se tocchi
   l'estensione, anche `pnpm test:e2e`. Riporta l'esito reale dei comandi.
5. **Niente dipendenze senza necessità.** Ogni nuova dipendenza va motivata, con versione
   esatta e nessun build script approvato senza un ADR.
6. **`references/` non è codice del progetto.** Si studia e basta: niente copia, niente
   traduzione riga per riga, niente installazione né esecuzione di quel codice. Vedi
   [docs/decisions/0002-reuse-policy.md](docs/decisions/0002-reuse-policy.md). Il
   progetto deve compilare anche senza quella cartella.
7. **Graft e Basic Memory sono opzionali.** Puoi usarli se presenti, ma mai come
   dipendenze del codice.
8. **Sicurezza prima di tutto.** Mai `dangerously-skip-permissions` o equivalenti attivi
   per default; mai forzare il Workspace Trust; ogni messaggio dalla Webview va validato.
9. **Confini.** `packages/runtime` e `packages/adapters` non importano `vscode`.
10. **Niente implementazioni fittizie.** Se qualcosa non è pronto, lascia un
    `TODO(<area>)` motivato invece di uno stub che simula il comportamento.
11. **Git.** Non fare commit né push senza richiesta. Nei commit e nelle PR non aggiungere
    righe `Co-Authored-By` o altre attribuzioni AI.

## Comandi

```powershell
pnpm install --frozen-lockfile
pnpm check        # build + typecheck + lint + test
pnpm test:e2e     # smoke test nell'Extension Host isolato
pnpm package      # VSIX locale
```

## Mappa

- `apps/vscode/src/`: extension host. `apps/vscode/webview/`: UI (Preact).
- `packages/runtime/`: orchestratore (da implementare). `packages/adapters/`: CLI adapter
  (da implementare).
- `docs/decisions/`: ADR. Una decisione architetturale nuova richiede un nuovo ADR.
