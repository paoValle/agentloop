/**
 * Il sottoinsieme di JSON Schema che questo runtime capisce.
 *
 * I tipi vivono qui e il validatore pure in `validate()`: chi registra un tool deve
 * poter descrivere il proprio schema senza importare l'implementazione.
 *
 * Le parole chiave supportate sono elencate in `SUPPORTED_KEYWORDS` e sono le uniche
 * ammesse. Una parola chiave sconosciuta è un errore di sviluppo, non un dettaglio
 * ignorato: vedi ADR 0002.
 */

/** I tipi JSON, come li nomina lo standard. */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * Uno schema. Solo le parole chiave del sottoinsieme.
 *
 * `additionalProperties` è un booleano e basta: gli schemi dinamici (`patternProperties`,
 * `additionalProperties: {...}`) non sono supportati e falliscono all'uso.
 */
export interface JsonSchema {
  /** Tipo atteso. Un array di tipi vale come unione: `['string', 'null']`. */
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  /** Testo mostrato al modello. Non parte della validazione. */
  readonly description?: string;

  /** Campi di un oggetto. */
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  /** Nomi dei campi obbligatori. */
  readonly required?: readonly string[];
  /** `false` rifiuta qualunque campo non elencato in `properties`. */
  readonly additionalProperties?: boolean;

  /** Valori ammessi, confrontati per deep-equal. */
  readonly enum?: readonly unknown[];

  /** Tipo degli elementi di un array. */
  readonly items?: JsonSchema;
  /** Almeno uno dei sotto-schemi deve valere. */
  readonly anyOf?: readonly JsonSchema[];

  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** Una validazione non riuscita. `path` è un JSON Pointer: `/utente/email`. */
export interface ValidationError {
  /** Dove, in notazione JSON Pointer. Stringa vuota per la radice. */
  readonly path: string;
  /** Perché, in una frase che un modello può leggere e correggere. */
  readonly message: string;
}

/**
 * Le parole chiave ammesse, in un solo posto, così l'elenco è verificabile da un
 * test: aggiungere una keyword qui senza implementarla deve rompere qualcosa.
 */
export const SUPPORTED_KEYWORDS = [
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'anyOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
] as const satisfies readonly (keyof JsonSchema)[];