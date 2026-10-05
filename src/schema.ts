/**
 * The subset of JSON Schema that this runtime understands.
 *
 * The types live here and the validator lives in `validate()` too: whoever registers
 * a tool must be able to describe its schema without importing the implementation.
 *
 * The supported keywords are listed in `SUPPORTED_KEYWORDS` and they are the only
 * ones allowed. An unknown keyword is a development error, not an ignored detail:
 * see ADR 0002.
 */

/** The JSON types, as the standard names them. */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * A schema. Only the keywords from the subset.
 *
 * `additionalProperties` is a boolean and nothing else: dynamic schemas
 * (`patternProperties`, `additionalProperties: {...}`) are not supported and fail
 * when used.
 */
export interface JsonSchema {
  /** Expected type. An array of types counts as a union: `['string', 'null']`. */
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  /** Text shown to the model. Not part of validation. */
  readonly description?: string;

  /** Fields of an object. */
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  /** Names of the required fields. */
  readonly required?: readonly string[];
  /** `false` rejects any field not listed in `properties`. */
  readonly additionalProperties?: boolean;

  /** Allowed values, compared by deep-equal. */
  readonly enum?: readonly unknown[];

  /** Type of the elements of an array. */
  readonly items?: JsonSchema;
  /** At least one of the sub-schemas must hold. */
  readonly anyOf?: readonly JsonSchema[];

  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** A failed validation. `path` is a JSON Pointer: `/user/email`. */
export interface ValidationError {
  /** Where, in JSON Pointer notation. Empty string for the root. */
  readonly path: string;
  /** Why, in a sentence a model can read and fix itself with. */
  readonly message: string;
}

/**
 * The allowed keywords, in a single place, so the list is checkable by a test:
 * adding a keyword here without implementing it must break something.
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
