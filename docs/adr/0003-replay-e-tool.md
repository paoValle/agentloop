# ADR 0003 — Il replay rifa i tool, con una via d'uscita

- **Stato:** accettata
- **Data:** 2026-10-04
- **Decide:** Paolo Valletta

## Contesto

Una traccia contiene tutto quello che è successo in un run: la risposta del modello,
gli argomenti passati al tool, il suo risultato. Due replay possibili:

- **replay della sola politica**: si ricalcolano le decisioni del modello dalla
  traccia, ma i tool **girano davvero**;
- **replay completo**: anche i risultati dei tool arrivano dalla traccia, il codice
  dei tool non viene eseguito.

Non sono equivalenti, e la scelta cambia a chi serve il replay.

Il replay completo serve per **test di regressione sul loop**: "se il loop cambia,
la sequenza di decisioni cambia?". Ma è inutile se il tool ha dipendenze esterne
e il replay completo le evita: si può testare il loop senza rete né database.

Il replay della sola politica serve per **capire cosa succederebbe**: "se la mia
modifica alla policy cambiasse la decisione, quale sarebbe?". Qui i tool devono
girare, altrimenti la risposta è falsa.

Il problema: una sola semantica non va bene per entrambi.

## Decisione

Il replay ha **tre modalità**, dichiarate dall'utente:

| Modalità | Policy | Tool | Serve per |
|---|---|---|---|
| `full` | dalla traccia | dalla traccia | test di regressione sul loop, audit, demo offline |
| `live-tools` | dalla traccia | **eseguiti davvero** | "cosa succederebbe se il tool cambiasse?" |
| `dry-run` | dalla traccia | **saltati**, risultato dalla traccia ma ignorato | misurare quanto del run dipende dai tool |

Ogni evento di tool nella traccia porta il `name` del tool e un **hash del suo
codice sorgente** (`tool.fingerprint`). In modalità `full`/`dry-run`, se il
fingerprint del tool attuale non corrisponde a quello registrato, il replay **non
fallisce in silenzio**: segnala un avviso che il risultato è di una versione
diversa del tool. Il fallback silenzioso è il modo in cui una traccia diventa una
bugia.

## Alternative

| Opzione | Pro | Contro | Perché no |
|---|---|---|---|
| solo replay completo | semplice, deterministico | un test sul loop non distingue "il loop è cambiato" da "il tool è cambiato" | il falso verde è il rischio peggiore di un test |
| solo replay con tool live | replay utile | non testabile offline, non deterministico | non soddisfa l'obiettivo di riproducibilità |
| replay con VCR (registra HTTP) | intercetta a livello di rete | perde i tool puri, non locali, e lega la traccia a una libreria | la granularità giusta è il **tool**, non la richiesta HTTP |

## Conseguenze

**Si vince:**
- un test vero sul loop: `replay(trace, 'full')` e l'uguaglianza dello stato finale;
- un modo per valutare una modifica alla policy senza spendere token;
- la traccia resta onesta: ogni replay dichiara da dove vengono i dati.

**Si paga:**
- l'hash del codice del tool nel fingerprint: se cambi una riga del tool, la
  traccia "invecchia". È il comportamento voluto, e l'avviso lo dice.
- `live-tools` **non è deterministico** per definizione: va usato solo in
  ambienti dove si accetta, e i suoi confronti sono informativi, non assertivi.

## Verifica

Il test `replay.test.ts` deve avere almeno un caso che cambia il tool e verifica
che l'avviso compaia. Se non c'è, il fallback silenzioso rientra e questa ADR va
rivista.