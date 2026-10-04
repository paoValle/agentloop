/**
 * Errori tipizzati.
 *
 * Ogni errore che il runtime può produrre ha un tipo: `catch (e) { }` non deve
 * richiedere di andare a leggere il messaggio per capire cosa sia successo.
 */

import type { ValidationError } from './schema.js';

/** Base di tutto ciò che può fallire dentro al runtime. */
export class AgentLoopError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Il budget di denaro non copre più la chiamata.
 *
 * Non è un errore "da gestire": è il funzionamento corretto del budget. Il loop lo
 * intercetta, chiude il run con `stopReason: 'budget'` e restituisce un risultato
 * — solo se qualcuno lo usa direttamente fuori dal loop, diventa un'eccezione.
 */
export class BudgetExceededError extends AgentLoopError {
  readonly requested: number;
  readonly available: number;

  constructor(requested: number, available: number) {
    super(
      `budget insufficiente: servono ${requested} µUSD, disponibili ${available} µUSD`,
    );
    this.requested = requested;
    this.available = available;
  }
}

/** Gli argomenti prodotti dal modello non rispettano lo schema del tool. */
export class SchemaViolationError extends AgentLoopError {
  readonly errors: readonly ValidationError[];

  constructor(tool: string, errors: readonly ValidationError[]) {
    super(`argomenti non validi per il tool "${tool}"`, { cause: errors });
    this.errors = errors;
  }
}

/** Il modello ha invocato un tool che non è registrato. */
export class UnknownToolError extends AgentLoopError {
  constructor(
    readonly requested: string,
    readonly available: readonly string[],
  ) {
    super(
      `tool sconosciuto "${requested}". Disponibili: ${available.length > 0 ? available.join(', ') : '(nessuno)'}`,
    );
  }
}

/** Il tool esiste, ha ricevuto argomenti validi, e ha comunque fallito. */
export class ToolExecutionError extends AgentLoopError {
  constructor(
    readonly tool: string,
    options?: { cause?: unknown },
  ) {
    super(`il tool "${tool}" è fallito`, options);
  }
}

/** La `Policy` ha fallito: rete, rate limit, formato di risposta inatteso. */
export class PolicyError extends AgentLoopError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Lo schema contiene una parola chiave che questo validatore **non supporta**.
 *
 * È un errore di sviluppo, non di input: deve esplodere quando lo schema viene
 * registrato, non quando un utente passa un argomento strano. Vedi ADR 0002.
 */
export class UnsupportedSchemaKeywordError extends AgentLoopError {
  constructor(
    readonly keyword: string,
    readonly path: string,
  ) {
    super(
      `parola chiave JSON Schema non supportata: "${keyword}" in ${path}. ` +
        `Vedi docs/adr/0002-validatore-json-schema.md per il sottoinsieme ammesso.`,
    );
  }
}

/**
 * Il replay non combacia con la traccia: evento atteso diverso da quello registrato.
 *
 * Significa che il loop è stato modificato in un modo che invalida la riproduzione.
 * Non si "corregga": si capisce perché.
 */
export class ReplayMismatchError extends AgentLoopError {
  constructor(
    readonly step: number,
    message: string,
  ) {
    super(message);
  }
}