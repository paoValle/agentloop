# ADR 0002 — Validazione JSON Schema fatta in casa, in un sottoinsieme

- **Stato:** accettata
- **Data:** 2026-10-04
- **Decide:** Paolo Valletta

## Contesto

Gli argomenti di un tool li produce un modello. Sono dati non fidati: sbagliano
formato, tipo, e valori. Senza validazione, un tool che si aspetta `{ from: date, to: date }`
si trova `{ from: "ieri", to: 2026 }` e deve indovinare.

Il library di validazione JSON Schema più diffuso in TypeScript è `ajv`, che è
~120 kB installati ed è di fatto **un progetto a sé**: bundle size, plugin per ogni
parola chiave, documentazione propria. Per un runtime che vuole stare sotto le
1000 righe, è il collo di bottiglia più grande del progetto.

Il punto però non è la dimensione: è che **gli errori di validazione diventano
l'input della correzione dell'agente**. Il modello deve leggere un messaggio tipo
`args.to: atteso string ISO-8601, ricevuto 2026` e correggere. Quindi l'API deve
restituire una **lista di errori con percorso e messaggio**, non lanciare un'eccezione
opaca da mostrare a uno sviluppatore.

## Decisione

Validatore scritto a mano, che copre un **sottoinsieme esplicito** di JSON Schema
Draft 2020-12, con due proprietà non negoziabili:

1. **errori strutturati**, mai eccezioni:
   ```ts
   validate(schema, value): ValidationError[]   // vuoto = valido
   ```
   con `ValidationError = { path: string; message: string }` e `path` in notazione
   JSON Pointer (`/args/to`), perché il modello deve poter citare il campo.
2. **sottoinsieme dichiarato e testato**: `type`, `properties`, `required`,
   `additionalProperties`, `enum`, `items`, `minimum`, `maximum`, `minLength`,
   `maxLength`, `minItems`, `maxItems`, `anyOf`. Niente `oneOf`, niente `if/then`,
   niente `$ref`, niente regex patterns.

Una parola chiave non supportata è un **errore di sviluppo esplicito** (lancia
all'avvio, non a runtime su un input dell'utente): se qualcuno scrive
`"pattern": "^\\d+$"` in uno schema di tool, deve accorgersene subito, non
scoprire che il campo non veniva validato in produzione.

## Alternative

| Opzione | Pro | Contro | Perché no |
|---|---|---|---|
| `ajv` | completo, battle-tested, supporta ogni parola chiave | ~120 kB, plugin per keyword, API pensata per l'eccezione | i 4 errori che ci servono li si scrive in 120 righe |
| `zod` | ottima DX, inferenza di tipo | i tipi statici sono già coperti da TS; doppio sistema di validazione | sovrapposizione con `validate` e con il compilatore |
| validazione a mano per tool | zero codice | ogni tool riscrive gli stessi controlli, e sbaglia in modo diverso | si paga N volte invece di una |
| JSON Schema completo | no sorprese | ~2000 righe, sottoinsiemi di pattern, `$ref` remoto, formati | è un progetto, non un modulo |

## Conseguenze

**Si vince:**
- zero dipendenze, quindi zero CVE da seguire e zero discussioni in review;
- il formato dell'errore è **nostro**, quindi possiamo scrivere il messaggio in
  modo che un modello lo capisca e lo corregga (è metà del valore di questo progetto);
- ogni parola chiave supportata ha un test, e il set è leggibile in 30 secondi.

**Si perde:**
- gli schemi con `$ref` o `oneOf` non vanno bene: gli autori dei tool devono
  tenersene lontani. È scritto nel README e nei docstring;
- se un giorno servono i formati (`format: date-time`), il sottoinsieme cresce —
  e quando cresce, `ajv` torna sul tavolo. **È un prezzo, non un dogma**: se il
  sottoinsieme supera la metà del codice del progetto, la decisione va rivista.

## Verifica

Se i tool reali che ho scritto hanno iniziato a duplicare controlli a mano, o se
`validate` supera le 250 righe, il sottoinsieme è sbagliato: si rivaluta `ajv`.