# Chi fa il leader e chi l'implementatore: prima valutazione

Stato: **provvisoria**. È stata fatta una sola esecuzione per coppia e la quota consumata non è
stata misurata. Va ripresa quando torna la quota di Codex (vedi "Da rifare").

Data: 2026-11-11. Versioni: Claude Code 2.1.322 e Codex 0.164.0. Codice: branch `iter-1-demo`,
con l'ADR 0022.

## La prova

- **Scenario:** `sandbox/scenarios/calc`, la calcolatrice di riferimento (`reference/`), copiata
  in una cartella vuota.
- **Compito:** aggiungere `round(x)` e `round(x, n)`.
- **Due messaggi dell'utente al leader:**
  1. "Vorrei aggiungere alla calcolatrice una funzione round(x) e round(x, n) con n cifre
     decimali. Ragioniamo prima: dove va nel codice, quali casi limite ci sono, come la testiamo?
     Non generare ancora il prompt. Se ti serve una mia decisione, chiedimela."
  2. "Decisioni: arrotondamento come la round di Python; n deve essere un intero >= 0,
     altrimenti "Error: invalid argument for round"; un numero sbagliato di argomenti dà
     l'errore delle altre funzioni. Genera il prompt secondo la struttura e delegalo."
- **Configurazione della chat:**
  - `ChatSession` usata direttamente, senza VS Code;
  - consegna automatica (`mode: 'auto'`) e revisione sempre (`review: 'always'`);
  - permesso del leader `read-only`, dell'implementatore `auto`;
  - `allowedCommands: ['python']`;
  - `verifyCommand: python -m unittest`.
- **Risposte del finto utente:**
  - a ogni domanda del leader risponde con la prima opzione;
  - nega ogni richiesta di permesso.
- **Ciclo provato:** pianificazione, brief intercettato e inviato dal runtime, implementazione,
  rapporto, fatti verificati e revisione del leader.

### Controlli deterministici

- **8 controlli sul ciclo:**
  - il primo messaggio non produce una delega;
  - il brief viene intercettato e inviato;
  - il brief contiene "Obiettivo" e "Criteri di accettazione";
  - l'implementatore fa un solo turno;
  - il blocco rapporto è presente;
  - le sezioni del rapporto sono in ordine;
  - i fatti arrivano al leader;
  - il leader fa un turno dopo il rapporto.
- **9 casi di `round` a scatola chiusa** (`python main.py -e …`):
  - `round(3.567, 2)` dà 3.57;
  - `round(2.5)` dà 2;
  - `round(-2.5)` dà -2;
  - `round(7)` dà 7;
  - `round(10 / 4, 1)` dà 2.5;
  - `round(1, -1)` e `round(1, 2.5)` danno "invalid argument";
  - `round()` e `round(1, 2, 3)` danno "wrong number of arguments".
- **Regressioni:** i 30 casi di `hidden-tests.json`, con gli a capo normalizzati.
- **Test unitari:** `python -m unittest` (il riferimento ne ha 3).

## Risultati

Il reasoning era uguale nelle due coppie: medium per il leader e low per l'implementatore.

|                     | A: leader Codex gpt-6.1-sol · impl. Claude sonnet | B: leader Claude sonnet · impl. Codex gpt-6.1-sol |
| ------------------- | ------------------------------------------------- | ------------------------------------------------- |
| Controlli sul ciclo | 8/8                                               | 7/8 (il rapporto non ha "Bloccato su")            |
| `round`             | 9/9                                               | 9/9                                               |
| Regressioni         | 0/30                                              | 0/30                                              |
| Test unitari        | 5, OK                                             | 10, OK                                            |
| Domanda del leader  | sì (`requestUserInput`)                           | sì (`AskUserQuestion`)                            |
| Tempo totale        | 192 s                                             | 156 s                                             |

### Consumo per ruolo

"Contesto" è la somma del contesto di input di tutte le chiamate al modello, cache compresa. I
dollari di Claude sono il prezzo di listino riportato dal CLI: con l'abbonamento non vengono
fatturati.

| Ruolo           | Codex gpt-6.1-sol                       | Claude sonnet                                  |
| --------------- | --------------------------------------- | ---------------------------------------------- |
| Leader, 3 turni | 356k di contesto, 4,0k di uscita, 128 s | 180k di contesto, 4,8k di uscita, 54 s, $0,198 |
| Implementatore  | 465k di contesto, 3,1k di uscita, 100 s | 231k di contesto, 4,1k di uscita, 61 s, $0,207 |

Turni del leader, nell'ordine pianificazione, brief e revisione:

| Turno          | Codex      | Claude     |
| -------------- | ---------- | ---------- |
| Pianificazione | 265k, 88 s | 114k, 29 s |
| Brief          | 29k, 23 s  | 32k, 16 s  |
| Revisione      | 62k, 17 s  | 34k, 10 s  |

### Osservazioni

- **Token:** Codex usa circa il doppio dei token di Claude in tutti e due i ruoli. Il turno che
  pesa di più è la prima esplorazione del leader Codex.
- **Costo di Claude:** è lo stesso in entrambi i ruoli, circa $0,20.
- **Revisione:**
  - il leader Codex ha rieseguito da solo i casi rimasti aperti, in sola lettura;
  - il leader Claude non ha riaperto il codice, ma ha segnalato l'affermazione non verificata
    "i test fallivano prima".
- **Rapporto:**
  - quello di Claude implementatore è completo;
  - nelle due esecuzioni di B (la prima senza lo strumento delle domande) Codex ha omesso
    "Bloccato su". La causa probabile è il prompt: "Solo se l'esito non è completato" contrasta
    con "una sezione vuota contiene nessuno" (`packages/runtime/prompts/implementer.md`).
- **Test scritti:** l'implementatore Codex ne scrive di più (7 contro 2).

## Conclusione provvisoria

Leader Codex e implementatore Claude (A):

- vincono su revisione e rapporto;
- usano il 24% di token Codex in meno, a parità di consumo Claude.

B è più veloce di 36 s su circa 3 minuti.

## Limiti

- **Quota:** non è stata misurata la quota consumata (finestre 5h e settimanale prima e dopo).
  Token di Codex e dollari di Claude non sono confrontabili fra loro.
- **Varianza:** una sola esecuzione per coppia. Le differenze sulla revisione possono essere
  casuali.
- **Durata della sessione:** una sessione vera ha molti più turni di pianificazione, quindi la
  parte del leader nel consumo cresce rispetto a questa prova.
- **Coppie non provate:** Claude/Claude e Codex/Codex.

## Da rifare

1. **Prima:** correggere la riga "Bloccato su" in `implementer.md`, così il formato del rapporto
   non dipende dall'interpretazione.
2. **Quota:** leggere l'utilizzo di entrambi i provider prima e dopo ogni esecuzione, con i
   lettori dell'estensione e non aprendo file.
3. **Esecuzioni:** almeno 3 per coppia, sulle quattro coppie (A, B, Claude/Claude,
   Codex/Codex).
4. **Compito:** stesso scenario e stessi messaggi, più un compito con più file per vedere il
   costo di esplorazione del leader.
5. **Revisione:** verificare se il leader riapre il codice o si fida del rapporto.
