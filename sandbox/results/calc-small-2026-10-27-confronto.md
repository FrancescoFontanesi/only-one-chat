# Scenario calc-small, 27 ottobre 2026: chi fa la modifica piccola

Un run per variante, quindi indicativo. Tutti i modelli sono a effort low: leader Sol 6.1,
implementatore Claude Sonnet 5.5, sotto-agenti Luna e Haiku. Gli hook dell'utente sono spenti
per thread.

Ogni run ha due richieste:

1. Il leader delega a Claude le funzioni `floor` e `ceil`, uguale in tutte le varianti.
2. Si chiede `round(x)`, piccola e collegata alla prima.

I dati grezzi sono nei file `calc-small-V*-2026-10-27T*` (`.json` e `.md`).

## La seconda richiesta (round)

| Variante | Chi la esegue                                                    | Codex: Sol                     | Claude: Sonnet | Costo Claude | Tempo | Test nascosti |
| -------- | ---------------------------------------------------------------- | ------------------------------ | -------------- | ------------ | ----- | ------------- |
| V1       | il leader, da sé                                                 | **180k** contesto, 1.0k output | —              | $0           | 31 s  | 42/42         |
| V2       | Claude, dopo un messaggio mirato del leader, sessione nuova      | 48k, 0.4k                      | 53k, 1.5k      | $0.046       | 31 s  | 42/42         |
| V3       | Claude, dopo un messaggio mirato del leader, **stessa sessione** | 49k, 0.4k                      | **36k**, 1.1k  | **$0.021**   | 28 s  | 42/42         |
| V4       | Claude, messaggio diretto, sessione nuova                        | —                              | 55k, 1.4k      | $0.051       | 19 s  | 42/42         |
| V5       | Claude, messaggio diretto, **stessa sessione**                   | —                              | **35k**, 1.1k  | **$0.021**   | 20 s  | 42/42         |

La prima richiesta costa circa lo stesso in tutte le varianti: Sol 46k di contesto; Sonnet fra
56k e 88k e fra $0.06 e $0.09.

## Lettura

- **Fare da sé è la via più cara, se il leader è Sol.**
  - In V1 Sol ha letto 180k di contesto per una modifica di una riga. Ogni chiamata di
    strumento rimanda all'agente tutta la sessione del leader, conversazione compresa.
  - Delegare la stessa modifica costa al leader 48k, cioè due turni brevi (delega e lettura
    del rapporto), più il lavoro dell'implementatore.
  - Con una conversazione più lunga il divario cresce, perché cresce la sessione che il leader
    rimanda a ogni chiamata.
- **La stessa sessione dimezza il costo di un seguito.** Con la sessione ripresa, Sonnet ha
  letto un terzo in meno di contesto e il costo è sceso del 55% ($0.021 contro $0.046 e $0.051):
  conosceva già i file e i test, e lo legge dalla cache.
- **Il messaggio diretto all'implementatore è la via più economica e più rapida** quando sai
  già cosa chiedere. V5 costa $0.021, zero Codex, 20 s. Il leader però non sa cosa è successo,
  a meno che il runtime non gli passi una riga di stato.
- **Qualità**: tutte le varianti superano i 42 test nascosti. Il leader ha delegato quando
  gli è stato chiesto e ha fatto da sé quando gli è stato chiesto.

## Limiti

- **Un run per variante, una sola modifica piccola**, e una conversazione breve: il leader
  aveva circa 23k di contesto.
- **Il profilo dell'utente si vede ancora in Codex:** il prefisso `[AXIOM]` e la skill
  Ponytail, che arrivano dalle istruzioni e dalle skill, non dagli hook.
