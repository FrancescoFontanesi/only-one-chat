# 0002. Riuso dei sorgenti di riferimento: solo reimplementazione

- Stato: Accettata (2026-10-18)

## Contesto

L'obiettivo è un progetto indipendente, pubblicabile liberamente sotto MIT, senza
obblighi verso altri progetti. I riferimenti sono MIT (usturlab, Augani, VS Code samples)
e Apache-2.0 (Codex). Entrambe le licenze permettono il riuso, ma **obbligano** a conservare
i copyright notice nelle "porzioni sostanziali" copiate. Apache-2.0 richiede in più di
conservare il NOTICE e di indicare le modifiche. L'unico modo per non avere obblighi di
attribuzione è non copiare codice.

## Decisione

1. Dai riferimenti si prendono **idee, architetture, pattern e comportamenti osservabili**.
   Non si prende codice copiato, tradotto riga per riga o parafrasato in modo meccanico.
2. Il codice si scrive partendo dai requisiti di questo progetto, senza tenere aperto
   il file di riferimento come modello da trascrivere.
3. Sono ammesse senza attribuzione le parti non proteggibili o ovvie: nomi dei messaggi
   di un protocollo, formati dei dati, flag dei CLI e pattern standard dell'API VS Code
   documentati da Microsoft (per esempio la CSP con nonce).
4. Se in futuro un riuso diretto diventasse davvero conveniente, serve un nuovo ADR
   approvato dall'utente che lo autorizzi caso per caso, con `THIRD_PARTY_NOTICES.md`.
5. Nessun codice proveniente da estensioni proprietarie (per esempio l'estensione
   ufficiale di Codex), nemmeno come riferimento di lettura.

## Conseguenze

- Il repository resta MIT senza notice di terze parti (fatta eccezione per le dipendenze
  npm, che hanno le loro licenze e non sono incluse nel repository).
- Chiunque lavori sul repo, persone o agenti, deve rispettare questa regola.
- La licenza MIT del progetto è provvisoria e va confermata prima di una distribuzione
  pubblica.
