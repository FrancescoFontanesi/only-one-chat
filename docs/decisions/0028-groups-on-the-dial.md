# 0028. Gruppi e nodi singoli sulla ghiera, SQUAD nel composer

Stato: Accettata (iterazione 3). Sostituisce il punto 5 dell'ADR 0027 (ghiera per blocchi).

## Contesto

- **Due scelte in un solo anello:** l'anello di sinistra elencava insieme i blocchi (la coppia
  leader e implementatore, i nodi) e i ruoli, ma i nomi scelti dall'utente non stanno in tre
  lettere come le sigle dei provider della ghiera di destra.
- **Cosa c'è oggi:** un solo gruppo, la coppia di leader e implementatore, e i nodi isolati. I
  gruppi liberi di nodi richiedono la delega ai nodi, che non c'è ancora.

## Decisione

1. **Due scelte, due controlli.**
   - **Il gruppo o il nodo singolo** si sceglie con un'etichetta in alto sulla ghiera di sinistra,
     sopra il mirino del reasoning. Mostra l'alias, con ↕ se c'è altro da scegliere; il clic o la
     rotella scorrono fra il gruppo e i nodi, questi ultimi con quelli tolti dalla lavagna in
     fondo.
   - **Il ruolo** si sceglie sull'anello, che ha solo i ruoli del gruppo scelto (LDR, IMP). Per un
     nodo singolo l'anello è vuoto: ha un solo ruolo.
   - Il resto della ghiera non cambia: nome, mirino del reasoning, modello, consegna o permessi.
2. **Il nome:** un nodo singolo ha un alias, e senza alias il nome del suo provider. Il gruppo di
   leader e implementatore ha un alias, e senza alias il provider del leader. Un nodo che ha
   ancora il nome automatico lo cambia con il provider se cambia provider; un alias scelto
   dall'utente resta.
3. **Dove si dà l'alias:** in Squad, selezionando il leader o l'implementatore (campo "Gruppo",
   salvato in `onlyOneChat.team.name`), o un nodo (campo "Nome"). Un campo vuoto rimette il nome
   predefinito.
4. **Per ora un solo gruppo:** la coppia di leader e implementatore. I gruppi liberi di nodi, con
   un ruolo per nodo e un ciclo di delega ciascuno, arrivano con la delega ai nodi.
5. **SQUAD sta nel composer,** al centro del riquadro fra CTX e INVIA, con il conteggio delle
   richieste in attesa. Sui pannelli stretti segue CTX.

## Conseguenze

- **Meno nomi sull'anello:** le sigle LDR e IMP bastano, e l'etichetta del gruppo accetta nomi
  fino a 40 caratteri, abbreviati con "…" dove manca spazio.
- **La lavagna di Squad** non raggruppa ancora i riquadri: la coppia si riconosce dall'alias nel
  campo "Gruppo".
