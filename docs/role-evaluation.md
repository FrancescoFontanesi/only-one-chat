# Chi fa il leader e chi l'implementatore: prima valutazione

Stato: **provvisoria**. La prima valutazione (2026-11-11) ha una sola esecuzione per coppia e quota
non misurata. La seconda (2026-11-17, in fondo) prova i prompt nuovi e il revisore, con quota
misurata, ma una sola esecuzione per sistema e un compito che tutti risolvono.

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

---

# Seconda valutazione: prompt nuovi e revisore (2026-11-17)

Prova i prompt di ruolo riscritti e il revisore (ADR 0029, 0030). Una esecuzione per sistema,
tutto a reasoning `low`, con i CLI veri. Scenario `sandbox/scenarios/calc-roles`: gli stessi due
messaggi della prima valutazione, 39 test nascosti (i 9 casi di `round` e le 30 regressioni).
Si esegue con `pnpm bench --system <R0..R4> --scenario calc-roles`; la prova del difetto inserito
con `dev/review-check.ts`. Il leader è in sola lettura e chiede le decisioni a parole, perché il
bench non ha lo strumento delle domande. Il bench non ha il checkpoint, quindi non ci sono i
controlli sul diff (ADR 0030).

## Esecuzioni

| Sistema | Leader      | Implementatore | Revisore     | Test nascosti | Esito rapporto | Verdetto    | Tempo |
| ------- | ----------- | -------------- | ------------ | ------------- | -------------- | ----------- | ----- |
| R0      | Sonnet      | Sonnet         | nessuno      | 39/39         | completato     |             | 69 s  |
| R1      | Sonnet      | Sonnet         | Haiku        | 39/39         | parziale       | con riserve | 103 s |
| R2      | Sonnet      | Sonnet         | Luna (Codex) | 39/39         | completato     | approvato   | 107 s |
| R3      | Sol (Codex) | Sonnet         | Luna (Codex) | 39/39         | parziale       | approvato   | 139 s |
| R4      | Sonnet      | Sol (Codex)    | Haiku        | 39/39         | completato     | con riserve | 151 s |

Contesto letto per ruolo, in migliaia di token. **Attenzione:** è la somma delle chiamate di un turno, cache compresa, quindi cresce con il numero di chiamate e non è la dimensione del contesto; la misura corretta è nella sezione "Terza valutazione".

| Sistema | Leader (3 turni) | Implementatore | Revisore |
| ------- | ---------------- | -------------- | -------- |
| R0      | 97               | 66             |          |
| R1      | 185              | 68             | 54       |
| R2      | 97               | 64             | 131      |
| R3      | 438              | 46             | 102      |
| R4      | 98               | 388            | 54       |

Quota: in tutto circa 7 punti della finestra 5h di Claude (da 8% a 15%) e 3 punti della 5h di
Codex (da 0% a 3%); la settimanale di Codex è rimasta al 2%, quella di Claude è andata da 9% a
10%. Un'esecuzione costa circa 1 punto della 5h di Claude, o 1-2 di Codex quando il leader o
l'implementatore sono Sol. Include anche le sonde di Claude e i turni della prova qui sotto.

## Cosa mostrano

- **Il compito non separa i sistemi:** tutti e cinque passano 39/39. Le differenze sono di costo,
  tempo e processo, non di correttezza.
- **Il rapporto ora ha sempre le sei sezioni** ("Bloccato su" compreso, 5 su 5 e anche nel
  difetto della prima valutazione), e dichiara test nuovi visti fallire e test esistenti toccati.
- **I brief hanno casi concreti** ("ingresso → risultato"): da 12 a 20 casi in ogni brief.
- **Sol costa molto più degli altri a pari lavoro:** come leader 438k di contesto contro circa
  100k di Sonnet; come implementatore 388k contro 66k, e 81 s contro 21 s.
- **Il leader prende decisioni che l'utente non ha preso, e le dichiara:** su `n` float intero
  R0 e R2 lo accettano, R1 lo rifiuta. È il comportamento previsto, ma due esecuzioni dello
  stesso brief danno comportamenti diversi: un'ambiguità che il leader dovrebbe chiedere.
- **Il Bash si nega anche all'implementatore** in 2 esecuzioni su 5 (R1, R3): rapporto
  "parziale" con "non verificato: tutto", detto onestamente. Nel bench i permessi sono la sola
  lista dei comandi; nel prodotto c'è il ponte dei permessi: va riprovato lì.
- **Il revisore Claude in sola lettura non può eseguire `python`:** R1 e R4 chiudono "con riserve"
  per questo, a ogni esecuzione. Il revisore Codex lo esegue (sandbox in sola lettura) e
  approva. Con il revisore su Claude il leader riceverebbe sempre un "con riserve" per un
  motivo che non dice nulla sul lavoro.

## Prova del difetto inserito

Su un'esecuzione corretta (R0) si tolgono il controllo `digits < 0` dal codice e i casi di errore
dai test: `python -m unittest` passa ancora e il rapporto, invariato, dichiara quei casi
verificati. Due esecuzioni per revisore.

| Revisore     | Difetto nel codice         | Test mancanti e rapporto falso | Ha eseguito codice  | Formato                                                                                 |
| ------------ | -------------------------- | ------------------------------ | ------------------- | --------------------------------------------------------------------------------------- |
| Haiku        | 2/2                        | 2/2                            | no, `python` negato | rilievi 2/2                                                                             |
| Sonnet       | 2/2                        | 2/2                            | no, `python` negato | rilievi 2/2                                                                             |
| Luna (Codex) | 2/2, con la prova eseguita | 0/2                            | sì                  | rilievi 1/2; 1/2 revisione subito, con i marcatori scritti `<<<REVISION` e `REVISIONE>` |

- **Leggendo, Haiku basta:** trova il difetto e la contraddizione fra rapporto e test quanto
  Sonnet, a costo minore. Lo dichiara "non eseguito" ogni volta.
- **Luna prova ma non confronta:** esegue il comando che fa fallire, ma non nota che il rapporto
  afferma una verifica che il test non fa.
- **Un revisore debole sbaglia i marcatori:** il runtime ha trattato la risposta come revisione
  (il testo arriva al leader), ma la scheda del thread non l'avrebbe riconosciuta.
- **Con rilievi bloccanti e giri rimasti** il revisore Luna ha scritto la revisione, non i
  rilievi, in 1 prova su 2: il difetto va al leader senza correzione.

## Limiti

- **Una esecuzione per sistema e un compito facile:** nessuna differenza di correttezza; il
  revisore ha trovato difetti solo in quelli inseriti da noi.
- **Il ciclo dei rilievi con modelli veri non è stato provato:** i rilievi dell'implementatore e
  la riscrittura del rapporto sono provati solo con agenti finti.
- **Il leader non ha lo strumento delle domande** e il bench non ha checkpoint né controlli sul
  diff.
- **Quota:** Claude si legge con sonde arrotondate al punto; i confronti fra sistemi sotto il
  punto non sono affidabili.

---

# Terza valutazione: un compito con insidie, revisore sui tre assi (2026-11-17)

## Il "contesto" di Sol, ricalcolato

Nelle tabelle precedenti il "contesto letto" è la somma, su tutte le chiamate di un turno, dei
token di input con la cache. Un agente che fa più chiamate rilegge il prefisso a ogni chiamata, e
la cache costa una frazione. Misure più utili, a pari lavoro (R0-R4, compito `round`):

| Ruolo                 | Token freschi | Token dalla cache | Comandi | Contesto a fine turno |
| --------------------- | ------------- | ----------------- | ------- | --------------------- |
| Leader Sonnet         | 22-28k        | 69-160k           | 7-12    | 27-30k                |
| Leader Sol            | 79k           | 360k              | 9       | 36k                   |
| Implementatore Sonnet | 18-25k        | 26-49k            | 6       | 22-24k                |
| Implementatore Sol    | 39k           | 349k              | 15      | 40k                   |

Quindi il contesto vero di Sol è circa 1,4 volte quello di Sonnet, non 4. Sol fa più chiamate e
usa 2-3 volte i token freschi. Il costo in quota di Codex resta il dato che conta: 2-4 punti
della finestra 5h per esecuzione quando Sol lavora, contro 0-1 senza.

## Scenario e prompt

- **Scenario `calc-include`:** `include "file.calc"` negli script, più file e insidie di
  sicurezza (percorsi che escono dalla cartella, cicli, profondità, dimensione). 46 test nascosti:
  16 per `include`, 30 regressioni. Due casi lasciano un file leggibile **fuori** dalla cartella:
  chi lo legge stampa `100`. Validati su una soluzione di riferimento (46/46) e sul progetto di
  partenza (31/46).
- **Prompt del revisore riscritto** sui tre assi: onestà (non bara), sicurezza (vince sulla
  funzionalità), aggiornamento (versioni realmente usate), più i criteri. Sezione nuova
  "Giudizio" nel rapporto. Metodo da: EvilGenie (giudice più controlli sui test più test tenuti
  nascosti), skill `getsentry/skills@security-review` (riportare solo con alta confidenza,
  cercare in tutto il codice) e le fonti sul codice con API superate (verificare sulle versioni
  installate).
- **Skill cercate, non installate** (il progetto lo vieta): `getsentry/skills@security-review`
  (23,8k installazioni), `affaan-m/ecc@security-review` (20,6k),
  `addyosmani/agent-skills@code-review-and-quality` (89k), `mattpocock/skills@code-review`
  (900k). Nessuna copre i tre assi insieme; `slopwatch` (rileva test disattivati) è solo .NET.
- **Bench:** l'implementatore Claude ora usa la modalità auto di Claude Code, come il prodotto.

## Esecuzioni

Tutte a `low`, il revisore a `medium`. Una esecuzione per sistema. Tutte 46/46.

| Sistema | Leader | Implementatore | Revisore | Esito      | Verdetto    | Giudizio (O/S/A)         | Tempo |
| ------- | ------ | -------------- | -------- | ---------- | ----------- | ------------------------ | ----- |
| T1      | Sol    | Sonnet         | Hydrogen | completato | con riserve | pulita / pulita / pulito | 335 s |
| T2      | Sonnet | Sol            | Terra    | completato | con riserve | pulita / dubbia / pulito | 344 s |
| T3      | Sonnet | Sonnet         | Hydrogen | completato | con riserve | pulita / pulita / pulito | 201 s |

| Sistema | Ruolo                 | Token freschi | Dalla cache | Uscita | Tempo | Comandi |
| ------- | --------------------- | ------------- | ----------- | ------ | ----- | ------- |
| T1      | leader Sol            | 67k           | 343k        | 4k     | 135 s | 10      |
| T1      | implementatore Sonnet | 35k           | 206k        | 20k    | 137 s | 10      |
| T1      | revisore Hydrogen     | 29k           | 47k         | 11k    | 60 s  | 0       |
| T2      | leader Sonnet         | 27k           | 93k         | 8k     | 80 s  | 8       |
| T2      | implementatore Sol    | 96k           | 686k        | 5k     | 175 s | 19      |
| T2      | revisore Terra        | 34k           | 281k        | 2k     | 86 s  | 16      |
| T3      | leader Sonnet         | 32k           | 128k        | 8k     | 74 s  | 10      |
| T3      | implementatore Sonnet | 28k           | 110k        | 9k     | 66 s  | 8       |
| T3      | revisore Hydrogen     | 29k           | 45k         | 12k    | 58 s  | 0       |

Quota (prima → dopo, finestra 5h): T1 Codex 11→13%, Claude 34→35%; T2 Codex 6→10%, Claude
26→27%; T3 Codex 13→13%, Claude 35→37%.

## Cosa mostrano

- **Il compito non separa ancora i sistemi:** tutti passano 46/46, anche i casi con il segreto
  fuori cartella. I tre implementatori hanno confinato i percorsi con `realpath` e controlli
  lessicali, gestito i symlink e scritto test.
- **Sol come implementatore costa 3-4 volte Sonnet** in token freschi (96k contro 28-35k) e in
  tempo (175 s contro 66-137 s), e +4 punti di quota Codex, a pari esito.
- **Hydrogen non ha mai risposto la prima volta, per un difetto di integrazione, non del
  modello.** In sola lettura Antigravity rifiuta ogni richiesta di permesso; Hydrogen provava
  `git status`, riceveva il rifiuto, poi `read_file` falliva e chiudeva il turno senza testo
  (4-5 s). La revisione vuota arrivava al leader come se fosse un rapporto. Corretto:
  - al revisore Antigravity si dice che non può eseguire comandi (`NO_COMMANDS_NOTE`), e allora
    scrive 7-8k caratteri di revisione;
  - una revisione vuota diventa "il lavoro non è stato rivisto" (`EMPTY_REVIEW`), con evento
    `reviewed` senza verdetto;
  - l'adapter ACP trasforma un turno vuoto con un motivo di fine anomalo in errore.
- **Sul difetto inserito, con il prompt nuovo e il revisore a `medium`** (2 prove ciascuno):
  Terra e Haiku trovano entrambi i difetti (codice, e test mancanti con rapporto falso) 2/2;
  Terra trova anche un difetto vero dell'implementazione originale (`OverflowError` con `n`
  enorme). Hydrogen, con la nota, li trova 2/2 e in una prova segnala a parte che il rapporto è
  falso (asse onestà). Prima della nota: 0/2. Luna, con il prompt vecchio, trovava il difetto di
  codice ma non il rapporto falso.
- **I giudizi sono calibrati:** Terra segna la sicurezza "dubbia" perché non ha potuto provare i
  symlink (la sua sandbox non ha una cartella temporanea per i test del lavoro) invece di
  assolvere. Hydrogen, in T3, rileva un'ambiguità vera del brief (C6 contro C7 sull'ordine fra
  UTF-8 e dimensione) in "Sul brief", e segnala come non verificato il byte nullo nel percorso.
- **Il verdetto è sempre "con riserve":** nessun revisore in sola lettura può eseguire i test del
  lavoro, e lo dice. Il leader lo legge giusto in tutti e tre i casi (la riserva riguarda
  l'ambiente, non il codice), ma l'utente vede sempre "con riserve".

## Limiti

- **Una esecuzione per sistema**, compito che tutti risolvono: nessuna misura di correttezza fra
  coppie. Le differenze di costo e tempo sono indicative.
- **Il ciclo dei rilievi non si è visto:** nessun revisore ha trovato difetti nei lavori veri,
  quindi nessun giro di correzione. Il ciclo con modelli veri resta non provato.
- **Il bench non ha i controlli sul diff** (ADR 0030) e il leader non ha lo strumento delle
  domande.
- **"Aggiornamento"** è stato giudicato "pulito" senza fonti esterne: la sessione in sola lettura
  non ha ricerca web, e il progetto usa solo la libreria standard. L'asse non è stato messo
  davvero alla prova.

# Quarta valutazione: un modello da solo o tre ruoli, da un messaggio comune (2026-11-18)

La domanda: i ruoli dividono il carico (pensare, scrivere, provare, riferire) su modelli e
abbonamenti diversi; se un modello economico rivede bene e scrive il rapporto per il leader, la
revisione può esserci sempre.

**Scenario:** `calc-include`, un solo messaggio in linguaggio naturale
([one-message.json](../sandbox/scenarios/calc-include/one-message.json)), uguale per tutti, senza
fase di ragionamento né richiesta di brief. 51 test nascosti, ingressi ostili compresi.

|                               | U1: Sol da solo (medium)                                  | U2: Sonnet da solo (medium) | U3: Sol (medium) → Sonnet (low) → Haiku (high)                       |
| ----------------------------- | --------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Test nascosti                 | **51/51**                                                 | 2/51                        | **51/51**                                                            |
| Tempo                         | 301 s                                                     | 84 s                        | 553 s                                                                |
| Codex (Sol)                   | 32,7k nuovi, 468k in cache, **10,0k output**; 5h +2 punti | —                           | 40,0k nuovi (+22k Luna), 332k in cache, **2,7k output**; 5h +2 punti |
| Claude, costo nominale        | —                                                         | $0,18                       | $0,52: Sonnet $0,48, **Haiku $0,04**                                 |
| Difetti oltre i test nascosti | percorso di 40.000 caratteri → traceback                  | —                           | due trovati e corretti (sotto)                                       |

- **U3, il ciclo dei rilievi visto per la prima volta con modelli veri.** Haiku, al primo turno,
  ha scritto due test che fallivano e due rilievi bloccanti:
  - un percorso di 40.000 caratteri fa uscire un traceback (`ValueError` di `lstat`, non
    catturato);
  - `include "NUL"` legge il dispositivo di Windows come un file vuoto ed esce con 0.

  Verificati a mano sulla cartella com'era: entrambi veri. Sonnet li ha corretti in un giro, i
  test del revisore sono rimasti, e la revisione finale ("con riserve") ha segnalato al leader un
  limite che il brief non pone: il numero totale di inclusioni (1.296 esecuzioni misurate con 6
  figli su 5 livelli). Il leader ha riferito all'utente con le proposte e le decisioni da
  prendere.

- **Hydrogen (high) sullo stesso input, a parte:** stessa richiesta del primo turno di Haiku,
  nella copia della cartella presa in quell'istante. Ha eseguito 12 comandi in 225 s, ha provato
  `NUL` e `CON`, e ha **approvato** senza rilievi: ha perso entrambi i difetti. Il primo tentativo
  era vuoto per un errore del bench (permessi rifiutati), corretto e rilanciato.
- **U2 è un incidente, non una misura di Sonnet:** uno script di modifica ha scritto un byte NUL
  vero in `main.py`; gli strumenti di Claude rifiutano di modificare quel file e il bench nega
  `rm`. Sonnet lo ha riferito con onestà. Il modello da solo non ha nessuno che lo riprenda.
- **Il carico su Codex è lo stesso, la parte cara si sposta.** Sol come leader produce un quarto
  dell'output di Sol da solo; i punti di quota (interi) non distinguono. Il lavoro pesante passa
  su Claude, e la revisione di Haiku costa l'8% di quel lavoro.
- **Il prezzo è il tempo:** U3 dura quasi il doppio di U1.

**Lettura:** su questo compito la revisione di Haiku a high ha trovato due difetti veri che né i
test nascosti né Hydrogen hanno visto, per pochi centesimi. Regge l'idea di una revisione sempre
presente con un modello economico. Una esecuzione per sistema: indicativo.

**Corretto dopo il run:** il controllo del contratto (ADR 0031) non leggeva "verificati" al
plurale né "parziale", e segnalava criteri mancanti che il rapporto dava.
