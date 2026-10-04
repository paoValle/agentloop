/**
 * Esempio eseguibile: un agente che cerca un volo e deve **dire quando non sa**.
 *
 * Dimostra le tre cose che questo runtime mette in fila:
 *
 *  1. i tool hanno uno schema, e gli argomenti sbagliati non arrivano al codice;
 *  2. il budget è un tetto, e quando finisce il run finisce — non va avanti a spese
 *     di qualcun altro;
 *  3. la traccia resta, e da quella traccia il run si rifà senza chiamare nessuno.
 *
 * Eseguilo con:
 *
 * ```bash
 * export OPENAI_API_KEY=...
 * npx tsx examples/agente-voli.ts
 * npx tsx examples/agente-voli.ts --replay traces/agente-voli.jsonl
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Budget, Trace, ToolError, ToolRegistry, openAICompatible, replay, run, usd } from '../src/index.js';
import type { Tool } from '../src/index.js';

const PREZZI = {
  // µUSD per milione di token. La fonte sono i listini del provider: stanno qui
  // perché un runtime deve poter dire quanto costa, e la tabella è parte del
  // contratto, non una costante interna da cui dedurla.
  'gpt-4o-mini': { input: usd(0.15), output: usd(0.6) },
  'gpt-4o': { input: usd(2.5), output: usd(10) },
};

interface Volo {
  compagnia: string;
  partenza: string;
  arrivo: string;
  prezzo: number;
}

const cercaVoli: Tool<{ da: string; a: string }, Volo[]> = {
  name: 'cerca_voli',
  description:
    'Cerca i voli più economici fra due aeroporti. Restituisce una lista di voli ordinata per prezzo crescente.',
  schema: {
    type: 'object',
    properties: {
      da: { type: 'string', description: 'codice IATA della partenza, es. NAP' },
      a: { type: 'string', description: 'codice IATA dell’arrivo, es. FCO' },
    },
    required: ['da', 'a'],
    additionalProperties: false,
  },
  execute: ({ da, a }) => {
    if (da === a) {
      // ToolError: questo messaggio è scritto per essere letto dal modello, che
      // potrà chiedere un'altra rotta. Un errore "non previsto" non avrebbe
      // raggiunto il modello (ADR 0004).
      throw new ToolError(`Partenza e arrivo coincidono (${da}): nessun volo da cercare.`);
    }
    return [
      { compagnia: 'ITA', partenza: da, arrivo: a, prezzo: 90 },
      { compagnia: 'easyJet', partenza: da, arrivo: a, prezzo: 54 },
      { compagnia: 'Wizz', partenza: da, arrivo: a, prezzo: 41 },
    ];
  },
};

const CHIAVE = process.env['OPENAI_API_KEY'];

async function main(): Promise<void> {
  const [modalita, percorsoTraccia] = process.argv.slice(2);

  // --- replay: nessuna rete, nessun costo, e la stessa risposta di ieri ---
  if (modalita === '--replay' && percorsoTraccia !== undefined) {
    const { readFileSync } = await import('node:fs');
    const { result, equal, warnings } = await replay(readFileSync(percorsoTraccia, 'utf8'), {
      tools: new ToolRegistry([cercaVoli]),
    });
    console.log(`replay identico all'originale: ${equal ? 'sì' : 'NO'}`);
    for (const avviso of warnings) console.warn(`  avviso: ${avviso.message}`);
    console.log(`risposta: ${result.answer ?? '(nessuna)'}`);
    return;
  }

  if (CHIAVE === undefined) {
    console.error('Serve OPENAI_API_KEY. Oppure esegui con --replay <traccia.jsonl>.');
    process.exitCode = 1;
    return;
  }

  const trace = new Trace();
  const result = await run({
    policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: CHIAVE, maxOutputTokens: 500 }),
    tools: new ToolRegistry([cercaVoli]),
    messages: [
      { role: 'system', content: 'Rispondi in italiano, in massimo tre frasi. Cita i prezzi.' },
      { role: 'user', content: 'Quanto costa il volo più economico da Napoli a Roma?' },
    ],
    // il tetto è obbligatorio: 15 centesimi sono abbastanza per tre passi e non per venti
    budget: new Budget(usd(0.15)),
    prices: PREZZI,
    maxSteps: 5,
    trace,
    runId: 'agente-voli',
  });

  console.log(result.answer ?? '(nessuna risposta)');
  console.log(`— ${result.steps} passi, ${result.stopReason}, ${(result.spent / 1_000_000).toFixed(6)} USD`);

  // la traccia è l'artefatto che rende il tutto riproducibile: si scrive sempre
  const percorso = 'traces/agente-voli.jsonl';
  mkdirSync(dirname(percorso), { recursive: true });
  writeFileSync(percorso, trace.toJSONL());
  console.log(`traccia: ${percorso} — rivedila con: npx tsx examples/agente-voli.ts --replay ${percorso}`);
}

await main();