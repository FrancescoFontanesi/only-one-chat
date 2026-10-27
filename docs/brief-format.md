# Il brief

Stato: formato v1, deciso al passo 2 del toolkit
([ADR 0009](decisions/0009-chatgpt-web-and-three-turn-layer.md)). L'estensione non lo legge
ancora: per ora lo leggono gli esperimenti della sandbox, da un file.

## A cosa serve

- **Il brief porta le decisioni prese nella chat di ChatGPT web al gateway.** È di alto
  livello: ChatGPT non vede il repository. Contiene le conclusioni con il loro perché, non il
  ragionamento che ci ha portato.
- **Il gateway lo aggancia al codice reale e lo traduce nella specifica per l'implementatore**,
  che è lo standard operativo. Il gateway conserva la storia del filone (`track`): brief,
  specifiche e risultati precedenti. Non vede invece la conversazione.
- **Le istruzioni che lo insegnano a ChatGPT** sono in
  [templates/chatgpt-project-instructions.txt](templates/chatgpt-project-instructions.txt).
  - Vanno incollate nelle istruzioni di un Progetto ChatGPT, una volta per ogni repository,
    con l'id del progetto al posto di `{{PROJECT_ID}}`.
  - Da verificare: il limite di lunghezza delle istruzioni di un Progetto.

## Controlli meccanici

L'estensione legge solo l'intestazione e la chiusura. Il corpo passa al gateway così com'è.

- La prima riga è `<<<OOC-BRIEF v1 project=<id> track=<slug>`, con `id` e `slug` fatti di
  lettere minuscole, cifre e trattini. È la protezione contro le copie sbagliate o di altri
  progetti.
- L'ultima riga è `OOC-BRIEF>>>`. Se manca, la copia è stata troncata, per esempio da tre
  backtick dentro il blocco.

Se manca una sezione obbligatoria se ne accorge il gateway: la segnala, oppure chiede un
chiarimento.

## Struttura

Le sezioni vanno in quest'ordine, con i titoli in inglese. Quelle vuote si omettono. Il
contenuto è nella lingua della conversazione, a elenchi brevi e non in prosa.

| Sezione               | Obbligatoria             | Contenuto                                                         |
| --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `Goal`                | sì                       | cosa deve essere vero alla fine, in una o due frasi               |
| `Context`             | se c'è qualcosa di nuovo | solo le novità rispetto all'ultimo brief o risultato, e il perché |
| `Decisions`           | sì                       | ciò che è vincolante, una riga per ciascuna con il suo perché     |
| `Plan`                | se ci sono più tappe     | tappe con il loro risultato e, se l'ordine conta, il motivo       |
| `Latitude`            | se c'è margine           | dove l'agente decide da solo, riportando poi cosa ha deciso       |
| `Constraints`         | se ce ne sono            | divieti e cosa resta fuori ambito                                 |
| `Acceptance criteria` | sì                       | comportamenti verificabili, numerati, di alto livello             |
| `Report`              | no                       | cosa si vuole sapere oltre al risultato standard                  |

## Regole di scrittura

- **Una cosa per sezione.** Una decisione non sta nel piano, un vincolo non sta nel contesto.
- **Le tappe, non i passi.** Il `Plan` dice cosa deve risultare da ogni tappa; i file e le
  funzioni li sceglie il gateway, che vede il codice.
- **Niente fatti inventati sul repository.** Ciò che non si sa va in `Latitude` o in `Context`,
  detto come non noto.
- **Si può rimandare a brief e risultati precedenti dello stesso filone**, non a ciò che è
  stato detto solo in chat.
- **Nessuna decisione ancora aperta dentro il brief.**
- **Niente tre backtick dentro il blocco**, perché lo chiuderebbero. I frammenti di codice
  vanno su righe rientrate di quattro spazi.

## Esempio

```text
<<<OOC-BRIEF v1 project=calc track=user-functions

## Goal
L'utente può definire funzioni proprie e usarle nelle espressioni.

## Decisions
- Sintassi def nome(parametri) = espressione: coerente con l'assegnazione.
- I parametri oscurano le variabili globali: comportamento prevedibile.
- Niente ricorsione per ora: errore chiaro invece di un crash.

## Latitude
- Come rappresentare le funzioni nel valutatore.

## Constraints
- La riga di comando non cambia.

## Acceptance criteria
1. Una funzione definita si può chiamare nelle espressioni successive.
2. Una chiamata con un numero sbagliato di argomenti dà un errore chiaro.
3. Una funzione ricorsiva dà un errore dedicato, non un crash.

OOC-BRIEF>>>
```
