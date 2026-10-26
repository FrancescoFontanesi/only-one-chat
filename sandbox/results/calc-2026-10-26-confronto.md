# Scenario calc, 26 ottobre 2026: A contro B

Un run per sistema, quindi indicativo e non statistico. Dati grezzi:
`calc-A-2026-10-26T17-15-49-496Z` e `calc-B-2026-10-26T17-19-14-013Z` (`.json` e `.md`).

|                            | A: Codex Sol 6.1 medium + Claude Sonnet 5.5 low | B: Claude Opus 5.5 medium                            |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Test nascosti              | **30/30**                                       | **30/30**                                            |
| Verdetto del pianificatore | `SUCCESS` (corretto)                            | —                                                    |
| Tempo totale               | 162 s (Sol 96 s, Sonnet 59 s, verdetto 5 s)     | **145 s**                                            |
| Codice prodotto            | 477 righe, 19 test propri                       | 658 righe, 25 test propri                            |
| Costo nominale Claude      | **$0.19** (Sonnet e uso interno di Haiku)       | $0.56                                                |
| Quota Claude 5h            | 50% → 53% (circa 3 punti per Sonnet)            | da 53%; il consumo dell'ultimo turno non è riportato |
| Quota Codex 5h             | 63% → 65% (2 punti, piano Plus)                 | non usato                                            |

## Token per modello

I tokenizer sono diversi, quindi i numeri di Codex e di Claude non si sommano.

| Modello                       | Input  | Cache letta | Cache scritta | Output | di cui ragionamento |
| ----------------------------- | ------ | ----------- | ------------- | ------ | ------------------- |
| A: gpt-6.1-sol (2 turni)      | 20 385 | 63 488      | 0             | 3 587  | 396                 |
| A: claude-sonnet-5-5          | 4      | 16 282      | 25 039        | 8 495  | 1 651               |
| A: claude-haiku-5-5 (interno) | 5 781  | 0           | 0             | 26     | 0                   |
| B: claude-opus-5-5            | 14     | 92 874      | 27 098        | 16 301 | 2 447               |
| B: claude-haiku-5-5 (interno) | 2 148  | 0           | 0             | 25     | 0                   |

## Lettura

- **Qualità**: pari. Entrambi superano tutti i test nascosti. B scrive più codice e più test.
- **Consumo di Claude**: A spende circa **un terzo** di B in costo nominale ($0.19 contro $0.56).
  Sonnet produce metà dell'output di Opus e legge dalla cache un sesto dei token, perché lavora
  su una specifica già decisa e itera meno.
- **Consumo distribuito**: A sposta il ragionamento su Codex, al prezzo di circa 2 punti della
  finestra di 5 ore del piano Plus.
- **Tempo**: A è più lento di circa il 12%. Lo domina la pianificazione di Sol (96 s su 162 s).

## Limiti e fattori di disturbo

- **Un solo run per sistema.**
- **Consumo dell'ultimo turno di Claude**: non è misurabile, perché la quota si legge solo
  all'inizio di ogni turno. Per B non c'è quindi il consumo in punti di quota.
- **Quota di Codex rumorosa**: è salita da 66% a 68% durante B, che non usa Codex. Altri
  client Codex dell'utente (estensione VS Code, app desktop) o un ritardo di aggiornamento
  spostano il dato, quindi i 2 punti di A sono approssimativi.
- **Profilo personale caricato**: Codex ha letto una skill dei plugin dell'utente (`ponytail`)
  e `RTK.md`. Un hook di avvio sessione di Codex (graft) ha scritto `graft/.cache` nella
  cartella del run, fuori dalla sandbox di Codex. In entrambi i sistemi Claude Code usa Haiku
  internamente. Nessun sotto-agente è nato.
- **Permessi**: in B la modalità `acceptEdits` ha eseguito `ls` e `rm` (sul proprio
  `parser.py`, dentro la cartella del run), che non sono nella whitelist: vedi la correzione
  proposta all'ADR 0008.
