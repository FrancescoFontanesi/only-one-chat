# Scenario calc-session, 27 ottobre 2026: leader che delega o modello da solo

Una sessione di quattro messaggi, uguale per tutti i sistemi
([script.json](../scenarios/calc-session/script.json)):

1. una richiesta libera (`ans`);
2. il brief delle funzioni utente;
3. una domanda sul codice;
4. una piccola correzione al messaggio della ricorsione.

È un run per sistema, quindi indicativo. Tutti i modelli a effort low. I dati grezzi sono nei
file `calc-session-*-2026-10-27T13-*` (`.json` e `.md`).

**Correzione sui costi di Claude.** Con `--resume`, Claude Code riporta uso e costo
cumulativi sulla sessione, e il runner li sommava turno per turno. I valori di Claude qui sotto
sono stati ricalcolati come differenza fra un turno e il precedente; quelli scritti nei `.md`
grezzi di 1O e LO sono gonfiati. L'adapter ora calcola la differenza da solo.

|                       | LS: leader Sol → Sonnet | LO: leader Opus → Sol  | 1S: Sol da solo | 1O: Opus da solo |
| --------------------- | ----------------------- | ---------------------- | --------------- | ---------------- |
| Test nascosti         | **55/55**               | 31/55, flusso fallito  | **55/55**       | **55/55**        |
| Tempo                 | 303 s                   | 99 s                   | 210 s           | 199 s            |
| Codex: Sol            | 348k contesto, 2.7k out | 77k, 0.5k (implementa) | 949k, 7.7k      | —                |
| Codex: Luna           | 154k, 1.3k              | —                      | —               | —                |
| Claude                | Sonnet $0.36            | Opus $0.13             | —               | **Opus $0.67**   |
| Quota 5h Codex/Claude | +5 / +2 punti           | +2 / +1                | **+10** / 0     | 0 / +2           |

## LO ripetuto con i sotto-agenti in primo piano

Ripetuto dopo la correzione: i processi Claude con la policy sui sotto-agenti ricevono
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, e i costi di Claude sono ora per turno. Il run è
`calc-session-LO-2026-10-27T14-07-47-176Z`.

|                       | LS: leader Sol → Sonnet | **LO ripetuto: leader Opus → Sol** | 1S: Sol da solo | 1O: Opus da solo |
| --------------------- | ----------------------- | ---------------------------------- | --------------- | ---------------- |
| Test nascosti         | 55/55                   | 54/55                              | 55/55           | 55/55            |
| Tempo                 | 303 s                   | 511 s                              | 210 s           | 199 s            |
| Codex: Sol            | 348k, 2.7k (leader)     | **984k, 8.5k (implementa)**        | 949k, 7.7k      | —                |
| Claude                | Sonnet $0.36            | Opus $0.35 (leader e Haiku)        | —               | Opus $0.67       |
| Quota 5h Codex/Claude | +5 / +2                 | +10 / +1                           | +10 / 0         | 0 / +2           |

- **Il flusso ora funziona.** Opus aspetta i sotto-agenti e ogni messaggio arriva
  all'implementatore.
- **Il contesto del leader Opus resta piccolo:** 44k, 14k, 16k, 19k, 59k (la domanda, con
  Haiku), 21k e 23k.
- **Ma Sol come implementatore costa quanto Sol da solo.** In tre sessioni nuove legge 984k di
  contesto, contro i 949k di 1S che fa tutto in una sessione. Rilegge il progetto a ogni
  delega ed è lento: 95, 129 e 164 s. A questo si aggiunge Opus. LO distribuisce, ma consuma
  più di 1S e 1O presi singolarmente.
- **Una regressione è sfuggita al leader.** Con `-e`, un'assegnazione non stampa più il valore
  (`assignment-prints`, un test di `calc`). Il leader ha invece segnalato in modo fedele i file
  di graft aggiunti e cancellati senza dichiararlo.
- **La combinazione efficiente qui è LS: leader Sol leggero con Sonnet che implementa.**
  Sonnet, in una sessione nuova, implementa con meno contesto di Sol. È un solo run.

## Il contesto del leader nel tempo (LS, Sol)

| Turno del leader | ans-free 1 | ans-free 2 | brief 1 | brief 2 | domanda | correzione 1 | correzione 2 |
| ---------------- | ---------- | ---------- | ------- | ------- | ------- | ------------ | ------------ |
| Contesto letto   | **338k**   | 25k        | 26k     | 28k     | 28k     | 28k          | 29k          |

Dopo il primo turno il contesto del leader resta fra 25k e 29k per tutta la sessione: cresce di
circa 1k per scambio.

Per confronto, il modello da solo rilegge a ogni messaggio un contesto che cresce con la
sessione:

| Sistema | ans-free | brief | domanda | correzione |
| ------- | -------- | ----- | ------- | ---------- |
| 1S      | 349k     | 364k  | 58k     | 179k       |
| 1O      | 165k     | 212k  | 32k     | 100k       |

## Lettura

- **LS distribuisce e consuma meno di ciascun modello da solo, sulla sua subscription.** Sol usa
  il 37% del contesto di 1S (+5 punti di quota Codex invece di +10). Claude spende $0.36 con
  Sonnet, contro $0.67 di Opus da solo. Il prezzo è il tempo: circa il 50% in più.
- **Il turno caro del leader è stato il primo, la richiesta libera**: 338k di contesto, più Luna.
  Sol ha esplorato il codice prima di delegare, anche con i sotto-agenti. Il resto della
  sessione costa poco. Ecco cosa conviene correggere: anche per una richiesta libera, il leader
  scrive il brief con le sue assunzioni e lascia l'esplorazione all'implementatore.
- **La verifica del leader ha trovato un difetto vero, che nessun test nascosto copre.**
  - Dal solo rapporto, senza leggere il codice, il leader di LS ha visto che `ans` dentro il
    corpo di una funzione definita prima di qualunque risultato viene rifiutato. Verificato a
    mano: `def f() = ans`, poi `3` e `f()` danno `unknown variable 'def'`.
  - 1O ha lo stesso difetto e non l'ha segnalato; 1S e la soluzione di riferimento sono corretti.
- **Qualità**: LS, 1S e 1O superano tutti i 55 test nascosti. Le risposte sono brevi e utili in
  tutti e tre; quelle di 1O sono le più complete.
- **LO non misura il concetto, perché è fallito il flusso.**
  - Al primo messaggio Opus ha lanciato un sotto-agente e ha chiuso il turno con un messaggio
    di avanzamento ("Sto esaminando il codice…").
  - Al secondo, il brief, il turno ripreso è finito vuoto, con costo 0: il brief non è mai
    arrivato all'implementatore.
  - Al quarto messaggio Opus ha delegato un brief che rimandava a lavoro mai fatto, e
    l'implementatore si è fermato correttamente.
  - L'ipotesi è un sotto-agente in background, che in un turno `-p` ripreso non torna. È da
    verificare e correggere prima di ripetere LO.

## Limiti e fattori di disturbo

- **Un run per sistema; un solo script di sessione.**
- **Profilo personale dell'utente.**
  - Codex carica le istruzioni e le skill dell'utente: le risposte di Sol iniziano con
    `[AXIOM]`, e in 1S usa la skill Ponytail, graft e rtk.
  - Il leader Opus in LO ha usato gli agenti personali dell'utente (`haiku-file-reader`,
    `haiku-symbol-finder`).
- **I punti di quota sono interi e rumorosi.** Per confrontare contano i token e il costo
  nominale.
