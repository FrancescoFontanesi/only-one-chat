# 0026. `@` nomina un file, + lo allega

Stato: Accettata (iterazione 3). Precisa l'ADR 0015 (allegati) e l'ADR 0018 (riferimenti).

## Contesto

- **Due cose sotto un solo tasto:** nel composer `@` apriva l'elenco dei file e quello scelto
  diventava un allegato sopra il testo. All'agente arrivava un blocco "Allegati", con le righe
  incluse se erano poche.
- **Le chat di Claude Code e Codex usano `@` in un altro modo:** serve a indicare un percorso
  nel testo, non ad aggiungere un file al contesto.

## Decisione

1. **`@` nomina:** scelto un file dall'elenco, nel testo si scrive `@percorso` (relativo alla
   cartella). Nel thread compare come riferimento cliccabile (ADR 0018); all'agente arriva il
   percorso semplice (`plainRefs`), senza allegati.
2. **+ allega:** il pulsante prima di CTX, e il comando `/allega`, aprono il selettore di file di
   VS Code sulla cartella. I file scelti dentro la cartella diventano allegati sopra il testo;
   quelli fuori vengono rifiutati con un avviso. Ctrl+Alt+K resta un modo per allegare il file
   aperto o le righe selezionate.
3. **Allegati separati dal testo:** il messaggio `send` porta gli allegati in un campo proprio
   (al massimo 20 percorsi, validati nell'host). Solo quelli finiscono nel blocco "Allegati"
   dell'ADR 0015.

## Conseguenze

- **Testo dell'utente:** un `@percorso` scritto a mano, che esiste nella cartella, arriva
  all'agente come percorso semplice. Un `@` che non nomina un file della cartella resta
  com'è scritto.
- **Spazi nei percorsi:** un allegato con uno spazio nel percorso non viene preso, perché il
  formato `@percorso` non ammette spazi.
