# 0006. Profili personali dei CLI

- Stato: Accettata (2026-10-25)
- Sostituisce: [0005](0005-subscription-only-auth.md)

## Contesto

L'ADR 0005 isolava Codex in un `CODEX_HOME` dedicato, con provider, base URL e metodo di
login fissati da override e un ambiente in allow-list. Così però l'utente doveva rifare il
login nel profilo dedicato e perdeva la propria configurazione: Headroom (proxy locale di
compressione, configurato come provider `headroom` di Codex) e rtk (hook che comprime
l'output dei comandi) smettevano di funzionare. La diagnosi del 2026-10-25
([../diagnosis.md](../diagnosis.md)) mostra che sulla macchina dell'utente Codex usa
proprio un account ChatGPT Plus attraverso Headroom, e Claude un login claude.ai Pro.

## Decisione

1. **Profili personali.** Gli adapter avviano i CLI con il profilo dell'utente (`~/.codex`
   o il `CODEX_HOME` dell'ambiente; il profilo di Claude). Login, credenziali e
   configurazione restano interamente ai CLI: l'estensione non avvia login né logout, non
   apre file di credenziali e legge la configurazione solo con i comandi o i protocolli
   dei CLI. Se l'utente non è loggato, glielo dice: il login si fa nel terminale.
2. **Ambiente dell'utente meno le chiavi API.** Si tolgono solo `OPENAI_API_KEY`,
   `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
   `GEMINI_API_KEY` e `GOOGLE_API_KEY`. Base URL e proxy passano, perché ne dipende la
   configurazione dell'utente.
3. **Policy dell'account Codex**, fail-closed:
   - API key: rifiuto, qualunque sia il provider;
   - ChatGPT con `requiresOpenaiAuth: true`: autorizzato (è il caso di Headroom, che
     inoltra il token ChatGPT);
   - `requiresOpenaiAuth: false` (provider personalizzato): "subscription non
     verificabile", ammesso solo con `allowUnverifiedProvider`; lo stato espone il
     provider letto con `config/read`;
   - errori o risposte malformate: rifiuto.
4. **Metodi mai inviati**, in qualsiasi stato: quelli che spendono crediti o inviano
   comunicazioni (`account/rateLimitResetCredit/consume`,
   `account/sendAddCreditsNudgeEmail`, `feedback/upload`, `plugin/share/save`,
   `plugin/share/updateTargets`), login e logout, e `remoteControl/*`; `initialize` non
   dichiara mai `experimentalApi`.
5. **Profili isolati solo per test e registratore**, con override che li rendono
   riproducibili e senza rete (`dev/isolated-profile.ts`). Mai nei lanci di produzione.

## Conseguenze

- L'utente non rifà il login e la sua configurazione (Headroom, rtk, plugin, skill) resta
  attiva.
- Un proxy che dichiara `requires_openai_auth = true` riceve il token ChatGPT: la
  verifica della subscription si fida della dichiarazione del provider configurato
  dall'utente.
- Le funzioni del profilo dell'utente restano sue: per esempio il remote control di
  Codex non viene disattivato, il client si limita a non pilotarlo.
- I processi lanciati dai CLI leggono la configurazione globale dell'utente (per esempio
  `~/.gitconfig`): non è sotto il nostro controllo.
