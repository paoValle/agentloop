# ADR 0004 — Al modello si mostra l'errore che l'autore del tool ha scritto, e nient'altro

- **Stato:** accettata
- **Data:** 2026-10-04
- **Decide:** Paolo Valletta

## Contesto

Un tool che fallisce non interrompe il run: l'errore viene rimesso in `role: 'tool'`
e il modello decide cosa fare. Perché funzioni, il messaggio deve essere utile al
modello.

Il punto delicato è *cosa metterci dentro*. Il riflesso è metterci `error.message`.
Ma le eccezioni non strutturate vengono da tutto: un `ECONNREFUSED`, un
`Invalid API key`, una query SQL con i nomi delle tabelle, un path del filesystem.
Un agente riceve quel testo e lo usa per rispondere a **chiunque stia parlando con
lui**: se il chiamante è un utente finale, la chiave dell'API finisce in una
risposta. Non serve un attaccante: basta un agente che racconta cosa ha trovato.

Dall'altra parte, un messaggio troppo generico ("errore interno") è uselesse: il
modello non può correggere quello che non può vedere.

## Decisione

Due classi di errore, due trattamenti.

**`ToolError`** è l'errore che l'autore del tool ha scritto **per essere letto dal
modello**. Va interamente nel messaggio, più la sua `cause` se ce l'ha. Chi scrive
il tool sa cosa sta dicendo.

**Qualsiasi altro errore** — `TypeError`, `Error` di una libreria, errore di rete —
 diventa un messaggio **neutro e costruito dal runtime**, con l'errore vero che va
soltanto in traccia. Il modello vede:

```
il tool "carica_ordini" è fallito con un errore interno (riferimento: step-3/tool-1).
Riprova con gli stessi argomenti una sola volta; se fallisce ancora, spiega all'utente
che il servizio non è disponibile.
```

Il testo è lo stesso per ogni tool: non può trapelare nulla, perché non contiene
nulla del tool. Il `riferimento` correla con la traccia, dove c'è la causa.

## Alternative

| Opzione | Pro | Contro | Perché no |
|---|---|---|---|
| sempre `error.message` | massimo dettaglio, meno attrito | qualunque errore non previsto diventa un canale di fuga verso l'esterno | il caso raro è quello che non hai previsto |
| sempre generico | nessuna fuga | il modello non può correggere nemmeno gli errori di validazione, che sono già sicuri | si butta via l'unico caso recuperabile |
| filtro a parole chiave (`key`, `token`, `password`) | sembra prudente | è una blacklist: il primo messaggio nuovo la supera. Falso senso di sicurezza | il confine giusto è la provenienza dell'errore, non il suo testo |

## Conseguenze

**Si vince:**
- un `ToolError` diventa l'unico modo intenzionale di dire qualcosa al modello. La
  separazione è esplicita nel codice, non convenzionale;
- l'autore di un tool deve dichiarare, scrivendo la classe, che quel messaggio è
  destinato a un lettore non fidato;
- la traccia conserva la causa, quindi il debug non perde nulla.

**Si paga:**
- il 90% dei tool dovrà scrivere `ToolError` esplicitamente per i propri errori
  attesi. È la parte più noiosa e anche quella più importante;
- un `ToolError` scritto male è comunque una fuga. Nessun tipo ti salva da un autore
  che scrive `"key sk-..."` dentro un `ToolError`: qui conta la review.

## Verifica

Un test deve prendere un tool che solleva `Error("token sk-live-123")` e verificare
che la stringa `sk-live-123` **non** finisca nel messaggio. Se un giorno quel test
richiede modifiche, il confine si è spostato e questa ADR va aggiornata.