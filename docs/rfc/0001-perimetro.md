# RFC 0001 — Il perimetro di `agentloop`

> Prima di scrivere una riga di codice: di cosa si parla, cosa no, e perché.
> Stato: **accettato**. Le decisioni tecniche che ne discendono stanno in `../adr/`.

## Il problema

I framework agentici più diffusi risolvono tre cose insieme: il loop, le
chiamate al provider, e un sacco di comodità (memoria, retry, streaming,
telemetria, un'interfaccia "agentica"). Il risultato è che il loop — che è la
parte difficile — diventa **leggibile solo se si legge il sorgente del framework**.

Le domande che un runtime agentico dovrebbe poter rispondere senza fatica:

1. **Quanto costa questo run, adesso?** Non "alla fine", *adesso*. Un agentic loop
   che chiama un tool dieci volte prima di accorgersi di aver sforato è un incidente
   finanziario, non un bug.
2. **Cosa è successo?** Non un log testuale: una **traccia append-only** che si
   può riaprire, e su cui si può scrivere una prova.
3. **Questo run è rifacibile?** Se un agente ha fatto una cosa sbagliata, la
   domanda utile non è "perché" ma **"rifaccio il run con la stessa politica e gli
   stessi input, e ottengo lo stesso output?"**
4. **L'agent ha passato gli argomenti giusti al tool?** I tool sono chiamati da un
   modello che ha sbagliato almeno una volta. La validazione non è opzionale.

## Cosa fa

- Un **loop** dichiarativo: stato in ingresso, eventi in uscita, nessuna magia implicita.
- **Tool** con input validato da JSON Schema, errori che tornano al modello come
  messaggio (perché si autocorregga) invece di far esplodere il processo.
- **Budget** con prenotazione: si stima prima, si salda dopo. Il costo si misura in
  micro-dollari interi, mai in `float`.
- **Traccia** append-only in JSONL, con ridazione dichiarata per campo.
- **Replay** deterministico: si riesegue un run da una traccia senza toccare la rete.

## Cosa NON fa (perimetro negato)

| Non fa | Perché no |
|---|---|
| Streaming token-per-token | Costa complessità stateful che qui non serve. È il primo candidato quando serve davvero. |
| Routing multi-provider | È il compito di `llmgateway`. Due responsabilità = due bug. |
| Tool call parallele | Rende il riordino degli eventi non deterministico. Via fino a quando non serve. |
| Persistenza / memoria a lungo termine | Un runtime senza stato proprio si riusa ovunque. |
| UI, logging strutturato, telemetria | Non è una libreria di servizio. Chi la usa mette i suoi adapter. |

## Il contratto di successo

Il progetto è finito quando:

- [ ] un run completo si riesegue da traccia e produce lo **stesso stato finale**, test incluso
- [ ] il budget **non può** essere superato, nemmeno in caso di tool che parlano a provider a pagamento
- [ ] un argomento di tool invalido produce un errore **leggibile** e il loop continua
- [ ] `make ci` verde: typecheck strict, lint, test
- [ ] il README si legge da capo a fondo in cinque minuti

## Alternative scartate

- **Adottare un framework esistente** e impararlo: più rapido oggi, ma il GitHub
  continua a non mostrare *niente* di mio. L'obiettivo del portfolio è che il
  codice sia mio e lo sappia spiegare.
- **Scrivere solo un `while` con `openai`**: quattro righe e zero segnale. Il
  valore sta nei confini (budget, validazione, replay), non nel loop.

## Domande aperte

- Il replay deve rifare i **tool** o solo la **politica**? Rifare i tool è più
  utile per testare il loop, ma non è sempre possibile (il provider esterno è
  stato cancellato). → risolto in ADR 0003, con un flag.
- Serve streaming per il caso d'uso voce? Sì, ma in `voicebridge`, dove il
  vincolo di latenza è diverso. Qui no.