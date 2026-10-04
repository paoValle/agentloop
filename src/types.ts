/**
 * I tipi che attraversano tutto il runtime.
 *
 * Sono deliberatamente **readonly**: lo stato del run non si muta, si sostituisce
 * (vedi ADR 0001). Un campo mutabile qui dentro è un bug che aspetta di succedere.
 */

/** Ruolo di un messaggio nella conversazione. I nomi sono quelli del formato chat OpenAI. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Un messaggio della conversazione. I campi opzionali valgono solo dove servono. */
export interface Message {
  readonly role: Role;
  readonly content: string;
  /** Presente solo su `role: 'tool'`: a quale chiamata risponde. */
  readonly tool_call_id?: string;
  /** Presente solo su `role: 'tool'`: quale tool ha prodotto questo contenuto. */
  readonly name?: string;
}

/** Una richiesta di esecuzione tool, così come esce dal modello. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Non validato: `args` è ciò che il modello ha prodotto, e va verificato. */
  readonly args: unknown;
}

/** Token consumati da una singola chiamata al provider. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Perché il loop si è fermato. Sempre esplicito: un `stop` senza motivo è un bug. */
export type StopReason =
  /** il modello ha risposto con un messaggio finale */
  | 'end_turn'
  /** si è esaurito il numero di passi consentiti */
  | 'max_steps'
  /** il budget di denaro non lo permetteva */
  | 'budget'
  /** qualcuno ha chiamato `abort()` */
  | 'aborted';

/** Cosa ha deciso il modello a un passo. */
export type Decision =
  | { readonly type: 'message'; readonly content: string }
  | { readonly type: 'tool'; readonly call: ToolCall }
  | { readonly type: 'stop'; readonly reason: StopReason };

/** Esito di una decisione: la scelta **e** quanto è costata. */
export interface PolicyOutcome {
  readonly decision: Decision;
  readonly usage: Usage;
  /** Il modello che ha risposto. Determina il prezzo, quindi serve al budget. */
  readonly model: string;
}

/** Cosa vede il modello: la descrizione di un tool, non il suo codice. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: import('./schema.js').JsonSchema;
}

/** Ciò che un tool può usare del mondo esterno durante l'esecuzione. */
export interface ToolContext {
  /** Segnale di cancellazione propagato dal chiamante. */
  readonly signal?: AbortSignal;
  /** Identificatore del passo corrente, per log e correlazione. */
  readonly stepId: string;
}

/**
 * Un tool: nome, contratto di ingresso (JSON Schema), e il codice che lo esegue.
 *
 * `I` e `O` sono per il chiamante TypeScript. **Non** sostituiscono la validazione:
 * lo schema è la garanzia a runtime, i generici sono la comodità in compilazione.
 */
export interface Tool<I = unknown, O = unknown> extends ToolSpec {
  execute(input: I, ctx: ToolContext): Promise<O> | O;
  /**
   * Se `true`, argomenti e risultato finiscono in traccia **redatti**: al posto dei
   * valori si scrive solo la dimensione. Serve quando il tool tocca dati personali.
   */
  readonly sensitive?: boolean;
}

/**
 * Un tool con i tipi degli argomenti eroduti: è quello che il registro può contenere.
 *
 * `never` come parametro di ingresso è il trucco che rende il registro compatibile
 * con tool tipizzati. In TypeScript i parametri sono in posizione controvariante:
 * `Tool<{a: number}, number>` non è assegnabile a un registro che vuole
 * `Tool<unknown, unknown>`, perché `execute` accetterebbe qualunque cosa. Con `never`
 * la coerenza torna, perché `never` è assegnabile a ogni tipo: il registro rinuncia
 * a sapere quali sono gli argomenti, che è esattamente il suo lavoro — la garanzia
 * la dà lo schema, a runtime, dove conta.
 */
export type AnyTool = Tool<never, unknown>;

/** Il cervello: chi decide, a ogni passo. */
export interface Policy {
  /**
   * Il modello che verrà interrogato.
   *
   * **Obbligatorio.** Il prezzo è ciò che trasforma un contatore di token in un
   * tetto di spesa, e senza sapere quale modello risponde il budget non può fare il
   * suo lavoro. Una Policy che non lo dichiara è un bug, non un caso limite.
   */
  readonly model: string;
  decide(request: DecideRequest): Promise<PolicyOutcome>;
}

/** Tutto ciò che una `Policy` sa del mondo quando deve decidere. */
export interface DecideRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal?: AbortSignal;
}

/** Il motivo di un tool che ha restituito un errore al modello. */
export type ToolFailureKind =
  /** gli argomenti non rispettano lo schema */
  | 'invalid_arguments'
  /** il modello ha chiesto un tool che non esiste */
  | 'unknown_tool'
  /** il tool è esploso */
  | 'execution_failed';

/** Cosa il loop mette in `role: 'tool'` quando il tool fallisce. */
export interface ToolFailure {
  readonly kind: ToolFailureKind;
  /** Messaggio in chiaro, scritto perché un modello lo legga e lo corregga. */
  readonly message: string;
  /** Dettaglio strutturato, per il chiamante e per la traccia. */
  readonly detail?: unknown;
}

/** Un singolo passo del run, dal punto di vista della Policy. */
export interface RunState {
  readonly step: number;
  readonly messages: readonly Message[];
  readonly stopReason?: StopReason;
}