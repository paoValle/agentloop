# ADR 0001 — Il loop è un riduttore: stato in, eventi fuori

- **Stato:** accettata
- **Data:** 2026-10-04
- **Decide:** Paolo Valletta

## Contesto

Il cuore di un runtime agentico è un ciclo che alterna due azioni: chiedere una
decisione a un modello, ed eseguire un tool in base alla decisione. Le implementazioni
più diffuse lo scrivono come codice imperativo che chiama direttamente il provider
e il tool:

```ts
while (true) {
  const res = await client.chat({ messages, tools });   // effetto: rete
  if (res.toolCall) await tools[res.toolCall.name](res.toolCall.args);  // effetto: mondo
  else return res.text;
}
```

Questa forma è comoda da scrivere e scomoda da tutto il resto:

- non puoi **riprodurre** il run se non riesi a chiamare il provider, che costa soldi
  e cambia risposta a ogni chiamata;
- non puoi **testare** il loop senza una rete o un mock goffo;
- non puoi sapere **a che punto** del run sei senza having letto ogni riga;
- un errore dentro un tool ti lascia in metà run, con stato inconsistente in memoria.

## Decisione

Il loop è una **funzione di riduzione esplicita**: riceve lo stato, produce un
elenco di **eventi**, e ogni effetto (chiamata al provider, esecuzione del tool)
passa da un'interfaccia che può essere sostituita con una versione che legge dalla
traccia.

In termini pratici:

- lo stato del run è un **oggetto nuovo** a ogni passo, mai mutato;
- ogni cosa che tocca il mondo esterno è una `Policy` (decide) o un `Tool` (agisce),
  entrambe interfacce;
- ogni passo produce un `TraceEvent` **prima** di produrre il passo successivo:
  la traccia è il log, non un'aggiunta;
- il replay è la stessa funzione con una `Policy` e un `ToolRegistry` riempiti
  dalla traccia. Non esiste un secondo percorso di codice da mantenere.

## Alternative

| Opzione | Pro | Contro | Perché no |
|---|---|---|---|
| Imperativo diretto | meno codice, si legge subito | non riproducibile, testabile solo con mock fragili | il replay e il test sono il punto |
| Redux-style con reducer puro | già risolto, librerie note | 3 dipendenze e un concetto in più per un ciclo di 5 step | l'idea è giusta, il framework è sovrabbondante |
| Event sourcing completo, ogni passo persistito | riproducibile al 100% | persistenza, GC, snapshot: complessità che non ripaghi al primo uso | la traccia in memoria + JSONL copre il 90% dei casi |

## Conseguenze

**Diventa possibile:**
- riprodurre un run e **assertare** che lo stato finale è identico → un test vero,
  non una verifica a occhio;
- testare il loop con una `Policy` scriptata, senza rete e senza sleep;
- ispezionare un run a metà, perché gli eventi sono già scritti;
- mettere in produzione una traccia e rianalizzarla offline.

**Diventa impossibile o scomodo:**
- usare il loop senza tenere traccia: non è il default, è il costo fisso;
- aggiungere uno shortcut "chiama il provider e basta": non c'è il buco in cui infilarlo.

**Il costo reale:** uno stato in più da modellare e una serializzazione in più da
scrivere. Lo pago per intero al primo run riprodotto, e non lo pago affatto se il
progetto resta una libreria locale.

## Verifica

Se fra tre mesi non c'è un test che rilegga una traccia e affermi l'uguaglianza
dello stato finale, questa decisione era un peso inutile: va rivista.