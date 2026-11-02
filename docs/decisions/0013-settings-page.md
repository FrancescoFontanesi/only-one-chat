# 0013. Pagina impostazioni e valutazione dell'elenco di funzioni proposte

Stato: Accettata (iterazione 3).

## Contesto

- **Invio** ora invia il messaggio (ADR 0012): una scelta che l'utente deve poter cambiare,
  come altre (notifiche, istruzioni per ruolo, file non salvati).
- **L'utente ha portato un elenco di funzioni**, scritto fuori dal progetto, da valutare in
  modo critico: tenere solo ciò che serve davvero.

## Decisione

### Dove vivono le impostazioni

- **Nelle impostazioni native di VS Code** (`contributes.configuration`): utente e cartella,
  Settings Sync e la modifica in `settings.json` vengono da VS Code.
- **Una pagina dedicata** (comando "Only One Chat: Settings", pulsante IMPOSTAZIONI nella chat,
  ingranaggio nella vista Ruoli) le mostra raggruppate e le scrive:
  - ogni voce dice da dove viene il valore: predefinito, utente, cartella;
  - SALVA PER sceglie dove scrivere; RIPRISTINA toglie il valore da lì;
  - percorsi, comandi consentiti e istruzioni per ruolo sono `machine`: mai da una cartella,
    perché un repository clonato non deve poterli cambiare (security.md, T13);
  - solo le chiavi elencate in `src/settings.ts` si possono scrivere, ciascuna verificata sul
    suo tipo;
  - APRI IN VS CODE apre le impostazioni native filtrate sull'estensione.

### Impostazioni nuove

| Chiave                         | Cosa fa                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `leader.instructions`          | Istruzioni dell'utente aggiunte a quelle del leader                      |
| `implementer.instructions`     | Lo stesso per l'implementatore                                           |
| `composer.enterSends`          | Invio invia (Maiusc+Invio a capo); spento: Ctrl+Invio invia              |
| `saveBeforeSend`               | File non salvati della cartella prima di un messaggio: chiedi, salva, no |
| `notifications.waiting`        | Notifica quando un agente aspetta te e la chat non è in vista            |
| `notifications.turnEnd`        | Notifica quando un messaggio è concluso e la chat non è in vista         |
| `notifications.usageThreshold` | Avviso quando una finestra di utilizzo supera la soglia; 0: mai          |

### Elenco proposto: cosa si tiene

Fatto ora, perché piccolo e utile:

- **Cartella come prerequisito (A2):** senza cartella o non attendibile lo stato è NON PRONTO e
  l'invio è spento; APRI CARTELLA; il nome della cartella sotto il titolo.
- **Stato dei provider (A3, in parte):** la vista Ruoli e la pagina dicono se un CLI non c'è o
  non è collegato (Claude: `claude auth status`, Codex: la lettura del catalogo, che verifica
  l'account). In Utilizzo, al posto di "—", il motivo. L'accesso resta da terminale, con il
  comando del CLI: l'estensione non tocca le autenticazioni.
- **Approvazioni (A9, in parte):** la notifica quando un agente si blocca in attesa.
- **Trascrizione (A10):** il messaggio dell'utente è segnato TU; leader e implementatore lo
  erano già; le azioni tecniche erano già raggruppate (ATTIVITÀ).
- **Comandi (A16):** nuova chat, ferma, impostazioni, apri chat nella Command Palette.
- **Istruzioni per ruolo, Invio, notifiche, file non salvati, soglia di utilizzo** (sezione B).

Già presenti:

- **Interruzione (A1):** FERMA ferma l'intero ciclo e nega ciò che aspetta; Invia diventa Ferma.
- **Delega come oggetto (A5):** con "approvo io" la scheda DELEGA mostra il brief completo,
  modificabile, con Approva e Annulla; l'implementatore non parte prima.
- **Stato degli agenti (A8):** la vista Attività (lavora, aspetta te, fermo, l'ultima azione).

Da fare, nell'ordine proposto:

1. **Revisione delle modifiche e checkpoint del codice (A6, A7):** lo stesso meccanismo. Prima di
   ogni turno una copia dei file in un repository ombra nello storage dell'estensione; per ogni
   turno i file cambiati con righe aggiunte e tolte, il diff nativo di VS Code, Accetta o
   Rifiuta per file, il ripristino a un punto. I comandi shell restano fuori, ed è detto.
2. **Contesto nel prompt (A4):** file e cartelle con `@`, il file aperto e la selezione, come
   percorsi (ADR 0011). Le immagini dopo: costano contesto e servono di rado.
3. **Cronologia (A14):** cercare, rinominare, eliminare.
4. **Errori (A13):** Riprova e Copia dettagli.
5. **Messaggi durante l'esecuzione (A15):** solo la coda di un messaggio.

### Elenco proposto: cosa non si tiene, e perché

- **Stop per singolo agente (A1):** lavora un agente alla volta; servirà con gli implementatori
  in parallelo.
- **Ripristino della conversazione (A7):** le sessioni dei CLI non si possono accorciare in modo
  affidabile; un ripristino che lascia il contesto del modello com'era ingannerebbe.
- **Riepilogo di fine turno (A11):** lo danno già i fatti verificati e la revisione del leader;
  un riassunto in più costa un turno.
- **Cicli automatici leader ↔ implementatore (A12, B):** consumano quota senza l'utente; la
  revisione del leader resta, e rimandare è una scelta dell'utente.
- **Correggere la rotta mentre un agente lavora (A15):** dipende da protocolli diversi per CLI;
  prima la coda.
- **Elenco unico delle approvazioni (A9):** le schede sono nel thread e la notifica porta lì.
- **File di istruzioni del progetto da passare (B):** Codex legge già AGENTS.md e Claude
  CLAUDE.md; passarli di nuovo raddoppia il contesto.
- **"Mostra sempre il brief" (B):** è la modalità "approvo io".
- **Rete, accesso fuori cartella, comandi sempre bloccati (B):** cambiano il modello di
  sicurezza; oggi la rete è spenta per Codex, ciò che va fuori cartella si chiede sempre, e
  restano così finché l'utente non decide altrimenti.
- **Provider da mostrare e intervallo di Utilizzo, destinatario predefinito (B):** sono due
  provider, l'intervallo è già prudente, e il destinatario si sceglie sotto il riquadro.
- **Conservazione della cronologia (B):** il limite di 50 chat basta finché la cronologia non
  ha la ricerca.

## Conseguenze

- **Pagina:** `SettingsPanel`, `src/settings.ts`, `webview/Settings.tsx`.
- **La sessione della chat** riceve le istruzioni dell'utente per ruolo, dalla chat successiva.
- **Notifiche:** `src/notifications.ts`.
