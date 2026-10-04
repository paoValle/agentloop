/**
 * Il registro dei tool: chi esiste, con che contratto, e come si chiama.
 *
 * Un tool è la superficie che un modello può toccare. È il posto dove sbaglia di
 * più e quello dove uno sbaglio costa di più, quindi tutto ciò che può essere
 * controllato **all'ingresso** viene controllato all'ingresso: schema non supportato,
 * nome non utilizzabile, descrizione vuota, duplicati. Un errore di registrazione è
 * un bug di sviluppo e deve fermare il processo subito.
 */

import { createHash } from 'node:crypto';

import { SchemaViolationError } from './errors.js';
import { assertSchemaSupported, describeTypes, validate } from './validate.js';
import type { JsonSchema, ValidationError } from './schema.js';
import type { AnyTool, ToolCall, ToolContext, ToolFailure, ToolSpec } from './types.js';

/**
 * L'errore che un autore di tool scrive **per essere letto dal modello**.
 *
 * Se il tuo tool può fallire per un motivo che il modello può capire e correggere,
 * lancia `ToolError` con un messaggio in chiaro. Qualsiasi altro errore viene
 * ridotto a un messaggio neutro dal runtime (vedi ADR 0004).
 */
export class ToolError extends Error {
  constructor(
    message: string,
    /** `true` se riprovare gli stessi argomenti ha una chance di funzionare. */
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

/** Un tool che è andato a buon fine, o il motivo per cui non è andato. */
export type ToolOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly failure: ToolFailure };

/**
 * I nomi dei tool diventano nomi di funzione nel codice generato e nei log.
 * Restringerli è gratis e toglie una classe di problemi: nomi con spazi,
 * con punti, o che iniziano con un numero.
 */
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** I tool registrati, indicizzati per nome. */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  /** Registra un tool. Restituisce `this`, così si può concatenare in costruzione. */
  add(tool: AnyTool): this {
    const { name, description, schema } = tool;

    if (!TOOL_NAME.test(name)) {
      throw new TypeError(
        `nome di tool non valido: "${name}". Attesi lettere, cifre e underscore, ` +
          `iniziali non numeriche, massimo 64 caratteri.`,
      );
    }
    if (description.trim() === '') {
      throw new TypeError(`il tool "${name}" ha una descrizione vuota: il modello non ha nulla su cui basarsi`);
    }
    if (this.#tools.has(name)) {
      throw new Error(`tool duplicato: "${name}" è già registrato`);
    }

    // prima che il tool diventi raggiungibile: uno schema con una parola chiave
    // non supportata deve fermare l'avvio, non fallire a runtime su un input reale
    assertSchemaSupported(schema);

    this.#tools.set(name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** Le descrizioni da mandare al modello. Non contiene codice eseguibile. */
  specs(): ToolSpec[] {
    return this.names().map((name) => {
      const { description, schema } = this.#tools.get(name) as AnyTool;
      return { name, description, schema };
    });
  }

  /**
   * Impronta del codice di un tool: nome, descrizione, schema e sorgente della
   * funzione `execute`.
   *
   * Serve al replay (ADR 0003): se il tool è cambiato, i risultati registrati non
   * descrivono più il suo comportamento, e il replay deve dirlo invece di fingere.
   *
   * Limite noto: copre il corpo della funzione, non gli helper che importa. Un
   * cambiamento dentro un helper non invalida la traccia. È accettato: il costo di
   * un hash del grafo di import finisce per essere più alto del beneficio.
   */
  fingerprint(name: string): string | undefined {
    const tool = this.#tools.get(name);
    if (tool === undefined) return undefined;
    return createHash('sha256')
      .update(name)
      .update('\0')
      .update(tool.description)
      .update('\0')
      .update(JSON.stringify(tool.schema))
      .update('\0')
      .update(tool.execute.toString())
      .digest('hex')
      .slice(0, 16);
  }
}

/**
 * Chiama un tool passando da tutte le verifiche, e **non lancia mai**.
 *
 * Ogni fallimento diventa un `ToolFailure` con un messaggio scritto perché un
 * modello lo legga e lo corregga. Un'eccezione che esce da qui verso il loop
 * significherebbe che un agente ha fatto esplodere il processo: il fallimento di
 * un tool è un evento ordinario del run, non un incidente.
 */
export async function invokeTool(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tool = registry.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      failure: {
        kind: 'unknown_tool',
        message: unknownToolMessage(call.name, registry.names()),
      },
    };
  }

  const errors = validate(tool.schema, call.args);
  if (errors.length > 0) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_arguments',
        message: invalidArgumentsMessage(tool.name, errors),
        detail: errors,
      },
    };
  }

  try {
    const output = await tool.execute(call.args as never, ctx);
    return { ok: true, output };
  } catch (error) {
    if (ctx.signal?.aborted === true) {
      // cancellazione: non è un errore del tool, e il loop non deve autocorreggere
      throw error;
    }
    return { ok: false, failure: describeFailure(tool.name, error) };
  }
}

/**
 * Errore interno: il messaggio da rimettere nel contesto è **già deciso**.
 *
 * Serve solo al replay (ADR 0003). Un tool che nella run originale è fallito con un
 * errore interno ha già prodotto un messaggio neutro; per rifare la stessa run non si
 * può rieseguire il codice del tool e ricostruire l'errore, quindi si conserva il
 * `ToolFailure` per intero — messaggio e `detail` — e lo si reinietta. Non è un
 * `ToolError`: la sua descrizione passerebbe per la regola di ADR 0004, aggiungerebbe
 * il suffisso di riprova e perderebbe il `detail`.
 *
 * @internal
 */
export class ReplayedFailure extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.message);
    this.name = 'ReplayedFailure';
  }
}

/** Traduce un'eccezione in un `ToolFailure`, applicando ADR 0004. */
function describeFailure(tool: string, error: unknown): ToolFailure {
  // prima di tutto: il replay riproduce il fallimento già deciso, struttura compresa
  if (error instanceof ReplayedFailure) {
    return error.failure;
  }

  if (error instanceof ToolError) {
    const retry = error.retryable
      ? 'Puoi riprovare con gli stessi argomenti.'
      : 'Correggi la causa prima di riprovare.';
    return { kind: 'execution_failed', message: `${error.message} ${retry}`, detail: { retryable: error.retryable } };
  }

  // errore non previsto: al modello non si mostra niente del contenuto, solo un
  // riferimento. La causa vera è in traccia.
  return {
    kind: 'execution_failed',
    message:
      `Il tool "${tool}" è fallito con un errore interno (vedi la traccia per la causa). ` +
      `Non riprovare più di una volta con gli stessi argomenti; se fallisce ancora, ` +
      `dillo all'utente e proponi un percorso alternativo.`,
  };
}

/**
 * Il messaggio per un set di errori di validazione.
 *
 * Formato scelto perché il modello possa **citare il campo** e sapere cosa
 * correggere: un messaggio piatto ("input non valido") non gli dà niente su cui
 * lavorare, e il ciclo di autocorrezione si allunga.
 */
export function invalidArgumentsMessage(tool: string, errors: readonly ValidationError[]): string {
  const lines = errors
    .map((error) => `  - ${error.path === '' ? '<argomenti>' : error.path}: ${error.message}`)
    .join('\n');
  return (
    `Gli argomenti per "${tool}" non sono validi (${errors.length} problemi):\n${lines}\n` +
    `Correggi solo i campi indicati e richiama "${tool}".`
  );
}

function unknownToolMessage(requested: string, available: readonly string[]): string {
  const list = available.length > 0 ? available.join(', ') : '(nessun tool registrato)';
  return (
    `Il tool "${requested}" non esiste. I tool disponibili sono: ${list}. ` +
    `Usa solo questi nomi.`
  );
}

/** Costruisce un `SchemaViolationError` a partire dagli errori: per chi preferisce l'eccezione. */
export function schemaViolation(tool: string, errors: readonly ValidationError[]): SchemaViolationError {
  return new SchemaViolationError(tool, errors);
}

/** Rende leggibile uno schema in una riga, per i log. */
export function describeSchema(schema: JsonSchema): string {
  const type = schema.type === undefined ? 'qualsiasi' : describeTypes(schema.type);
  const required = schema.required === undefined ? '' : `, obbligatori: ${schema.required.join(', ')}`;
  return `${type}${required}`;
}