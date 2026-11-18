# 0034. Via le modalità sperimentali del runtime e la demo

Stato: Accettata. Chiude le modalità che gli ADR 0009 e 0010 tenevano per gli esperimenti.

## Contesto

- **Il runtime aveva sei modalità:** `loop` (default), `question`, `pipeline`, `gateway` (con la
  variante `light`), `leader` e `review`. L'estensione ne usa due, `leader` e `review`.
- **Le altre servivano alle prove** degli ADR 0009 e 0010 (il gateway, lo strato a tre turni)
  e alla demo da terminale (`pnpm demo`). Quelle prove sono concluse; i loro risultati restano in
  `sandbox/results/` e in `docs/role-evaluation.md`.
- **Pesavano sul codice:** prompt, rami e test che nessun percorso dell'estensione raggiunge,
  in un `loop.ts` di oltre 1.800 righe, proprio dove l'ADR successivo cambia il protocollo fra i
  ruoli.

## Decisione

1. **Il runtime tiene solo `leader` e `review`.** Cadono `loop`, `question`, `pipeline`,
   `gateway` e `light`, con i loro prompt e i loro test.
2. **Il brief della web app resta** (`<<<OOC-BRIEF`, ADR 0018 e 0020): il leader lo riconosce e
   lo consegna come prima. Cade solo ciò che usavano le modalità tolte.
3. **Cade `dev/demo.ts`** con lo script `pnpm demo`. Per provare a mano resta `pnpm playground`.
4. **Il bench tiene i sistemi `leader`, `single` e `session`.** Cadono `pipeline` e `gateway`,
   anche dagli scenari.
5. **`loop.ts` si divide per argomento** (i prompt dei ruoli, il ciclo), e gli export che nessuno
   usa fuori dal proprio file tornano privati.

## Conseguenze

- **Le prove con gateway e pipeline non si rifanno più** con il codice attuale; i loro risultati
  restano consultabili, e la storia git conserva il codice.
- **Meno codice da toccare** per il protocollo deterministico fra i ruoli e per la traduzione in
  inglese.
