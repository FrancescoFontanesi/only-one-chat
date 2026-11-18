# 0025. Trovare gli eseguibili dei CLI dalle impostazioni

Stato: Accettata (iterazione 3).

## Contesto

- **Sezione Provider:** la pagina delle impostazioni chiedeva di scrivere a mano il percorso di
  Codex e di Claude Code, e non aveva Antigravity.
- **Dove stanno i CLI:** spesso non sono nel PATH, ma nelle estensioni dei provider:
  `openai.chatgpt` porta con sé `bin/<piattaforma>/codex.exe`, `anthropic.claude-code` porta
  `resources/native-binary/claude.exe`. Il programma d'installazione di Antigravity mette `agy`
  in `%LOCALAPPDATA%\agy\bin`.

## Decisione

1. **Provider accettati:** Codex, Claude Code e Antigravity, per ora solo questi tre. Il
   protocollo rifiuta ogni altro nome.
2. **Ogni percorso ha tre modi di essere impostato:**
   - **RILEVA:** cerca nel PATH, poi nei posti noti dell'estensione o del programma
     d'installazione del provider;
   - **SELEZIONA:** apre l'esplora risorse su una cartella e cerca l'eseguibile lì e nella sua
     `bin`;
   - **a mano**, come prima.
3. **Stessa ricerca dell'avvio:** si usa `resolveNativeExecutable`, la stessa usata prima di un
   turno, quindi un lanciatore `.cmd` o `.ps1` resta rifiutato. Non si esegue nulla: un percorso
   si scrive solo se lì c'è un eseguibile.
4. **Dove si scrive:** nelle impostazioni dell'utente, mai in quelle di una cartella (sono
   impostazioni con ambito `machine`).

## Conseguenze

- **Versione dell'estensione:** VS Code dà il percorso della versione attiva di un'estensione.
  Dopo un aggiornamento dell'estensione il percorso salvato punta alla versione vecchia, finché
  non si preme di nuovo RILEVA o non la si rimuove; in quel caso l'avvio segnala che l'eseguibile
  manca.
