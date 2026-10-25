# 0005. Solo abbonamenti: gate di autenticazione e profilo Codex dedicato

- Stato: Sostituita da [0006](0006-personal-cli-profiles.md) (2026-10-25)

## Contesto

Il prodotto deve usare esclusivamente gli abbonamenti personali, tramite il login
ufficiale. Una macchina di sviluppo può avere API key nell'ambiente, proxy (es. Headroom)
nel `config.toml` personale, oppure provider personalizzati. Dettagli in
[../codex-auth.md](../codex-auth.md).

## Decisione

1. **Fail-closed**: è autorizzato solo un account `chatgpt` su un provider con
   `requiresOpenaiAuth: true`. Ogni altro caso è un rifiuto o `login_required`, mai un
   fallback.
2. **Il gate sta nel client**: le richieste diverse dalla lettura dell'account non
   vengono inviate finché l'account non è verificato e non stale.
3. **Profilo dedicato tramite `CODEX_HOME`**, e non tramite `--profile` o modifiche al
   `config.toml` personale. Le scelte critiche sono fissate con override `-c`.
4. **Ambiente in allow-list** invece che in deny-list: una variabile nuova che attiva
   una chiave o un proxy resta esclusa senza bisogno di conoscerla.
5. **Le notifiche possono solo declassare**: un'autorizzazione nasce solo da una
   `account/read` completata senza cambi concorrenti.

## Conseguenze

- Il primo uso richiede un login ChatGPT nel profilo dedicato, anche se l'utente ha già
  fatto il login nel profilo personale.
- Proxy aziendali e configurazioni gestite di sistema restano limiti noti.
