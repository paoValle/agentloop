import { describe, expect, it } from 'vitest';

import { UnsupportedSchemaKeywordError } from '../src/errors.js';
import type { JsonSchema } from '../src/schema.js';
import { ToolError, ToolRegistry, invalidArgumentsMessage, invokeTool } from '../src/tool.js';
import type { Tool, ToolCall, ToolContext } from '../src/types.js';

const ctx: ToolContext = { stepId: 'step-1' };

const sum = (): Tool<{ a: number; b: number }, number> => ({
  name: 'sum',
  description: 'Adds two numbers.',
  schema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  execute: (input: { a: number; b: number }) => input.a + input.b,
});

const call = (name: string, args: unknown): ToolCall => ({ id: 'call-1', name, args });

describe('ToolRegistry: checks on the way in', () => {
  it('registers and makes the tools visible to the model', () => {
    const registry = new ToolRegistry([sum()]);
    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(['sum']);
    expect(registry.specs()[0]).toMatchObject({ name: 'sum', description: 'Adds two numbers.' });
  });

  it('rejects a name that cannot become an identifier', () => {
    for (const name of ['9lives', 'with space', 'with.dot', '', 'a'.repeat(65)]) {
      expect(() => new ToolRegistry([{ ...sum(), name }])).toThrow(TypeError);
    }
  });

  it('rejects an empty description: the model has nothing to go on', () => {
    expect(() => new ToolRegistry([{ ...sum(), description: '   ' }])).toThrow(/empty description/);
  });

  it('rejects duplicates instead of silently replacing them', () => {
    const registry = new ToolRegistry([sum()]);
    expect(() => registry.add(sum())).toThrow(/duplicate/);
    expect(registry.size).toBe(1);
  });

  it('rejects a schema with keywords outside the subset, on the way in', () => {
    const broken = { ...sum(), schema: { type: 'string', pattern: '^x$' } as unknown as JsonSchema };
    expect(() => new ToolRegistry([broken])).toThrow(UnsupportedSchemaKeywordError);
  });

  it('the specs contain no executable code', () => {
    const registry = new ToolRegistry([sum()]);
    expect(Object.keys(registry.specs()[0] as object).sort()).toEqual(['description', 'name', 'schema']);
  });
});

describe('ToolRegistry: fingerprint', () => {
  it('changes if the tool body changes', () => {
    const a = new ToolRegistry([sum()]);
    const b = new ToolRegistry([{ ...sum(), execute: (input: { a: number; b: number }) => input.a * input.b }]);
    expect(a.fingerprint('sum')).not.toBe(b.fingerprint('sum'));
  });

  it('changes if the schema changes', () => {
    const a = new ToolRegistry([sum()]);
    const b = new ToolRegistry([{ ...sum(), schema: { type: 'object', properties: {} } }]);
    expect(a.fingerprint('sum')).not.toBe(b.fingerprint('sum'));
  });

  it('is stable for the same tool', () => {
    expect(new ToolRegistry([sum()]).fingerprint('sum')).toBe(new ToolRegistry([sum()]).fingerprint('sum'));
  });

  it('undefined for a tool that does not exist', () => {
    expect(new ToolRegistry().fingerprint('ghost')).toBeUndefined();
  });
});

describe('invokeTool: the happy path', () => {
  it('executes and returns the output', async () => {
    const registry = new ToolRegistry([sum()]);
    const outcome = await invokeTool(registry, call('sum', { a: 2, b: 3 }), ctx);
    expect(outcome).toEqual({ ok: true, output: 5 });
  });

  it('passes the context to the tool', async () => {
    let seen: string | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'Records the step.',
      schema: { type: 'object' },
      execute: (_input, c) => {
        seen = c.stepId;
      },
    };
    await invokeTool(new ToolRegistry([spy]), call('spy', {}), { stepId: 'step-7' });
    expect(seen).toBe('step-7');
  });
});

describe('invokeTool: the model arguments', () => {
  it('a nonexistent tool becomes a message listing the real ones', async () => {
    const registry = new ToolRegistry([sum()]);
    const outcome = await invokeTool(registry, call('multiply', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unknown_tool');
    expect(outcome.failure.message).toContain('multiply');
    expect(outcome.failure.message).toContain('sum');
  });

  it('invalid arguments never reach the tool code', async () => {
    let executed = false;
    const guarded: Tool<{ a: number; b: number }, number> = {
      ...sum(),
      execute: (input) => {
        executed = true;
        return input.a + input.b;
      },
    };
    const outcome = await invokeTool(new ToolRegistry([guarded]), call('sum', { a: 1 }), ctx);
    expect(executed).toBe(false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_arguments');
    expect(outcome.failure.message).toContain('/b');
  });

  it('the validation message quotes the field and what is missing', () => {
    const message = invalidArgumentsMessage('sum', [
      { path: '/b', message: 'required field is missing' },
      { path: '/a', message: 'expected number, received the string "x"' },
    ]);
    expect(message).toContain('- /b: required field is missing');
    expect(message).toContain('- /a: expected number');
    expect(message).toContain('Fix only the fields listed');
  });
});

describe('invokeTool: what is shown to the model (ADR 0004)', () => {
  it('ToolError: the message passes whole, the model can fix itself', async () => {
    const tool: Tool = {
      name: 'order',
      description: 'Creates an order.',
      schema: { type: 'object' },
      execute: () => {
        throw new ToolError('Insufficient stock for sku-42: 1 available, 3 requested.', true);
      },
    };
    const outcome = await invokeTool(new ToolRegistry([tool]), call('order', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.message).toContain('Insufficient stock');
    expect(outcome.failure.message).toContain('You can retry');
  });

  it('an unexpected error does NOT reach the model: no secrets, no paths', async () => {
    const tool: Tool = {
      name: 'order',
      description: 'Creates an order.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('401 Unauthorized: token sk-live-ABCDEF at /var/secrets/prod.env');
      },
    };
    const outcome = await invokeTool(new ToolRegistry([tool]), call('order', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // the message contains no piece of the real error
    expect(outcome.failure.message).not.toContain('sk-live-ABCDEF');
    expect(outcome.failure.message).not.toContain('/var/secrets');
    expect(outcome.failure.message).not.toContain('401');
    // and it says what to do
    expect(outcome.failure.message).toContain('Do not retry more than once');
  });

  it('the text in no way depends on the real error', async () => {
    // two tools with the same name but different causes: bit-for-bit identical messages
    const boom = (secret: string): Tool => ({
      name: 'payment',
      description: 'Executes the payment.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error(secret);
      },
    });
    const a = await invokeTool(new ToolRegistry([boom('secret-1 sk-live-AAA')]), call('payment', {}), ctx);
    const b = await invokeTool(new ToolRegistry([boom('secret-2 sk-live-BBB')]), call('payment', {}), ctx);
    expect(a.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.failure.message).toBe(b.failure.message);
  });
});

describe('invokeTool: cancellation', () => {
  it('an AbortError passes through: it is not a tool error and must not be self-corrected', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool: Tool = {
      name: 'slow',
      description: 'Takes a while.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('the caller cancelled');
      },
    };
    await expect(
      invokeTool(new ToolRegistry([tool]), call('slow', {}), { ...ctx, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});
