/**
 * Validazione contro il sottoinsieme di JSON Schema.
 *
 * Due proprietà, e il resto sono conseguenze:
 *
 * 1. **Non lancia.** Restituisce la lista degli errori. Il destinatario naturale di
 *    questa lista è un modello che deve correggere i propri argomenti: un'eccezione
 *    con stack trace è uselesse per lui, un elenco di "campo, atteso, ricevuto" no.
 *    E per il chiamante umano, `validate()` è più comoda di un `try/catch` che
 *    devi ricordarti di mettere.
 *
 * 2. **Tutti gli errori, non il primo.** Altrimenti un modello che sbaglia tre
 *    campi corregge uno, viene rifiutato, corregge un altro, e ci mette tre turni.
 *
 * L'elenco delle parole chiave ammesse è in `SUPPORTED_KEYWORDS` (ADR 0002).
 */

import { UnsupportedSchemaKeywordError } from './errors.js';
import type { JsonSchema, ValidationError } from './schema.js';
import { SUPPORTED_KEYWORDS } from './schema.js';

/**
 * Controlla che uno schema usi solo parole chiave note.
 *
 * Da chiamare **alla registrazione del tool**, non alla validazione: se uno schema
 * contiene `"pattern"` e noi lo ignoriamo in silenzio, il campo sembra validato e
 * non lo è. Un errore di sviluppo deve esplodere subito.
 *
 * @throws {UnsupportedSchemaKeywordError}
 */
export function assertSchemaSupported(schema: JsonSchema, path = '#'): void {
  const allowed = new Set<string>(SUPPORTED_KEYWORDS);
  // Object.entries su un'interfaccia restituisce un'unione di tutti i tipi di campo:
  // qui le righe sono `unknown` e ogni sotto-schema viene ricontrollato prima dell'uso.
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
      value.forEach((sub, index) => assertSchemaSupported(sub, `${here}/${index}`));
    }
  }
}

/**
 * Valida `value` contro `schema`.
 *
 * @returns gli errori trovati, in ordine di profondità. Array vuoto = valido.
 */
export function validate(schema: JsonSchema, value: unknown, path = ''): ValidationError[] {
  const errors: ValidationError[] = [];

  // `enum` è più specifico di `type`: se il valore è nell'enum, il tipo è già a posto.
  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({
      path,
      message: `atteso uno tra [${schema.enum.map(render).join(', ')}], ricevuto ${render(value)}`,
    });
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push({
      path,
      message: `atteso ${describeTypes(schema.type)}, ricevuto ${describeValue(value)}`,
    });
    // Il tipo non torna: scendere dentro un oggetto o un array non ha senso e
    // produrrebbe cascate di errori fuorvianti.
    return errors;
  }

  if (schema.anyOf !== undefined) {
    const alternatives = schema.anyOf;
    const matches = alternatives.some((sub) => validate(sub, value).length === 0);
    if (!matches) {
      const branches = alternatives
        .map((sub, index) => {
          const reasons = validate(sub, value)
            .map((error) => `${error.path || '<root>'} ${error.message}`)
            .join('; ');
          return `  [${index}] ${reasons}`;
        })
        .join('\n');
      errors.push({
        path,
        message: `non corrisponde a nessuna delle ${alternatives.length} forme ammesse:\n${branches}`,
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
  // Lunghezza in punti di codice, non in unità UTF-16: "👨‍👩‍👧" è 1 carattere per
  // chi lo legge e 5 per String.length. La validazione deve seguire la percezione.
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    errors.push({ path, message: `attesta almeno ${schema.minLength} caratteri, ne ha ${length}` });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    errors.push({ path, message: `attesta al massimo ${schema.maxLength} caratteri, ne ha ${length}` });
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `atteso un numero >= ${schema.minimum}, ricevuto ${value}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path, message: `atteso un numero <= ${schema.maximum}, ricevuto ${value}` });
  }
}

function validateArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `attesi almeno ${schema.minItems} elementi, ne ha ${value.length}` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: `attesi al massimo ${schema.maxItems} elementi, ne ha ${value.length}` });
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
      errors.push({ path: `${path}/${escapePointer(name)}`, message: 'campo obbligatorio mancante' });
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
        message: `campo non previsto${Object.keys(properties).length > 0 ? ` (previsti: ${Object.keys(properties).join(', ')})` : ''}`,
      });
    }
  }
}

/** Confronta due valori JSON per struttura. Serve a `enum` e a `anyOf`. */
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
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesSingleType(candidate, value));
}

function matchesSingleType(type: NonNullable<JsonSchema['type']> & string, value: unknown): boolean {
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

function describeTypes(type: JsonSchema['type']): string {
  return Array.isArray(type) ? type.join(' o ') : String(type);
}

/** Descrizione leggibile del valore: distingue `[]`, `{}`, `null` e `NaN`. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `un array di ${value.length} elementi`;
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'object') return 'un oggetto';
  if (typeof value === 'string') return `la stringa ${render(value)}`;
  return `${typeof value} ${render(value)}`;
}

/** Rappresentazione breve e non ambigua, per i messaggi di errore. */
function render(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`;
  if (isRecord(value)) return `{${Object.keys(value).join(', ')}}`;
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return String(value);
}

/** JSON Pointer: `~` diventa `~0`, `/` diventa `~1`. Senza, i nomi con "/" si rompono. */
function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}