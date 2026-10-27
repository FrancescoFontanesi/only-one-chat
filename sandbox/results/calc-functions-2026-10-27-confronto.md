# Scenario calc-functions, 27 ottobre 2026: gateway o modello da solo

Un run per sistema, quindi indicativo e non statistico. Tutti i modelli a effort low, stesso
brief ([brief.txt](../scenarios/calc-functions/brief.txt)), stesso progetto di partenza (la
calcolatrice di `calc`). Dati grezzi: i file `calc-functions-*-2026-10-27T11-*` (`.json` e `.md`).

|                         | GC: Sol → Sonnet → Sol         | GA: Opus → Luna → Opus          | SS: Sol da solo                | SO: Opus da solo |
| ----------------------- | ------------------------------ | ------------------------------- | ------------------------------ | ---------------- |
| Test nascosti           | **50/50**                      | 45/50                           | **50/50**                      | **50/50**        |
| Esito dichiarato        | partial                        | partial                         | done                           | done             |
| Il risultato è fedele?  | sì, e più severo               | in parte                        | sì                             | sì               |
| Tempo                   | 256 s                          | 147 s                           | 92 s                           | **91 s**         |
| Costo nominale Claude   | $0.30                          | $0.36 (corretto)                | $0                             | $0.35            |
| Token Sol o Luna        | Sol 60k + 365k cache, 4.6k out | Luna 32k + 279k cache, 6.4k out | Sol 31k + 176k cache, 3.6k out | —                |
| Quota 5h Codex / Claude | +1 / +1                        | 0 / +1                          | +2 / 0                         | (+1 rumore) / +1 |

Tempi per turno: in GC, Sol impiega 109 s, Sonnet 98 s e il risultato di Sol 46 s; in GA,
Opus impiega 50 s, Luna 71 s e il risultato di Opus 26 s.

## Lettura

- **Correttezza**: tre sistemi su quattro superano tutti i test nascosti. GA no: Luna ha
  riscritto `main.py` e in modalità script ora stampa anche le assegnazioni, e un argomento
  sconosciuto non dà più l'errore d'uso. Così falliscono 5 test, 2 dei quali di `calc`.
- **Il gateway non ha reso più corretto il codice.** Su un brief già tutto deciso e un progetto
  piccolo, Sol e Opus da soli fanno lo stesso lavoro in un terzo del tempo di GC.
- **Il gateway costa più del modello da solo.** In GC, Sol consuma il doppio dei token che in
  SS: legge il codice, scrive la specifica e poi rilegge il codice per il risultato. A questo
  si aggiunge Sonnet. GA usa Opus due volte e costa circa quanto SO, più Luna.
- **Correzione dei costi di Claude.** Con `--resume`, Claude Code riporta uso e costo cumulativi
  sulla sessione, e il runner li sommava. Il gateway Opus di GA e di GOL, ripreso al turno 3, era
  quindi contato due volte. I valori in queste tabelle sono corretti: GA $0.36, non $0.59; GOL
  $0.14, non $0.24. I `.md` grezzi riportano ancora i valori gonfiati. L'adapter ora calcola
  la differenza da solo.
- **Dove il gateway ha dato valore: la verifica del risultato.**
  - Al turno 3, Sol in GC ha trovato una regressione reale che i test nascosti non coprono:
    `1/0 +` ora dà un errore di sintassi invece di `division by zero`, perché il parsing
    completo precede la valutazione. La regressione è confermata a mano.
  - Ha anche segnalato i file aggiunti fuori ambito.
  - Però è stata la sua stessa specifica a prescrivere l'albero sintattico che la causa, e
    nel risultato la attribuisce all'implementatore.
  - SS e SO conservano invece i token del corpo e mantengono la valutazione durante il
    parsing, quindi non hanno questa regressione.
- **La verifica di Opus in GA è stata incompleta.** Ha visto la suite rossa e un messaggio
  cambiato, ma non le due regressioni di `main.py` che rompono i test di `calc`. Ha dichiarato
  il criterio 3 soddisfatto, mentre quel caso fallisce per l'output in più.
- **Fedeltà dei modelli da soli**: SS e SO hanno dichiarato "done" e avevano ragione. SO ha
  dato il rapporto più ricco, compresi i comandi che gli sono stati negati.

## Limiti e fattori di disturbo

- **Un solo run per sistema.**
- **Profilo personale dell'utente.**
  - Nelle sessioni Codex l'hook di graft scrive `graft\` (e `.gitignore`, `.ignore`) nella
    cartella del run: due file in GC, dove Codex è in sola lettura, e la cartella intera in
    GA e SS.
  - rtk riscrive i comandi: SS riporta `rtk python -m unittest`.
  - Codex passa dal proxy Headroom.
- **Quota in punti percentuali interi e rumorosa**: durante SO, che non usa Codex, la quota di
  Codex è salita di un punto. Per confrontare servono i token e il costo nominale, non i punti.
- **Brief molto deciso e progetto piccolo**: è il caso più favorevole al modello da solo. Il
  gateway serve soprattutto ad agganciare il brief al codice, e qui c'era poco da agganciare.

## Secondo giro: il leader leggero (GCL, GOL)

Il leader non esplora il repository e non ricopia il brief: scrive solo le sue note, e il
runtime inoltra il brief originale. Il risultato lo giudica sui fatti del runner, senza
rileggere il codice. Tutto a low, come prima. Le finestre di 5 ore si erano azzerate nel
frattempo.

|                       | GC (gateway pieno)  | GCL: Sol leggero → Sonnet | GOL: Opus leggero → Sol | SS: Sol da solo | SO: Opus da solo |
| --------------------- | ------------------- | ------------------------- | ----------------------- | --------------- | ---------------- |
| Test nascosti         | 50/50               | 50/50                     | 50/50                   | 50/50           | 50/50            |
| Leader: contesto      | Sol 425k            | **Sol 47k**               | **Opus 36k**            | —               | —                |
| Leader: output        | 4.6k                | **0.8k**                  | 2.1k                    | —               | —                |
| Implementatore        | Sonnet 209k, 13.6k  | Sonnet 119k, 11.2k        | Sol 482k, 5.0k          | Sol 207k, 3.6k  | Opus 172k, 8.5k  |
| Costo nominale Claude | $0.30               | **$0.24** (Sonnet)        | **$0.14** (Opus leader) | $0              | $0.35            |
| Tempo                 | 256 s               | 116 s                     | 187 s                   | 92 s            | 91 s             |
| Risultato             | partial, più severo | partial, troppo prudente  | done, fedele            | done            | done             |

- **Il sovraccarico del leader scende di circa 9 volte.** Con un brief strutturato il leader
  leggero costa una frazione dell'implementazione.
- **GCL è più economico di ciascun modello da solo su entrambe le subscription.** Sol consuma
  47k di contesto contro i 207k di SS; Claude spende $0.24 contro i $0.35 di SO. Il carico si
  distribuisce, al prezzo di circa 25 s in più.
- **GOL distribuisce, ma risparmia solo su Claude** ($0.14 contro i $0.35 di SO). Sol come
  implementatore ha letto più del doppio di
  SS (482k contro 207k) e ha scritto un file di test separato. È un solo run: può essere
  variabilità.
- **In GCL il leader è stato troppo prudente.**
  - Il codice era corretto (50/50); erano sbagliati due test scritti da Sonnet.
  - Senza rileggere il codice, il leader vedeva solo le ultime 15 righe dell'output e ha
    dichiarato ogni criterio "non verificato".
  - Correzione già fatta: i fatti del runner ora elencano i test falliti per nome. Resta un
    limite di fondo: senza leggere il codice il leader non distingue un test sbagliato da un
    difetto. È un caso per la verifica breve e indipendente sul diff.
