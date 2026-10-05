/**
 * Validation against the JSON Schema subset.
 *
 * Two properties, and the rest are consequences:
 *
 * 1. **It does not throw.** It returns the list of errors. The natural recipient of
 *    this list is a model that has to fix its own arguments: an exception with a
 *    stack trace is useless to it, a list of "field, expected, received" is not.
 *    And for the human caller, `validate()` is more convenient than a `try/catch`
 *    you have to remember to write.
 *
 * 2. **All errors, not the first one.** Otherwise a model that gets three fields
 *    wrong fixes one, is rejected, fixes another, and takes three turns.
 *
 * The list of allowed keywords is in `SUPPORTED_KEYWORDS` (ADR 0002).
 */

import { UnsupportedSchemaKeywordError } from './errors.js';
import type { JsonSchema, JsonSchemaType, ValidationError } from './schema.js';
import { SUPPORTED_KEYWORDS } from './schema.js';

/**
 * Checks that a schema uses only known keywords.
 *
 * Call it **when the tool is registered**, not when validating: if a schema contains
 * `"pattern"` and we silently ignore it, the field looks validated and is not. A
 * development error must blow up immediately.
 *
 * @throws {UnsupportedSchemaKeywordError}
 */
export function assertSchemaSupported(schema: JsonSchema, path = '#'): void {
  const allowed = new Set<string>(SUPPORTED_KEYWORDS);
  // Object.entries on an interface returns a union of all field types: here the rows
  // are `unknown` and every sub-schema is checked again before use.
  const entries: [string, unknown][] = Object.entries(schema);

  for (const [key, value] of entries) {
    const here = `${path}/${key}`;
    if (!allowed.has(key)) {
      throw new UnsupportedSchemaKeywordError(key, here);
    }
    if (value === undefined) continue;

    if (key === 'properties' && isRecord(value)) {
      const properties: [string, unknown][] = Object.entries(value);
      for (const [name, sub] of properties) {
        if (isSchema(sub)) assertSchemaSupported(sub, `${here}/${escapePointer(name)}`);
      }
    } else if (key === 'items' && isSchema(value)) {
      assertSchemaSupported(value, here);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      const branches: unknown[] = value;
      for (const [index, sub] of branches.entries()) {
        if (isSchema(sub)) assertSchemaSupported(sub, `${here}/${index}`);
      }
    }
  }
}

/**
 * Validates `value` against `schema`.
 *
 * @returns the errors found, in order of depth. Empty array = valid.
 */
export function validate(schema: JsonSchema, value: unknown, path = ''): ValidationError[] {
  const errors: ValidationError[] = [];

  // `enum` is more specific than `type`: if the value is in the enum, the type is fine.
  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({
      path,
      message: `expected one of [${schema.enum.map(render).join(', ')}], received ${render(value)}`,
    });
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push({
      path,
      message: `expected ${describeTypes(schema.type)}, received ${describeValue(value)}`,
    });
    // The type does not hold: descending into an object or an array makes no sense
    // and would produce misleading cascades of errors.
    return errors;
  }

  if (schema.anyOf !== undefined) {
    const alternative: readonly JsonSchema[] = schema.anyOf;
    const matches = alternative.some((sub) => validate(sub, value).length === 0);
    if (!matches) {
      const branches = alternative
        .map((sub, index) => {
          const reasons = validate(sub, value)
            .map((error) => `${error.path || '<root>'} ${error.message}`)
            .join('; ');
          return `  [${index}] ${reasons}`;
        })
        .join('\n');
      errors.push({
        path,
        message: `does not match any of the ${alternative.length} allowed shapes:\n${branches}`,
      });
    }
  }

  if (typeof value === 'string') validateString(schema, value, path, errors);
  if (typeof value === 'number') validateNumber(schema, value, path, errors);
  if (Array.isArray(value)) validateArray(schema, value, path, errors);
  if (isRecord(value)) validateObject(schema, value, path, errors);

  return errors;
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string,
  errors: ValidationError[],
): void {
  // Length in code points, not in UTF-16 units: "👨‍👩‍👧" is 1 character for the
  // reader and 5 for String.length. Validation must follow perception.
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    errors.push({ path, message: `expected at least ${schema.minLength} characters, got ${length}` });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    errors.push({ path, message: `expected at most ${schema.maxLength} characters, got ${length}` });
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `expected a number >= ${schema.minimum}, received ${value}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path, message: `expected a number <= ${schema.maximum}, received ${value}` });
  }
}

function validateArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `expected at least ${schema.minItems} elements, got ${value.length}` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: `expected at most ${schema.maxItems} elements, got ${value.length}` });
  }
  if (schema.items === undefined) return;

  value.forEach((item, index) => {
    errors.push(...validate(schema.items as JsonSchema, item, `${path}/${index}`));
  });
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) {
      errors.push({ path: `${path}/${escapePointer(name)}`, message: 'required field is missing' });
    }
  }

  const properties = schema.properties ?? {};
  for (const [name, sub] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name)) continue;
    errors.push(...validate(sub, value[name], `${path}/${escapePointer(name)}`));
  }

  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).filter((name) => !Object.hasOwn(properties, name));
    for (const name of extra) {
      errors.push({
        path: `${path}/${escapePointer(name)}`,
        message: `unexpected field${Object.keys(properties).length > 0 ? ` (allowed: ${Object.keys(properties).join(', ')})` : ''}`,
      });
    }
  }
}

/** Compares two JSON values structurally. Used by `enum` and `anyOf`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function matchesType(type: JsonSchema['type'], value: unknown): boolean {
  if (type === undefined) return true;
  const types: readonly JsonSchemaType[] = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesSingleType(candidate, value));
}

function matchesSingleType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Readable name of one or more expected types: `['string','null']` → `string or null`. */
export function describeTypes(type: JsonSchema['type']): string {
  return Array.isArray(type) ? type.join(' or ') : String(type);
}

/** Readable description of the value: it distinguishes `[]`, `{}`, `null` and `NaN`. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length} elements`;
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string ${render(value)}`;
  return `${typeof value} ${render(value)}`;
}

/** Short and unambiguous representation, for error messages. */
function render(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`;
  if (isRecord(value)) return `{${Object.keys(value).join(', ')}}`;
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  switch (typeof value) {
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'function':
      return `[function ${value.name === '' ? 'anonymous' : value.name}]`;
    case 'object':
    case 'string':
      return '(value)';
  }
  // TypeScript cannot know that the cases above are already covered by the checks at
  // the top of the function; without this return the signature is not satisfiable.
  return '(value)';
}

/** JSON Pointer: `~` becomes `~0`, `/` becomes `~1`. Without it, names with "/" break. */
function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}
