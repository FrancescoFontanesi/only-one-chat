# La direzione: prova eseguibile e indipendente

Questo documento raccoglie ciò che è stato discusso e concordato come direzione, ma non ancora
deciso nei dettagli né implementato. Non è un ADR: ogni punto, quando si realizza, ne chiede
uno. Ciò che è già deciso sta nell'[ADR 0018](decisions/0018-delegation-cycle.md),
nell'[ADR 0020](decisions/0020-role-prompts-brief-report.md) e
nell'[ADR 0029](decisions/0029-reviewer-findings-and-review.md).

## Principi già fissati

- **Utente e leader ragionano e approvano insieme; poi si delega.** L'umano dà le idee e guida il
  progetto. Niente sciami di agenti che fanno tutto da soli.
- **Ruoli prima dei worker.** I nodi principali definiscono i ruoli (leader, implementatore,
  revisore); dentro un nodo si usano i sotto-agenti del suo provider, tracciati dal runtime. Le
  letture ampie delegate a modelli economici sono già compito di quei sotto-agenti.
- **Il leader lo sceglie l'utente** e si cambia quando finisce la quota, ripartendo dalla memoria
  di KnowNex.
- **Al leader arrivano riferimenti ai file cambiati, non il diff.**
- **Il revisore è un red team imparziale** su un provider scelto liberamente: buono nel rivedere,
  non troppo costoso, capace di un rapporto dettagliato per il leader. Revisore e implementatore
  si parlano per un numero massimo di giri.
- **Permessi nativi dei CLI,** nessuno strato di permessi in più.

## La tesi

Il coding agentico classico dà risultati scadenti per una ragione precisa: lo stesso modello
produce il codice e la prova che funziona. Un revisore che legge il diff aggiunge un'opinione su
un'altra opinione. Lo standard del sistema è quindi la **prova eseguibile e indipendente**: avere
più provider non serve solo a distribuire la quota, ma a ottenere due derivazioni indipendenti
dello stesso brief.

## I passi, nell'ordine proposto

I primi due sono deterministici, non consumano quota e rendono subito più solidi i fatti
verificati. Lo stato dice cosa c'è già nel codice.

### 1. Fatti contro le scorciatoie

Controlli sul diff che il runtime fa da sé, senza un modello, e aggiunge ai fatti verificati
(`apps/vscode/src/session/facts.ts`):

- **Test indeboliti:** test cancellati, `skip` aggiunti, asserzioni rimosse, snapshot rigenerati.
- **Controlli spenti:** `eslint-disable`, `any`, soglie abbassate, configurazione della CI
  toccata.
- **Fuori perimetro:** file modificati fuori dai Confini del brief, lockfile cambiato, interfaccia
  pubblica diversa da quella concordata.
- **Affermazioni senza riscontro:** il runtime vede già i passi del turno (ADR 0019). Se il
  rapporto dice "ho eseguito i test" e quel comando non c'è fra i passi, lo segnala.

Stato: fatto in parte ([ADR 0030](decisions/0030-diff-checks.md)). Il runtime segnala test tolti
o con meno casi e asserzioni, `skip` e `only` aggiunti, controlli disattivati, lockfile e
configurazione dei controlli cambiati, confrontando la cartella prima del messaggio con adesso.
Mancano i file fuori dai Confini del brief, la superficie pubblica cambiata e il confronto fra le
verifiche dichiarate e i passi del turno.

### 2. La prova rosso-verde su due worktree

È il protocollo con cui SWE-bench giudica una patch, applicato a ogni brief:

- **Sulla base:** i test nuovi devono fallire. Se passano già, non provano la modifica.
- **Sul risultato:** i test nuovi devono passare.
- **I test esistenti:** devono passare prima e dopo.

Con un worktree di git per la base costa un'esecuzione dei test in più. Chiude un buco già visto
nella valutazione dei ruoli: l'affermazione "i test fallivano prima" oggi non si può verificare.

Stato: non fatto. L'implementatore dichiara i test visti fallire (ADR 0029), ma nessuno lo
controlla. I worktree servono anche al punto 6 e agli implementatori in parallelo. Da provare:
come ogni CLI lavora in un worktree e cosa vede dei file non tracciati.

### 3. L'accordo si fa su esempi

Il problema di fondo è che il modello prima interpreta il linguaggio naturale e poi esegue. Non
si risolve con un brief scritto meglio: si risolve se ciò che l'utente approva è eseguibile. Per
ogni criterio, utente e leader concordano i casi "ingresso → risultato atteso" e, dove il
linguaggio lo permette, la firma dell'interfaccia. Dieci esempi si leggono in venti secondi e non
lasciano spazio all'interpretazione.

Stato: fatto nel prompt del leader (ADR 0029). Manca il passo successivo: che gli esempi
approvati diventino test generati dal runtime o dal revisore, e non solo testo del brief. Prima
va misurata la capacità del leader di scrivere brief così, rifacendo `dev/bench`.

### 4. I test li scrive chi non vede l'implementazione

`dev/bench/hidden.ts` ha già i test nascosti, non copiati nella cartella di lavoro: oggi è uno
strumento di misura, va portato nel prodotto. Il revisore lavora in due tempi:

1. **alla cieca:** dal brief e dagli esempi scrive i test di accettazione, senza vedere il
   codice; i test vengono congelati e l'implementatore non li vede;
2. **dopo:** vede il diff e fa il red team.

Se implementazione e test, scritti da due modelli diversi, concordano, la prova è forte. Se
divergono c'è un bug oppure un'ambiguità del brief, e nel secondo caso la questione sale
all'utente. La ricerca recente va in questa direzione (i test scritti dopo aver visto il codice
ne ereditano gli errori; ancorarli alla specifica conta più del loro numero), ma sono preprint e
cataloghi di pattern, non standard consolidati.

Stato: fatta solo la versione che non chiede meccanismi nuovi. Il prompt del revisore gli fa
annotare dal brief cosa osservare prima di aprire le modifiche. I test alla cieca chiedono al
revisore di scrivere file, quindi un posto dove scriverli fuori dalla vista dell'implementatore:
dipende dal punto 2. Costo: circa una seconda derivazione del brief.

### 5. Profondità secondo il rischio

Il processo completo su ogni modifica sarebbe lento. Il brief riceve un livello, calcolato da
fatti: dimensione prevista, file sensibili, interfacce pubbliche toccate.

- **Basso:** implementatore e prova rosso-verde.
- **Medio:** più il revisore.
- **Alto:** più i test alla cieca e la mutazione sul diff.

Stato: non fatto. Oggi il revisore, quando c'è, rivede ogni delega che non si è bloccata.

### 6. La mutazione sul diff

Si alterano le righe cambiate e si verifica che i test se ne accorgano: è la misura di quanto
valgono i test, limitata al diff per costare poco. Meta lo fa in produzione con mutanti generati
da un modello.

Stato: non fatto. Viene per ultimo: serve solo al livello alto, e chiede i worktree.

### 7. Lo storico decide chi occupa un ruolo

Ogni brief lascia numeri oggettivi: verde al primo tentativo, giri di revisione, rilievi trovati
e contestati, quota consumata. Accumulati per modello, ruolo e repository, dicono chi rende
meglio dove: una valutazione continua sul lavoro vero, senza benchmark e senza quota in più.

Stato: il runtime registra l'evento `reviewed` (revisore, implementatore, verdetto, giri) nel log
JSONL di ogni chat. Mancano l'aggregazione e una vista.

### 8. Worktree e brief come stato

Se lo stato di un lavoro è il worktree più il brief più l'ultimo rapporto, i worker di un ruolo
sono intercambiabili a metà lavoro senza memoria: un implementatore che finisce la quota si
sostituisce con un altro che riceve il brief e l'ultimo rapporto. Lo stesso vale per più
implementatori in parallelo scelti dal leader, ciascuno nel suo worktree.

Stato: il rapporto si riscrive già per intero a ogni giro, perché valga l'ultimo (ADR 0029).
Oggi l'implementatore si passa le consegne da sé (ADR 0017); il cambio di provider non c'è.

## KnowNex e il cambio di leader

KnowNex (`F:/KnowNex`, sviluppato in parallelo) è la memoria che permette di cambiare leader e
ripartire: un feed locale di eventi che si può solo estendere, un checkpoint esplicito in cui un
Curator scrive `STATE.md` e le note immutabili, la provenienza di ogni nota verso gli eventi.
Resta opzionale: mai una dipendenza del codice (regola 7 di AGENTS.md).

- **Only One Chat come fonte del feed:** può scrivere eventi tipizzati (brief approvato, esempi,
  esito per criterio, verdetto del revisore), che sono materiale migliore dei messaggi grezzi
  presi dagli hook.
- **Cambio di leader:** `STATE.md` entra nel primo prompt del nuovo leader. Il ciclo ha già
  l'opzione `preface` per questo. La coda degli eventi non ancora curati va passata grezza.
- **Il Curator come nodo sulla lavagna di Squad,** su un provider diverso dal leader: quando il
  leader finisce la quota il checkpoint si può fare lo stesso.
- **Da collegare:** il limite d'uso è già riconosciuto (`usage_limit` nell'adattatore di Claude)
  ma non avvia nulla. Il passo è proporre all'utente il checkpoint e il cambio di leader, non
  farli da soli.

## Limiti dichiarati

- Il codice difficile da testare (interfaccia, CSS) resta fuori dalla prova forte.
- Un brief sbagliato inganna implementatore, revisore e test insieme: per questo gli esempi li
  approva l'utente.
- I numeri dei preprint citati non sono stati verificati sulle fonti primarie.

## Fonti

- [I test scritti dopo il codice (arXiv 2607.05139)](https://arxiv.org/abs/2607.05139)
- [Specification Grounding Drives Test Effectiveness for LLM Code](https://www.alphaxiv.org/abs/2607.06636)
- [Independent Test Generation in Multi-Agent Code Systems](https://agentpatterns.ai/patterns/multi-agent/independent-test-generation-multi-agent/)
- [Code-First Oracle Bias](https://agentpatterns.ai/anti-patterns/code-first-test-oracle-bias/)
- [Mutation-Guided LLM-based Test Generation at Meta (arXiv 2501.12862)](https://arxiv.org/pdf/2501.12862)
