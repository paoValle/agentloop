import { describe, expect, it } from 'vitest';

import { UnsupportedSchemaKeywordError } from '../src/errors.js';
import type { JsonSchema } from '../src/schema.js';
import { SUPPORTED_KEYWORDS } from '../src/schema.js';
import { assertSchemaSupported, deepEqual, describeValue, validate } from '../src/validate.js';

const v = (schema: JsonSchema, value: unknown) => validate(schema, value);
const ok = (schema: JsonSchema, value: unknown) => expect(v(schema, value)).toEqual([]);

describe('type', () => {
  const cases: [NonNullable<JsonSchema['type']>, unknown, boolean][] = [
    ['string', 'hello', true],
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

  it.each(cases)('type %s with %s -> %s', (type, value, valid) => {
    const errors = v({ type }, value);
    expect(errors).toHaveLength(valid ? 0 : 1);
  });

  it('an array of types counts as a union', () => {
    ok({ type: ['string', 'null'] }, 'x');
    ok({ type: ['string', 'null'] }, null);
    expect(v({ type: ['string', 'null'] }, 3)).toHaveLength(1);
  });

  it('a wrong type generates no cascades inside an object', () => {
    // the model passed a string where an object was expected: one error,
    // not one per missing field
    expect(v({ type: 'object', properties: { a: { type: 'string' } } }, 'not an object')).toHaveLength(1);
  });
});

describe('required, properties, additionalProperties', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0 },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('accepts a valid object', () => ok(schema, { name: 'Ada', age: 36 }));

  it('reports the missing required fields', () => {
    expect(v(schema, { age: 36 })).toEqual([{ path: '/name', message: 'required field is missing' }]);
  });

  it('reports wrong types with the exact path', () => {
    expect(v(schema, { name: 'Ada', age: 'thirty-six' })).toEqual([
      { path: '/age', message: 'expected integer, received the string "thirty-six"' },
    ]);
  });

  it('rejects unexpected fields and lists them', () => {
    const errors = v(schema, { name: 'Ada', surname: 'Lovelace' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/surname');
    expect(errors[0]?.message).toContain('name');
  });

  it('accepts extra fields when additionalProperties is not false', () => {
    ok({ type: 'object', properties: { a: {} } }, { a: 1, b: 2 });
  });

  it('honors the path of a field with special characters', () => {
    // '/' and escaping: without escaping the path would point to the wrong place
    expect(v({ type: 'object', required: ['a/b'] }, {})[0]?.path).toBe('/a~1b');
  });
});

describe('numbers and strings', () => {
  it('applies minimum and maximum', () => {
    ok({ type: 'number', minimum: 0, maximum: 1 }, 0.5);
    expect(v({ type: 'number', minimum: 1 }, 0)[0]?.message).toContain('>= 1');
    expect(v({ type: 'number', maximum: 1 }, 2)[0]?.message).toContain('<= 1');
  });

  it('counts characters in code points, not in UTF-16 units', () => {
    // "🎉" takes 2 UTF-16 units but is 1 character: maxLength must count it once
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

  it('validates every element with its index in the path', () => {
    expect(v(schema, [{ sku: 'a' }, { sku: 3 }])).toEqual([
      { path: '/1/sku', message: 'expected string, received number 3' },
    ]);
  });

  it('applies minItems and maxItems', () => {
    expect(v(schema, [])[0]?.message).toContain('at least 1');
    expect(v(schema, [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }, { sku: 'd' }])[0]?.message).toContain(
      'at most 3',
    );
  });
});

describe('enum', () => {
  it('accepts a value in the list', () => ok({ enum: ['a', 'b'] }, 'a'));
  it('rejects a value outside the list, and says what was allowed', () => {
    expect(v({ enum: ['a', 'b'] }, 'z')[0]?.message).toBe('expected one of ["a", "b"], received "z"');
  });
  it('compares structurally, not by reference', () => {
    ok({ enum: [{ k: 1 }] }, { k: 1 });
    expect(v({ enum: [{ k: 1 }] }, { k: 2 })).toHaveLength(1);
  });
});

describe('anyOf', () => {
  const schema: JsonSchema = {
    anyOf: [{ type: 'string' }, { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }],
  };

  it('accepts the first shape', () => ok(schema, 'text'));
  it('accepts the second shape', () => ok(schema, { n: 1 }));

  it('if none holds, it lists why every shape failed', () => {
    const errors = v(schema, 42);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('does not match any');
    expect(errors[0]?.message).toContain('[0]');
    expect(errors[0]?.message).toContain('[1]');
  });
});

describe('all errors, not just the first', () => {
  it('a model that gets three fields wrong sees them all together', () => {
    const errors = v(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'email'],
      },
      { name: 1, age: 'x' },
    );
    // missing fields first, then the wrong ones: two lists, not just one
    expect(errors.map((e) => e.path)).toEqual(['/email', '/name', '/age']);
  });
});

describe('assertSchemaSupported', () => {
  it('accepts the whole declared subset', () => {
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

  it('rejects a keyword outside the subset, with the name and the path', () => {
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

  it('checks inside anyOf and items too', () => {
    expect(() => assertSchemaSupported({ anyOf: [{ type: 'string', not: {} }] } as unknown as JsonSchema)).toThrow();
    expect(() => assertSchemaSupported({ type: 'array', items: { type: 'string', $ref: '#/x' } } as unknown as JsonSchema)).toThrow();
  });

  it('every declared and implemented keyword is reached by the tests', () => {
    // if someone adds a keyword to the list without writing the test, it fails
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
  it('compares arrays and objects structurally', () => {
    expect(deepEqual([1, [2, { a: null }]], [1, [2, { a: null }]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe('describeValue', () => {
  it('distinguishes the values that String() would flatten', () => {
    expect(describeValue([])).toBe('an array of 0 elements');
    expect(describeValue({})).toBe('an object');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(Number.NaN)).toBe('NaN');
  });
});
