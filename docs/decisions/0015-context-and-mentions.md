# 0015. Indicatore di contesto e file indicati con `@`

Stato: Accettata (iterazione 3).

## Contesto

- **L'utente non vedeva quanto è pieno il contesto** della sessione a cui scrive: serve a
  decidere quando aprire una chat nuova, e servirà alla continuità fra sessioni (ADR 0011, da
  progettare con il layer di memoria dell'utente).
- **Per indicare un file** bisognava scriverne il percorso a mano; l'ADR 0011 ha deciso che gli
  allegati passano come percorsi, così il contesto del leader non si riempie.

## Decisione

### Indicatore di contesto

- **Cosa misura:** i token dell'ultima richiesta della sessione principale al modello, cioè la
  conversazione com'è adesso, rispetto alla finestra del modello.
  - Codex: `thread/tokenUsage/updated` del thread principale, campo `last` (`totalTokens`) e
    `modelContextWindow`. I sotto-agenti hanno thread propri e non contano.
  - Claude: l'`usage` dell'ultimo messaggio dell'assistente nella conversazione principale
    (input, scritture e letture di cache, output); la finestra dal campo `contextWindow` del
    modello in `modelUsage` del risultato.
- **Non è il consumo del turno:** quello somma ogni richiesta del turno, e resta nella scheda
  del turno.
- **Dove si vede:** sotto il riquadro di scrittura, per il destinatario scelto
  (`CONTESTO 25k / 258k · 10%`), e nella vista Attività per ogni ruolo. Si salva con la chat.

### File indicati con `@`

- **Nel riquadro:** dopo `@` compare l'elenco dei file e delle cartelle della cartella di lavoro
  (le stesse esclusioni dei checkpoint, al massimo 5000 file), filtrato mentre si scrive;
  frecce e Invio o Tab per scegliere, Esc per chiudere. L'elenco si rilegge a ogni `@`.
- **Dall'editor:** "Only One Chat: Add File or Selection to Chat" (Ctrl+Alt+K, anche nel menu
  contestuale) inserisce `@file`, oppure `@file#L10-20` per la selezione.
- **All'invio** l'host cerca le menzioni nel testo e aggiunge, dopo il testo, un blocco
  "Allegati" per gli agenti:
  - file e cartelle come percorsi relativi, che gli agenti leggono da sé (anche con i
    sotto-agenti);
  - un intervallo di righe è copiato nel messaggio solo fino a 80 righe e 8000 caratteri; oltre,
    resta il riferimento;
  - si tengono solo percorsi che esistono e restano nella cartella (percorso reale), al massimo
    20 per messaggio; il resto, `@impl` in testa e gli indirizzi email compresi, resta testo.
- **Nel thread** il messaggio mostra il testo dell'utente e l'elenco degli allegati.
- **Immagini:** non ora (ADR 0013).

## Conseguenze

- **Adapter:** `context` nel risultato del turno, per Codex e Claude; il runtime lo inoltra con
  il messaggio.
- **La continuità fra sessioni** potrà usare questa misura come soglia, quando sarà progettata.
