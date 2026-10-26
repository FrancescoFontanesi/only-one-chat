Scrivi in Python 3, con la sola libreria standard, una calcolatrice da riga di comando nella
cartella corrente.

## Struttura

- `lexer.py`: tokenizzazione.
- `evaluator.py`: parsing e valutazione (puoi separare il parsing in `parser.py`).
- `main.py`: interfaccia da riga di comando.
- `test_calc.py`: test automatici con `unittest`, da eseguire con `python -m unittest`.

## Linguaggio

- Numeri interi e decimali: `3`, `2.5`.
- Operatori `+ - * / %`, potenza `^` e meno unario, con queste precedenze dalla più bassa:
  `+ -`, poi `* / %`, poi il meno unario, poi `^`, che è associativo a destra. Quindi
  `-2^2` vale `-4`, `2^-1` vale `0.5` e `2^3^2` vale `512`.
- Parentesi.
- Variabili con nomi `[A-Za-z_][A-Za-z0-9_]*` e assegnazione `nome = espressione`, solo come
  istruzione intera.
- Funzioni `sqrt(x)`, `abs(x)`, `min(a, b, ...)` e `max(a, b, ...)`; `min` e `max` vogliono
  almeno un argomento.

## Output

Un risultato intero si stampa senza decimali (`7`, e `4.0` diventa `4`); altrimenti si stampa
il `repr` di Python del float (`3.5`, `0.3333333333333333`). `-0` si stampa `0`.

## Uso

1. `python main.py -e "ISTRUZIONE"`: valuta una sola espressione o assegnazione e stampa il
   risultato (un'assegnazione stampa il valore assegnato). Exit code 0.
2. `python main.py` senza argomenti: legge istruzioni da stdin, una per riga, e ignora le
   righe vuote. Le variabili restano valide fra le righe. Stampa il risultato di ogni
   espressione; le assegnazioni non stampano nulla. Dopo un errore lo stampa e continua.
   Exit code 1 se c'è stato almeno un errore, altrimenti 0.

## Errori

Una riga su stderr che inizia con `Error`, ed exit code 1 in modalità `-e`:

- sintassi: `Error at column N: <descrizione>`, con N la colonna (da 1) del token che causa
  l'errore; la fine della riga è la colonna lunghezza + 1;
- `Error: division by zero`, anche per `%`;
- `Error: unknown variable 'x'`;
- `Error: unknown function 'f'`;
- `Error: invalid argument for sqrt`, per un argomento negativo;
- `Error: wrong number of arguments for <nome>`.
