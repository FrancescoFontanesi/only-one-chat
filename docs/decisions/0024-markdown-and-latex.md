# 0024. Markdown e LaTeX nei messaggi degli agenti

Stato: Accettata (iterazione 3). Precisa la minaccia T6 di [security.md](../security.md) e i
riferimenti dell'ADR 0018.

## Contesto

- **Il testo degli agenti era reso come testo semplice:** titoli, grassetto, elenchi, tabelle e
  blocchi di codice restavano marcatori visibili, e le formule restavano sorgente LaTeX.
- **Il markdown dei modelli non è fidato** (T6). La webview ha una CSP stretta: niente script
  inline, niente stili inline, niente rete.
- **Gli agenti citano i file in modi diversi:** `[README.md](file:///C:/…/README.md)`,
  `[app.py](app.py)`, `` `src/masks.py` ``, `` `a.py:12` ``. Prima era cliccabile solo `@percorso`.

## Decisione

1. **Markdown con un renderer nostro, senza dipendenze** (`webview/markdownModel.ts`,
   `webview/markdown.tsx`).
   - Produce solo elementi Preact, mai HTML: l'HTML che un modello scrive resta testo visibile,
     quindi non c'è nulla da sanificare.
   - Copre il sottoinsieme che i CLI scrivono: titoli, paragrafi, elenchi anche annidati e misti,
     citazioni, blocchi di codice, tabelle, separatori; codice inline, grassetto, corsivo, link.
   - Regge il testo ancora in arrivo, per esempio un blocco di codice non ancora chiuso.
   - Il testo è Regular (400) e il grassetto Bold (700): in Rajdhani 500 e 700 quasi non si
     distinguono.
2. **Riferimenti ai file.**
   - L'host riconosce, oltre a `@percorso`, i destinatari dei link markdown e il codice inline che
     ha la forma di un percorso, con `#L10-20` o `:12`.
   - Sono cliccabili solo quelli che esistono nella cartella aperta, anche se scritti come
     percorso assoluto.
   - `openFile` accetta percorsi assoluti solo dentro la cartella, e la verifica resta nell'host.
   - Ogni altro link mostra il testo, con l'indirizzo come title: la webview non apre indirizzi.
   - **Aspetto:** come in Copilot Chat e Claude Code, il file è un chip. Ha carattere
     monospazio, bordo, le righe attenuate dopo il nome e il segno ↗, e si inverte al passaggio
     del mouse; il percorso completo è nel title. Il codice inline ha invece un fondo pieno e
     nessun bordo, così non si confonde con un file.
   - **Riapertura:** i riferimenti si ricalcolano quando una chat viene riaperta.
3. **LaTeX con KaTeX 0.19.1** (MIT), con uscita MathML.
   - Riconosciuto in `$…$`, `\(…\)`, `$$…$$` e `\[…\]`. Un `$` apre solo se seguito da un carattere
     non spazio e chiude solo se preceduto da uno, senza una cifra dopo (la regola di pandoc), così
     "$5 e $10" resta testo; `\$` resta un dollaro.
   - MathML è disegnato dal browser: niente CSS né font di KaTeX da caricare, niente stili inline.
   - Il markup lo scrive KaTeX, non il modello. Opzioni: `trust: false` (niente `\href` né comandi
     HTML), `maxSize` e `maxExpand` limitati, `throwOnError: false` (una formula sbagliata resta
     com'è scritta).
   - È l'unico punto in cui la webview inserisce markup (`dangerouslySetInnerHTML`), ed è markup
     generato da KaTeX.
   - Le formule già disegnate stanno in una cache, perché durante lo streaming lo stesso testo si
     ridisegna molte volte.

## Conseguenze

- **Dimensione:** il bundle della webview cresce di circa 250 KB.
- **Non coperto:** immagini, note a piè di pagina, elenchi di attività, HTML del modello (resta
  testo).
- **MathML:** la resa dipende dal motore del browser di VS Code (Chromium), meno rifinita del CSS
  di KaTeX. Se servisse, il CSS e i font di KaTeX si possono servire dalla cartella `media`.
