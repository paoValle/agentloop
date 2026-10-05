/**
 * Runnable example: an agent that looks for a flight and must **say when it does not
 * know**.
 *
 * It demonstrates the three things this runtime lines up:
 *
 *  1. tools have a schema, and wrong arguments never reach the code;
 *  2. the budget is a cap, and when it runs out the run ends — it does not go on at
 *     someone else's expense;
 *  3. the trace remains, and from that trace the run is redone without calling anyone.
 *
 * Run it with:
 *
 * ```bash
 * export OPENAI_API_KEY=...
 * npx tsx examples/flight-agent.ts
 * npx tsx examples/flight-agent.ts --replay traces/flight-agent.jsonl
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Budget, Trace, ToolError, ToolRegistry, openAICompatible, replay, run, usd } from '../src/index.js';
import type { Tool } from '../src/index.js';

const PRICES = {
  // µUSD per million tokens. The source is the provider price lists: they are here
  // because a runtime must be able to say what things cost, and the table is part of
  // the contract, not an internal constant to derive it from.
  'gpt-4o-mini': { input: usd(0.15), output: usd(0.6) },
  'gpt-4o': { input: usd(2.5), output: usd(10) },
};

interface Flight {
  airline: string;
  from: string;
  to: string;
  price: number;
}

const searchFlights: Tool<{ from: string; to: string }, Flight[]> = {
  name: 'search_flights',
  description:
    'Searches the cheapest flights between two airports. Returns a list of flights sorted by increasing price.',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'IATA code of departure, e.g. NAP' },
      to: { type: 'string', description: 'IATA code of arrival, e.g. FCO' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  execute: ({ from, to }) => {
    if (from === to) {
      // ToolError: this message is written to be read by the model, which will be
      // able to ask for another route. An "unexpected" error would not have reached
      // the model (ADR 0004).
      throw new ToolError(`Departure and arrival coincide (${from}): no flight to search for.`);
    }
    return [
      { airline: 'ITA', from, to, price: 90 },
      { airline: 'easyJet', from, to, price: 54 },
      { airline: 'Wizz', from, to, price: 41 },
    ];
  },
};

const API_KEY = process.env['OPENAI_API_KEY'];

async function main(): Promise<void> {
  const [mode, tracePath] = process.argv.slice(2);

  // --- replay: no network, no cost, and the same answer as yesterday ---
  if (mode === '--replay' && tracePath !== undefined) {
    const { readFileSync } = await import('node:fs');
    const { result, equal, warnings } = await replay(readFileSync(tracePath, 'utf8'), {
      tools: new ToolRegistry([searchFlights]),
    });
    console.log(`replay identical to the original: ${equal ? 'yes' : 'NO'}`);
    for (const warning of warnings) console.warn(`  warning: ${warning.message}`);
    console.log(`answer: ${result.answer ?? '(none)'}`);
    return;
  }

  if (API_KEY === undefined) {
    console.error('OPENAI_API_KEY is required. Or run with --replay <trace.jsonl>.');
    process.exitCode = 1;
    return;
  }

  const trace = new Trace();
  const result = await run({
    policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: API_KEY, maxOutputTokens: 500 }),
    tools: new ToolRegistry([searchFlights]),
    messages: [
      { role: 'system', content: 'Answer in English, in at most three sentences. Quote the prices.' },
      { role: 'user', content: 'How much does the cheapest flight from Naples to Rome cost?' },
    ],
    // the cap is required: 15 cents is enough for three steps and not for twenty
    budget: new Budget(usd(0.15)),
    prices: PRICES,
    maxSteps: 5,
    trace,
    runId: 'flight-agent',
  });

  console.log(result.answer ?? '(no answer)');
  console.log(`— ${result.steps} steps, ${result.stopReason}, ${(result.spent / 1_000_000).toFixed(6)} USD`);

  // the trace is the artifact that makes everything reproducible: it is always written
  const path = 'traces/flight-agent.jsonl';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, trace.toJSONL());
  console.log(`trace: ${path} — review it with: npx tsx examples/flight-agent.ts --replay ${path}`);
}

await main();
