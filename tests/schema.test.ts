import { describe, expect, it } from 'vitest';

import { UnsupportedSchemaKeywordError } from '../src/errors.js';
import type { JsonSchema } from '../src/schema.js';
import { SUPPORTED_KEYWORDS } from '../src/schema.js';
import { assertSchemaSupported, deepEqual, describeValue, validate } from '../src/validate.js';

const v = (schema: JsonSchema, value: unknown) => validate(schema, value);
const ok = (schema: JsonSchema, value: unknown) => expect(v(schema, value)).toEqual([]);

describe('type', () => {
  const cases: [NonNullable<JsonSchema['type']>, unknown, boolean][] = [
    ['string', 'ciao', true],
    ['string', 3, false],
    ['number', 3.5, true],
    ['number', Number.NaN, false],
    ['number', Number.POSITIVE_INFINITY, false],
    ['integer', 3, true],
    ['integer', 3.5, false],
    ['boolean', false, true],
    ['boolean', 'false', false],
    ['object', {}, true],
    ['object', [], false],
    ['object', null, false],
    ['array', [], true],
    ['array', {}, false],
    ['null', null, true],
    ['null', 0, false],
  ];

  it.each(cases)('type %s con %s -> %s', (type, value, valid) => {
    const errors = v({ type }, value);
    expect(errors).toHaveLength(valid ? 0 : 1);
  });

  it('un array di tipi vale come unione', () => {
    ok({ type: ['string', 'null'] }, 'x');
    ok({ type: ['string', 'null'] }, null);
    expect(v({ type: ['string', 'null'] }, 3)).toHaveLength(1);
  });

  it('un tipo sbagliato non genera cascate dentro un oggetto', () => {
    // il modello ha passato una stringa dove voleva un oggetto: un solo errore,
    // non uno per ogni campo mancante
    expect(v({ type: 'object', properties: { a: { type: 'string' } } }, 'non un oggetto')).toHaveLength(1);
  });
});

describe('required, properties, additionalProperties', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string' },
      età: { type: 'integer', minimum: 0 },
    },
    required: ['nome'],
    additionalProperties: false,
  };

  it('accetta un oggetto valido', () => ok(schema, { nome: 'Ada', età: 36 }));

  it('segnala i campi obbligatori mancanti', () => {
    expect(v(schema, { età: 36 })).toEqual([{ path: '/nome', message: 'campo obbligatorio mancante' }]);
  });

  it('segnala i tipi sbagliati con il percorso esatto', () => {
    expect(v(schema, { nome: 'Ada', età: 'trentasei' })).toEqual([
      { path: '/età', message: 'atteso integer, ricevuto la stringa "trentasei"' },
    ]);
  });

  it('rifiuta i campi non previsti e li elenca', () => {
    const errors = v(schema, { nome: 'Ada', cognome: 'Lovelace' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/cognome');
    expect(errors[0]?.message).toContain('nome');
  });

  it('accetta campi extra quando additionalProperties non è false', () => {
    ok({ type: 'object', properties: { a: {} } }, { a: 1, b: 2 });
  });

  it('rispetta la via del campo con caratteri speciali', () => {
    // '/' ed escizione: senza escaping il percorso punterebbe al posto sbagliato
    expect(v({ type: 'object', required: ['a/b'] }, {})[0]?.path).toBe('/a~1b');
  });
});

describe('numeri e stringhe', () => {
  it('applica minimo e massimo', () => {
    ok({ type: 'number', minimum: 0, maximum: 1 }, 0.5);
    expect(v({ type: 'number', minimum: 1 }, 0)[0]?.message).toContain('>= 1');
    expect(v({ type: 'number', maximum: 1 }, 2)[0]?.message).toContain('<= 1');
  });

  it('conta i caratteri in punti di codice, non in unità UTF-16', () => {
    // "🎉" occupa 2 unità UTF-16 ma è 1 carattere: maxLength deve contarlo una volta
    expect('🎉'.length).toBe(2);
    ok({ type: 'string', maxLength: 1 }, '🎉');
    expect(v({ type: 'string', minLength: 2 }, 'a')).toHaveLength(1);
  });
});

describe('array', () => {
  const schema: JsonSchema = {
    type: 'array',
    items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    minItems: 1,
    maxItems: 3,
  };

  it('valida ogni elemento con il suo indice nel percorso', () => {
    expect(v(schema, [{ sku: 'a' }, { sku: 3 }])).toEqual([
      { path: '/1/sku', message: 'atteso string, ricevuto number 3' },
    ]);
  });

  it('applica minItems e maxItems', () => {
    expect(v(schema, [])[0]?.message).toContain('almeno 1');
    expect(v(schema, [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }, { sku: 'd' }])[0]?.message).toContain(
      'massimo 3',
    );
  });
});

describe('enum', () => {
  it('accetta un valore in lista', () => ok({ enum: ['a', 'b'] }, 'a'));
  it('rifiuta un valore fuori lista, e dice cosa era ammesso', () => {
    expect(v({ enum: ['a', 'b'] }, 'z')[0]?.message).toBe('atteso uno tra ["a", "b"], ricevuto "z"');
  });
  it(' confronta per struttura, non per riferimento', () => {
    ok({ enum: [{ k: 1 }] }, { k: 1 });
    expect(v({ enum: [{ k: 1 }] }, { k: 2 })).toHaveLength(1);
  });
});

describe('anyOf', () => {
  const schema: JsonSchema = {
    anyOf: [{ type: 'string' }, { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }],
  };

  it('accetta la prima forma', () => ok(schema, 'testo'));
  it('accetta la seconda forma', () => ok(schema, { n: 1 }));

  it('se non torna nessuna, elenca perché ogni forma è fallita', () => {
    const errors = v(schema, 42);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('non corrisponde a nessuna');
    expect(errors[0]?.message).toContain('[0]');
    expect(errors[0]?.message).toContain('[1]');
  });
});

describe('tutti gli errori, non solo il primo', () => {
  it('un modello che sbaglia tre campi li vede tutti insieme', () => {
    const errors = v(
      {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          email: { type: 'string' },
          età: { type: 'integer' },
        },
        required: ['nome', 'email'],
      },
      { nome: 1, età: 'x' },
    );
    // i campi mancanti prima, poi quelli sbagliati: due elenchi, non uno solo
    expect(errors.map((e) => e.path)).toEqual(['/email', '/nome', '/età']);
  });
});

describe('assertSchemaSupported', () => {
  it('accetta tutto il sottoinsieme dichiarato', () => {
    expect(() =>
      assertSchemaSupported({
        type: 'object',
        description: 'x',
        properties: { a: { type: 'string', minLength: 1 } },
        required: ['a'],
        additionalProperties: false,
        anyOf: [{ type: 'string' }],
      }),
    ).not.toThrow();
  });

  it('rifiuta una parola chiave fuori sottoinsieme, col nome e il percorso', () => {
    const broken = { type: 'object', properties: { email: { type: 'string', pattern: '^.+@.+$' } } };
    expect(() => assertSchemaSupported(broken as unknown as JsonSchema)).toThrow(
      UnsupportedSchemaKeywordError,
    );
    try {
      assertSchemaSupported(broken as unknown as JsonSchema);
    } catch (error) {
      expect((error as UnsupportedSchemaKeywordError).keyword).toBe('pattern');
      expect((error as UnsupportedSchemaKeywordError).path).toBe('#/properties/email/pattern');
    }
  });

  it('controlla anche dentro anyOf e items', () => {
    expect(() => assertSchemaSupported({ anyOf: [{ type: 'string', not: {} }] } as unknown as JsonSchema)).toThrow();
    expect(() => assertSchemaSupported({ type: 'array', items: { type: 'string', $ref: '#/x' } } as unknown as JsonSchema)).toThrow();
  });

  it('ogni parola chiave dichiarata e implementata è raggiunta dai test', () => {
    // se qualcuno aggiunge una keyword all'elenco senza scrivere il test, fallisce
    const covered = new Set([
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
    ]);
    expect(new Set(SUPPORTED_KEYWORDS)).toEqual(covered);
  });
});

describe('deepEqual', () => {
  it(' confronta array e oggetti per struttura', () => {
    expect(deepEqual([1, [2, { a: null }]], [1, [2, { a: null }]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe('describeValue', () => {
  it('distingue i valori che String() appiattirebbe', () => {
    expect(describeValue([])).toBe('un array di 0 elementi');
    expect(describeValue({})).toBe('un oggetto');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(Number.NaN)).toBe('NaN');
  });
});