# agentloop

> Un runtime agentico piccolo e leggibile. Quattro cose: loop, tool, budget, replay.

```ts
import { Budget, ToolRegistry, openAICompatible, run, usd } from 'agentloop';

const result = await run({
  policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
  tools: new ToolRegistry([cercaVoli]),
  messages: [{ role: 'user', content: 'Quanto costa il volo più economico da Napoli a Roma?' }],
  budget: new Budget(usd(0.15)),   // obbligatorio: vedi sotto
});

result.answer;      // "Il più economico è Wizz a 41 euro."
result.stopReason;  // 'end_turn'
result.spent;       // 0.000214 (µUSD: interi, mai float)
result.trace;       // la traccia, da cui il run si rifà
```

Zero dipendenze runtime. Node ≥ 22.

---

## Il problema

I framework agentici più diffusi risolvono tre cose insieme — il loop, le chiamate al
provider, e un sacco di comodità — e il risultato è che **il loop, che è la parte
difficile, si legge solo leggendo il sorgente del framework**.

Un runtime agentico dovrebbe poter rispondere a quattro domande senza fatica:

1. **Quanto costa questo run, adesso?** Non alla fine: *adesso*.
2. **Cosa è successo?** Non un log: una traccia su cui si può scrivere una prova.
3. **Questo run è rifacibile?**
4. **L'agente ha passato gli argomenti giusti al tool?** Li ha sbagliati almeno una volta.

Sono queste quattro, non il numero di feature, la differenza fra un prototipo e qualcosa
che gira in produzione.

## Cosa fa

- **Loop dichiarativo.** Stato in ingresso, eventi in uscita. Ogni effetto — chiamare un
  provider, eseguire un tool — passa da un'interfaccia.
- **Tool con input validato da JSON Schema.** Gli argomenti sbagliati non raggiungono il
  codice, e l'errore torna al modello in forma leggibile perché se lo corregga.
- **Budget con prenotazione.** Si stima prima, si salda dopo. Il tetto vale **davanti**
  alla spesa, non dopo.
- **Traccia append-only in JSONL.** Con ridazione dichiarata per i tool sensibili.
- **Replay deterministico.** Da una traccia si rifà un run senza toccare la rete.

## Cosa NON fa

| Non fa | Perché no |
|---|---|
| Streaming token-per-token | costa complessità stateful che qui non serve. È il primo candidato quando serve davvero |
| Routing multi-provider, retry, cache | è il compito di [`llmgateway`](../llmgateway) |
| Tool call parallele | rende il riordino degli eventi non deterministico |
| Persistenza, memoria a lungo termine | un runtime senza stato proprio si riusa ovunque |
| UI, logging strutturato, telemetria | non è una libreria di servizio: metti i tuoi adapter |

Il perimetro negato è scritto per intero in [`docs/rfc/0001-perimetro.md`](docs/rfc/0001-perimetro.md).

---

## Le tre garanzie

### 1. Il budget non può essere scavalcato

`budget` è un **parametro obbligatorio**, non opzionale con un default. Un default
verrà dimenticato, e il caso in cui si dimentica è proprio quello di un agente in tondo
che chiama un provider a pagamento. Se il tetto non ti serve, lo dichiari:
`Budget.unlimited()`.

Il meccanismo è prenota → salda:

1. `reserve(estimate)` blocca subito la somma stimata; se non entra, la decisione **non
   viene eseguita** e non costa nulla;
2. la chiamata avviene davvero;
3. `settle(actual)` sostituisce la stima col consumo reale e libera il resto.

Gli importi sono **interi in micro-dollari** con un tipo marchiato. `0.1 + 0.2 !== 0.3`,
e su un fatturato la differenza è un buco. Un modello assente dalla tabella dei prezzi
viene valutato al **massimo** noto, non a zero: prezzo zero significa "il budget
protegge" mentre non protegge niente.

```ts
const budget = new Budget(usd(0.01));
await run({ policy, messages, budget });   // stopReason: 'budget' se non basta
budget.spent;    // mai > limit
```

### 2. Gli argomenti del modello non sono fidati

Un tool che ha ricevuto input sbagliati fallisce in modo comprensibile: l'errore torna
al modello, che lo corregge.

```ts
// il modello ha prodotto { da: 42 }
content: 'ERRORE: Gli argomenti per "cerca_voli" non sono validi (1 problemi):
  - /da: atteso string, ricevuto number 42
Correggi solo i campi indicati e richiama "cerca_voli".'
```

Tutti gli errori insieme, non il primo: altrimenti un modello che sbaglia tre campi
correggerebbe uno alla volta e ci metterebbe tre turni.

E c'è un confine oltre: se un tool solleva un errore **non previsto**, il modello non
vede il testo dell'errore. Vede un messaggio neutro costruito dal runtime. Il motivo è
in [`ADR 0004`](docs/adr/0004-cosa-si-mostra-al-modello.md): un agente riceve quel testo
e lo usa per rispondere a **chiunque stia parlando con lui**.

### 3. Il run si rifà

```ts
const { result, equal, warnings } = await replay(traceJsonl, { tools: registry });
// equal    → true: stessa identica esecuzione, senza rete e senza spendere nulla
// warnings → il tool è cambiato? la traccia non descrive più il suo comportamento
```

Tre modalità, dichiarate da chi chiama:

| modalità | policy | tool | serve per |
|---|---|---|---|
| `full` | dalla traccia | dalla traccia | test di regressione sul loop, audit, demo offline |
| `live-tools` | dalla traccia | **veri** | "cosa cambia se il tool cambia?" |
| `dry-run` | dalla traccia | saltati | quanto del run dipende dai tool? |

Il replay non è un secondo percorso di codice: è **lo stesso loop** con dentro una
`Policy` che legge da disco. È stato possibile solo perché la decisione e l'esecuzione
sono già interfacce.

E se il tool è cambiato, `warnings` lo dice con l'impronta del codice. Una traccia che
riproduce qualcosa di diverso, in silenzio, è una traccia che mente.

---

## Uso

```bash
npm install
npm run ci        # typecheck + lint + test: quello che gira in CI

export OPENAI_API_KEY=...
npm run example                                    # esegue l'agente e scrive la traccia
npx tsx examples/agente-voli.ts --replay traces/agente-voli.jsonl
```

`make ci` esiste e fa la stessa cosa, per chi ha `make`.

## Come è fatto

```
src/
  types.ts      i tipi che attraversano tutto (readonly: lo stato non si muta)
  errors.ts     ogni fallimento ha un tipo
  budget.ts     prenotazione, saldo, micro-dollari
  schema.ts     il sottoinsieme di JSON Schema ammesso
  validate.ts   il validatore: errori strutturati, mai eccezioni
  tool.ts       registro, garanzie all'ingresso, cosa si mostra al modello
  trace.ts      eventi in sola aggiunta, ridazione, degradazione esplicita
  loop.ts       il ciclo
  replay.ts     rifare un run da una traccia
  policy-openai.ts  l'unico file che conosce il mondo esterno
```

Il replay è la prova che la struttura regge: se la `Policy` e i `Tool` non fossero
interfacce, ci sarebbe un secondo ciclo da mantenere, e i due divergerebbero.

## Documenti

- [RFC 0001 — il perimetro](docs/rfc/0001-perimetro.md): cosa fa, cosa no, perché
- [ADR 0001](docs/adr/0001-loop-come-riduttore.md): il loop è stato in, eventi fuori
- [ADR 0002](docs/adr/0002-validatore-json-schema.md): validatore in casa, in un sottoinsieme
- [ADR 0003](docs/adr/0003-replay-e-tool.md): le tre modalità di replay
- [ADR 0004](docs/adr/0004-cosa-si-mostra-al-modello.md): cosa può finire davanti a un modello
- [ADR 0000](docs/adr/0000-record-architecture-decisions.md): come si scrivono le ADR

Le decisioni valgono quanto il codice: se una è sbagliata, il codice è una conseguenza.

## Cosa farei diversamente

- **Streaming.** L'ho escluso per il perimetro, ma è la cosa che un utente nota per
  prima e un runtime agentico senza feels finto. Entra per prima.
- **Tool in parallelo.** Escluderlo mi ha reso il replay deterministico con poco sforzo.
  Ma un agente che deve leggere cinque file in parallelo è un caso reale, e lì
  l'ordine degli eventi va deciso esplicitamente, non ereditato.
- **`Budget.unlimited()` è una porta**. Esiste perché obbligare il tetto senza dare
  una via d'uscita onesta produce `new Budget(1e18)` sparso ovunque. Va bene così,
  ma se in futuro serve un audit, un budget dichiarato `unlimited` dovrebbe farsi
  notare da solo.
- **L'impronta del tool copre solo il corpo di `execute`**, non gli helper importati. Un
  cambiamento dentro un helper non invalida la traccia. Ho scelto il limite perché
  l'alternativa (hash del grafo di import) costa più del beneficio.
- **Le decisioni di una `Policy` non sono ispezionabili.** Posso registrare la traccia e
  il costo, non il ragionamento. Chi vorrà capire *perché* ha scelto un tool dovrà
  mettere mano al provider.

## Sviluppo

```bash
git clone git@github.com:paoValle/agentloop.git && cd agentloop
npm ci && npm run ci
```

## Licenza

MIT © Paolo Valletta