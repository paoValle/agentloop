/**
 * Il loop.
 *
 * Un passo, in ordine fisso e senza scorciatoie:
 *
 *   1. prenota il costo del passo nel budget — se non entra, il run finisce **qui**,
 *      senza che nessuno abbia speso nulla;
 *   2. chiedi una decisione alla `Policy`;
 *   3. salda sul consumo reale, che può essere più basso della stima;
 *   4. se la decisione è un tool, validalo, eseguilo, e metti il risultato nel
 *      contesto — riuscito o fallito, il fallimento è un messaggio;
 *   5. se la decisione è un messaggio, il run è finito.
 *
 * Ogni passo produce eventi di traccia **prima** del passo successivo. La traccia
 * non è un accessorio che si scrive alla fine: è il modo in cui il loop sa dove si
 * trova (ADR 0001).
 */

import { Budget, costOf, formatUsd, micros, type MicroUsd, type Price, type PriceTable } from './budget.js';
import { BudgetExceededError, PolicyError } from './errors.js';
import { Trace, prepareForTrace, redact, traceableCall } from './trace.js';
import { ToolRegistry, invokeTool } from './tool.js';
import type { Message, Policy, PolicyOutcome, StopReason, ToolCall } from './types.js';

/** Prezzi noti, per modello. Un modello assente viene valutato peggio di tutti. */
export type { PriceTable };

/**
 * Quanto si prenota prima di un passo.
 *
 * Non si può conoscere il costo di una chiamata prima di farla. La prima stima è
 * una soglia configurata; dalla seconda in poi diventa il **massimo realmente
 * osservato** nel run. Un agente che a un passo usa 800 token e al successivo 40.000
 * smette di farsi trovare corto da un medio, e la previsione resta un tetto.
 */
export interface Estimation {
  /** Stima per un passo ancora senza dati: il default è 5 ¢. */
  stepAllowance: MicroUsd;
  /** Il massimo osservato finora nel run, se c'è. */
  observedMax?: MicroUsd;
}

export interface RunOptions {
  /** Chi decide. Deve dichiarare il proprio modello: un budget che non sa il prezzo non è un budget. */
  readonly policy: Policy;
  /** Il contesto iniziale. Obbligatorio: un run senza messaggi non ha senso. */
  readonly messages: readonly Message[];
  /** I tool raggiungibili dal modello. Di default, nessuno. */
  readonly tools?: ToolRegistry;
  /**
   * Il tetto di spesa. **Obbligatorio**.
   *
   * Un run senza tetto è un run che può spendere quanto gli pare. Renderlo opzionale
   * con un default significa che il default verrà dimenticato, e il caso in cui si
   * dimentica è proprio quello di un agente in tondo che chiama un provider a
   * pagamento. Se il tetto non ti serve, dichiaralo: `Budget.unlimited()`.
   */
  readonly budget: Budget;
  /** Tetto di passi. Di default 12: oltre, un agente sta girando in tondo. */
  readonly maxSteps?: number;
  /** Traccia in cui scrivere. Di default, una traccia nuova in memoria. */
  readonly trace?: Trace;
  /** Prezzi per modello. Vedi `resolvePrice`. */
  readonly prices?: PriceTable;
  /** Stima iniziale per un passo. Di default 5 ¢. */
  readonly stepAllowance?: MicroUsd;
  /** Identificatore del run, per correlare log e tracce. */
  readonly runId?: string;
  /** Cancellazione. Viene rispettata a ogni passo e passata a policy e tool. */
  readonly signal?: AbortSignal;
}

/** Com'è finito un run. */
export interface RunResult {
  /** La conversazione completa, compresi i messaggi `tool`. */
  readonly messages: readonly Message[];
  /** Quanti passi sono stati eseguiti. */
  readonly steps: number;
  /** Perché è finito. Sempre valorizzato: un run che finisce "non si sa" è un bug. */
  readonly stopReason: StopReason;
  /** Denaro effettivamente speso. */
  readonly spent: MicroUsd;
  /** Il testo finale, se il run è finito con `end_turn`. */
  readonly answer?: string;
  /** La traccia. Sempre presente, anche se il run è esploso. */
  readonly trace: Trace;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_STEP_ALLOWANCE = micros(50_000);

/**
 * Esegue un run.
 *
 * Non lancia per gli errori *del run* (budget esaurito, passo massimo, cancellazione):
 * sono esiti, e tornano dentro `RunResult`. Lancia solo ciò che è un bug o un
 * guasto — una `Policy` che non risponde, un contesto malformato.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const tools = options.tools ?? new ToolRegistry();
  const budget = options.budget;
  const trace = options.trace ?? new Trace();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const prices = options.prices ?? {};
  const model = options.policy.model;

  if (options.messages.length === 0) {
    throw new TypeError('un run ha bisogno di almeno un messaggio iniziale');
  }
  if (model === undefined) {
    throw new TypeError('la Policy non dichiara il suo modello: senza il prezzo il budget non può funzionare');
  }

  const price = resolvePrice(prices, model);
  const estimation: Estimation = {
    stepAllowance: options.stepAllowance ?? DEFAULT_STEP_ALLOWANCE,
  };

  let messages: Message[] = [...options.messages];
  let stopReason: StopReason = 'max_steps';
  let steps = 0;
  let answer: string | undefined;

  trace.append({
    type: 'run.start',
    runId: options.runId ?? 'run',
    messages,
    tools: tools.names(),
    parameters: {
      budgetLimit: budget.limit,
      maxSteps,
      stepAllowance: estimation.stepAllowance,
      price,
    },
  });

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted === true) {
      stopReason = 'aborted';
      break;
    }

    steps = step + 1;
    const stepId = `step-${steps}`;
    trace.append({ type: 'step.start', step });

    const estimate = estimation.observedMax ?? estimation.stepAllowance;
    let reservation;
    try {
      reservation = budget.reserve(estimate);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      // il tetto non lo permetteva: il run finisce senza che nessuno abbia speso nulla
      stopReason = 'budget';
      break;
    }

    trace.append({ type: 'policy.request', step, model, messageCount: messages.length });

    let outcome: PolicyOutcome;
    try {
      outcome = await options.policy.decide({
        messages,
        tools: tools.specs(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // la prenotazione non è stata spesa: si libera e l'errore sale
      budget.release(reservation);
      if (error instanceof BudgetExceededError) throw error;
      throw new PolicyError(`la Policy ha fallito al passo ${step}`, { cause: error });
    }

    const actual = costOf(outcome.usage, price);
    budget.settle(reservation, actual);
    estimation.observedMax = max(estimation.observedMax ?? 0, actual);

    trace.append({
      type: 'policy.response',
      step,
      model: outcome.model,
      usage: outcome.usage,
      // la decisione porta gli argomenti che il modello ha prodotto: se il tool
      // è sensibile vanno ridatti anche qui, non solo in tool.call
      decision: redactedDecision(outcome.decision, tools),
    });
    trace.append({ type: 'budget.settle', step, reserved: estimate, actual });

    messages = [...messages, assistantMessage(outcome.decision)];

    if (outcome.decision.type === 'message') {
      answer = outcome.decision.content;
      stopReason = 'end_turn';
      break;
    }

    if (outcome.decision.type === 'stop') {
      stopReason = outcome.decision.reason;
      break;
    }

    messages = [...messages, ...(await runTool(tools, outcome.decision.call, step, stepId, trace, options.signal))];
  }

  trace.append({
    type: 'run.end',
    steps,
    stopReason,
    spent: budget.spent,
    spentUsd: formatUsd(budget.spent),
  });

  const result: RunResult = { messages, steps, stopReason, spent: budget.spent, trace };
  return answer === undefined ? result : { ...result, answer };
}

/**
 * Esegue un tool e restituisce i messaggi da aggiungere al contesto.
 *
 * Riuscito o fallito, il contenuto torna al modello: è così che un agente si
 * autocorregga. Il fallimento non solleva, perché un tool che fallisce è un evento
 * ordinario di un run, non un errore del runtime.
 */
async function runTool(
  tools: ToolRegistry,
  call: ToolCall,
  step: number,
  stepId: string,
  trace: Trace,
  signal: AbortSignal | undefined,
): Promise<Message[]> {
  const tool = tools.get(call.name);
  const sensitive = tool?.sensitive === true;

  trace.append({
    type: 'tool.call',
    step,
    call: traceableCall(call, sensitive),
    sensitive,
    ...(tool === undefined ? {} : { fingerprint: tools.fingerprint(call.name) as string }),
  });

  const outcome = await invokeTool(
    tools,
    call,
    signal === undefined ? { stepId } : { stepId, signal },
  );

  trace.append({
    type: 'tool.result',
    step,
    callId: call.id,
    tool: call.name,
    outcome: outcome.ok
      ? { ok: true, output: prepareForTrace(outcome.output, { sensitive }) }
      : { ok: false, failure: outcome.failure },
  });

  if (outcome.ok) {
    return [
      { role: 'tool', tool_call_id: call.id, name: call.name, content: asContent(outcome.output) },
    ];
  }
  return [
    { role: 'tool', tool_call_id: call.id, name: call.name, content: `ERRORE: ${outcome.failure.message}` },
  ];
}

/**
 * La decisione come va in traccia.
 *
 * Una decisione di tool porta con sé gli argomenti, e quegli argomenti possono
 * essere dati personali. Redonderli solo in `tool.call` non basta: finirebbero in
 * `policy.response`, che è scritto una riga prima e finisce negli stessi file che
 * finiscono nei backup.
 */
function redactedDecision(decision: PolicyOutcome['decision'], tools: ToolRegistry): PolicyOutcome['decision'] {
  if (decision.type !== 'tool') return decision;
  const sensitive = tools.get(decision.call.name)?.sensitive === true;
  if (!sensitive) return decision;
  return {
    type: 'tool',
    call: { id: decision.call.id, name: decision.call.name, args: redact(decision.call.args) },
  };
}

/** Il messaggio `assistant` che corrisponde a una decisione. */
function assistantMessage(decision: PolicyOutcome['decision']): Message {
  if (decision.type === 'message') return { role: 'assistant', content: decision.content };
  if (decision.type === 'stop') return { role: 'assistant', content: `[stop: ${decision.reason}]` };
  return {
    role: 'assistant',
    content: `[tool: ${decision.call.name}] ${JSON.stringify(decision.call.args ?? {})}`,
  };
}

/** Come si rende un output di tool nel contesto: quasi sempre JSON, mai `undefined`. */
function asContent(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '(nessun risultato)';
  try {
    return JSON.stringify(output) ?? '(risultato non serializzabile)';
  } catch {
    return '(risultato non serializzabile)';
  }
}

/**
 * Il prezzo di un modello.
 *
 * Un modello assente dalla tabella viene valutato al **massimo** prezzo noto, non
 * a zero. La ragione: `UNKNOWN_MODEL = 0` fa sembrare che il budget protegga mentre
 * non protegge niente, e un modello nuovo che entra in produzione è il momento
 * esatto in cui non si vuole che il tetto spari. Essere pessimisti costa un passo in
 * più; essere ottimisti costa denaro vero.
 */
export function resolvePrice(prices: PriceTable, model: string): Price {
  const found = prices[model];
  if (found !== undefined) return found;

  const entries = Object.values(prices);
  if (entries.length === 0) return { input: micros(0), output: micros(0) };
  return {
    input: Math.max(...entries.map((p) => p.input)),
    output: Math.max(...entries.map((p) => p.output)),
  };
}

function max(a: number, b: number): number {
  return a > b ? a : b;
}