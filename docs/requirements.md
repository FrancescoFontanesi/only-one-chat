# Requisiti di prodotto

Stato: bozza iniziale (bootstrap, 2026-10-18). Nessun requisito è ancora implementato.

## Visione

`agent-workspace` è un'estensione VS Code che coordina più agenti AI attraverso
**un'unica chat condivisa**. L'utente parla con un solo thread. Il leader pianifica e delega,
i worker eseguono, e l'attività di ciascun agente compare come elemento subordinato di
quel thread. L'esperienza d'uso si ispira all'estensione Codex. Il codice è
indipendente e originale (vedi [decisions/0002](decisions/0002-reuse-policy.md)).

### Cosa il prodotto non è

- Non è un router generalista che sceglie un modello per ogni prompt.
- Non è un aggregatore di chat con una chat indipendente per ogni provider.
- Non ha una "Solo Mode" che scavalca l'orchestrazione.
- Non è un fork di usturlab, di Augani Agent Orchestrator o di Codex.

## Core obbligatorio

### R1. Una sola chat di orchestrazione

- Un solo thread di conversazione per sessione di lavoro.
- Le attività di leader, worker e subagent sono annidate sotto il messaggio o il task
  che le ha generate. Si possono espandere o comprimere, ma non sono chat separate.
- L'utente può intervenire nel thread in qualsiasi momento (domande, correzioni, stop).

### R2. Leader configurabile

- Il ruolo di leader è una configurazione, non un provider cablato nel codice.
- Configurazione tipica prevista:
  - leader: Codex (modello indicato dall'utente: "Sol 6.1");
  - collaboratore scientifico e **backup leader**: Claude Opus 5.5.
- Nomi dei modelli e livelli di effort sono dati di configurazione, verificati a runtime
  sul CLI installato.

### R3. Worker e subagent

- **Subagent nativi dei provider** (es. Luna per Codex, Haiku per Claude), lanciati e
  gestiti dal CLI del provider ma resi visibili nel thread.
- **Worker esterni**: Antigravity con Gemini 3.8 High, per task a basso rischio e ad alto
  consumo di contesto o di output.
- Ogni worker ha un profilo dichiarato: capacità, livello di rischio ammesso,
  permessi, workspace (condiviso o worktree isolato).

### R4. Delega e comunicazione bidirezionale

- Delega gerarchica: utente → leader → worker → eventuali subagent.
- Ogni delega è un **task contract** esplicito: obiettivo, scope, file, vincoli, criteri
  di accettazione, comandi di validazione, report finale.
- Un worker bloccato pone una domanda al proprio delegante. Il leader risponde oppure
  la inoltra all'utente. La domanda resta visibile nel thread.
- I risultati tornano al leader come evidenza da rivedere, non come accettazione automatica.

### R5. Task persistenti

- Lo stato dei task (contratto, assegnatario, stato, eventi, domande, risultati) è
  persistito su disco in modo atomico.
- Dopo un crash, un riavvio di VS Code o un cambio di provider, ogni task è ripreso,
  marcato per una revisione manuale oppure annullato, sempre in modo esplicito.

### R6. Esecuzione parallela

- Più worker possono lavorare in parallelo su task indipendenti.
- I task che scrivono sugli stessi file non vengono eseguiti in parallelo sullo stesso
  workspace: si serializzano oppure si usano worktree separati.
- Esistono limiti di concorrenza configurabili per provider e per account.

### R7. Monitoraggio delle sottoscrizioni

- Monitoraggio delle quote 5h e weekly di ciascun abbonamento, ricavato soltanto da
  fonti locali o ufficiali esposte dai CLI.
- Lo stato delle quote è visibile nella UI e viene usato per pianificare e per il failover.

### R8. Failover e ripresa

- Failover automatico del leader quando la quota del leader corrente si esaurisce.
- Il failover è **transazionale**: si salva un checkpoint del task, si trasferisce un
  contesto esplicito al backup leader e si registra l'evento. Il lavoro già fatto non
  viene perso né eseguito una seconda volta in silenzio.
- La ripresa dopo un crash usa lo stesso meccanismo di checkpoint.

### R9. Permessi e approvazioni

- Le approvazioni (comandi, scritture, rete) sono mediate dall'estensione e mostrate
  nel thread con un contesto sufficiente per decidere.
- Gli "allow always" hanno uno scope ristretto ed esplicito, si possono revocare e sono
  visibili.
- Nessuna modalità `dangerously-skip-permissions` (o equivalente) attiva per default.
  Vedi [security.md](security.md).

### R10. Integrazione VS Code

- Pannello Webview con la chat. Diff delle modifiche proposte nell'editor nativo.
- Rispetto del Workspace Trust di VS Code.
- Autenticazione **solo** attraverso i CLI ufficiali e gli abbonamenti già esistenti,
  senza alcun fallback verso API a pagamento.

## Ecosistema opzionale

Nessuno di questi componenti è necessario per installare, compilare, testare o usare
il core. L'orchestratore potrà sfruttarli attraverso MCP e custom instructions.

| Componente           | Ruolo previsto                                                      |
| -------------------- | ------------------------------------------------------------------- |
| Graft                | indice locale del codice, a supporto della navigazione degli agenti |
| Basic Memory         | memoria persistente fra sessioni, via MCP                           |
| MCP server           | strumenti esterni configurati dall'utente                           |
| Skill personalizzate | procedure riutilizzabili definite dall'utente                       |
| Workflow utente      | sequenze di task predefinite                                        |
| MLflow, DVC e simili | tracciamento di esperimenti e dati                                  |

Questi strumenti non vengono sviluppati né incorporati in questo repository.

## Vincoli trasversali

- Nessuna chiamata API a pagamento e nessuna API key gestita dall'estensione.
- Nessuna modifica alle configurazioni globali dei CLI dell'utente (`~/.codex`, `~/.claude`,
  profili Antigravity) senza consenso esplicito.
- Runtime e adapter testabili senza Extension Host.
- Windows è la piattaforma primaria.

## Questioni aperte (da risolvere prima dell'implementazione)

1. Protocollo di controllo di ciascun CLI. Per Codex: app-server JSON-RPC oppure
   `codex exec --json`. Per Claude Code: stream-json via stdio. Per Antigravity
   (`agy`): da verificare.
2. Come leggere le quote 5h e weekly in modo affidabile per ogni provider.
3. Come rendere visibili nel thread i subagent nativi dei provider.
4. Formato e posizione dello stato persistente: storage dell'estensione oppure workspace.
5. Policy di worktree per i worker che scrivono codice.
