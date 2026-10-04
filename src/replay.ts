/**
 * Il replay: rifare un run da una traccia, senza rete e senza provider.
 *
 * È la promessa di ADR 0001 resa eseguibile, e dipende interamente dal fatto che la
 * `Policy` e i `Tool` siano interfacce: qui non c'è un secondo percorso di codice da
 * mantenere, c'è lo stesso loop con dentro una `Policy` che legge da disco.
 *
 * Tre modalità, dichiarate da chi chiama (ADR 0003):
 *
 * | modalità     | policy     | tool        | per cosa serve                        |
 * |--------------|------------|-------------|---------------------------------------|
 * | `full`       | dalla traccia | dalla traccia | test di regressione sul loop, offline |
 * | `live-tools` | dalla traccia | veri         | "cosa cambia se il tool cambia?"      |
 * | `dry-run`    | dalla traccia | saltati      | quanto del run dipende dai tool?      |
 *
 * In `full` e `dry-run` non viene eseguito nessun codice di tool: l'output arriva
 * dalla traccia. È il motivo per cui il replay funziona anche per un tool che chiama
 * un servizio ormai cancellato.
 */

import { Budget, type Price } from './budget.js';
import { ReplayMismatchError } from './errors.js';
import { run, type RunOptions, type RunResult } from './loop.js';
import { Trace, type ToolOutcomeTrace } from './trace.js';
import { ReplayedFailure, ToolRegistry } from './tool.js';
import type { AnyTool, Policy, PolicyOutcome } from './types.js';

/** Come trattare i tool durante il replay. */
export type ReplayMode = 'full' | 'live-tools' | 'dry-run';

/** Qualcosa che il replay ha notato e che merita di essere detto. */
export interface ReplayWarning {
  readonly kind: 'tool_changed' | 'tool_missing' | 'extra_tool';
  readonly tool: string;
  readonly message: string;
}

export interface ReplayOptions {
  /** I tool veri. Obbligatori solo in `live-tools`, dove vengono davvero eseguiti. */
  readonly tools?: ToolRegistry;
  /** Modalità. Di default `full`. */
  readonly mode?: ReplayMode;
  /**
   * Se `true` (default), la traccia prodotta viene confrontata con l'originale e
   * `equal` dice se combaciano. Serve perché un replay che "riproduce" ma produce
   * qualcos'altro è peggio di un replay che fallisce rumorosamente.
   */
  readonly compare?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReplayResult {
  /** Il run rifatto. */
  readonly result: RunResult;
  /** Cosa non combacia, o cosa è cambiato nel frattempo. */
  readonly warnings: ReplayWarning[];
  /** `true` se la traccia del replay coincide con quella originale, modulo il tempo. */
  readonly equal: boolean;
}

/**
 * Rifà un run da una traccia.
 *
 * @param source la traccia, o il suo JSONL.
 */
export async function replay(
  source: Trace | string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const original = typeof source === 'string' ? Trace.parse(source) : source;
  const mode = options.mode ?? 'full';
  const start = original.of('run.start')[0];
  if (start === undefined) {
    throw new ReplayMismatchError(0, 'la traccia non contiene un run.start: non è una traccia di run');
  }

  const warnings = diffTools(original, options.tools);
  const registry = buildRegistry(original, options.tools, mode, warnings);

  const policy = recordedPolicy(original);
  const runOptions: RunOptions = {
    policy,
    messages: start.messages,
    tools: registry,
    // gli stessi parametri della run originale: un replay con un tetto diverso
    // si fermerebbe a un passo diverso e non starebbe confrontando la stessa cosa
    budget: new Budget(start.parameters.budgetLimit as never),
    maxSteps: start.parameters.maxSteps,
    stepAllowance: start.parameters.stepAllowance as never,
    // il prezzo è quello **risolto** nella run originale: ricalcolarlo con una tabella
    // diversa cambierebbe la spesa e il replay si fermerebbe a un passo diverso
    prices: { [policy.model]: start.parameters.price as Price },
    trace: new Trace(),
    // stesso runId della run originale: il replay *è* quella run, non una nuova.
    // la provenienza del replay sta in ReplayResult, non dentro la traccia.
    runId: start.runId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const result = await run(runOptions);
  const equal = options.compare === false ? false : sameTrace(original, result.trace);
  return { result, warnings, equal };
}

/**
 * Una `Policy` che risponde con le decisioni registrate.
 *
 * Fallisce se la traccia finisce prima: significa che il replay sta chiedendo una
 * decisione in più di quante la run originale ne aveva prese, il che è un bug del
 * loop o una traccia troncata. In entrambi i casi, dirlo adesso vale più che
 * inventare una risposta.
 */
function recordedPolicy(original: Trace): Policy {
  const risposte = original.of('policy.response');
  let indice = 0;
  return {
    // il modello è quello della prima risposta registrata: serve al prezzo
    model: risposte[0]?.model ?? 'registrato',
    decide: (): Promise<PolicyOutcome> => {
      const risposta = risposte[indice++];
      if (risposta === undefined) {
        return Promise.reject(
          new ReplayMismatchError(
            indice - 1,
            `la traccia ha ${risposte.length} risposte ma il replay ne ha chiesto ${indice}: il loop è cambiato`,
          ),
        );
      }
      return Promise.resolve({
        decision: risposta.decision,
        usage: risposta.usage,
        model: risposta.model,
      });
    },
  };
}

/**
 * Il registro da usare nel replay.
 *
 * In `live-tools` è il registro vero e non se ne parla. Altrimenti ogni tool viene
 * sostituito da uno che restituisce ciò che era stato registrato, o che **solleva**
 * l'errore registrato quando la run originale era fallita: è così che il ciclo di
 * autocorrezione del modello si riproduce, e non si riproduce solo il caso felice.
 */
function buildRegistry(
  original: Trace,
  real: ToolRegistry | undefined,
  mode: ReplayMode,
  warnings: ReplayWarning[],
): ToolRegistry {
  if (mode === 'live-tools') {
    if (real === undefined) {
      throw new TypeError('la modalità live-tools richiede i tool veri: senza, non è un replay');
    }
    return real;
  }

  const risultati = new Map<string, ToolOutcomeTrace>();
  for (const evento of original.of('tool.result')) {
    // se un tool è stato chiamato più volte, l'ultimo risultato non basta:
    // si accetta e si dichiara, perché una ricostruzione sbagliata è peggio di nessuna
    risultati.set(`${evento.step}/${evento.tool}`, evento.outcome);
  }

  const fake = new ToolRegistry();
  for (const evento of original.of('tool.call')) {
    const nome = evento.call.name;
    if (fake.has(nome)) continue; // un tool per nome: lo schema non può cambiare in corsa

    // se un tool è stato chiamato più volte, si usa il primo esito registrato:
    // non è la ricostruzione esatta, ed è per questo che l'impronta nel confronto
    // fra tool dice quando il replay non è più attendibile
    const esito = risultati.get(`${evento.step}/${nome}`) ?? primoPerTool(risultati, nome);
    const spec = real?.get(nome);

    const ricostruito: AnyTool = {
      name: nome,
      description: spec?.description ?? `tool ${nome} ricostruito dalla traccia`,
      schema: spec?.schema ?? { type: 'object' },
      execute: (): unknown => {
        if (esito === undefined) {
          // nessun esito registrato: si riproduce il fallimento neutro, che è
          // quello che il modello aveva visto davvero
          throw new ReplayedFailure({
            kind: 'execution_failed',
            message:
              `Il tool "${nome}" è fallito con un errore interno (vedi la traccia per la causa). ` +
              `Non riprovare più di una volta con gli stessi argomenti; se fallisce ancora, ` +
              `dillo all'utente e proponi un percorso alternativo.`,
          });
        }
        if (!esito.ok) throw new ReplayedFailure(esito.failure);
        return esito.output;
      },
    };

    try {
      fake.add(ricostruito);
    } catch (error) {
      // uno schema non più supportato non deve far fallire il replay: si registra
      warnings.push({
        kind: 'tool_changed',
        tool: nome,
        message: `non è stato possibile ricostruire il tool "${nome}": ${String(error)}`,
      });
    }
  }

  return fake;
}

/** Il primo esito registrato per un tool, a qualunque passo. */
function primoPerTool(risultati: ReadonlyMap<string, ToolOutcomeTrace>, nome: string): ToolOutcomeTrace | undefined {
  for (const [chiave, esito] of risultati) {
    if (chiave.endsWith(`/${nome}`)) return esito;
  }
  return undefined;
}

/**
 * Confronta i tool registrati nella traccia con quelli disponibili adesso.
 *
 * È qui che una traccia che mente si smaschera (ADR 0003): se il codice di un tool è
 * cambiato, i risultati registrati non descrivono più il suo comportamento e il
 * replay deve dirlo invece di fingere che sia andato tutto bene.
 */
function diffTools(original: Trace, real: ToolRegistry | undefined): ReplayWarning[] {
  const avvisi: ReplayWarning[] = [];
  if (real === undefined) return avvisi;

  const recorded = new Map<string, string | undefined>();
  for (const evento of original.of('tool.call')) {
    recorded.set(evento.call.name, evento.fingerprint);
  }

  for (const [nome, fingerprint] of recorded) {
    const attuale = real.fingerprint(nome);
    if (attuale === undefined) {
      avvisi.push({
        kind: 'tool_missing',
        tool: nome,
        message: `il tool "${nome}" è nella traccia ma non è registrato`,
      });
      continue;
    }
    if (fingerprint !== undefined && fingerprint !== attuale) {
      avvisi.push({
        kind: 'tool_changed',
        tool: nome,
        message:
          `il tool "${nome}" è cambiato dalla run registrata (impronta ${fingerprint} → ${attuale}): ` +
          `il risultato in traccia può non descrivere più il suo comportamento`,
      });
    }
  }

  for (const nome of real.names()) {
    if (!recorded.has(nome)) {
      avvisi.push({
        kind: 'extra_tool',
        tool: nome,
        message: `il tool "${nome}" esiste adesso ma non è stato usato nella run registrata`,
      });
    }
  }

  return avvisi;
}

/** Due tracce sono la stessa run se coincidono modulo il tempo. */
function sameTrace(a: Trace, b: Trace): boolean {
  const left = a.normalized();
  const right = b.normalized();
  return left.length === right.length && left.every((event, i) => JSON.stringify(event) === JSON.stringify(right[i]));
}