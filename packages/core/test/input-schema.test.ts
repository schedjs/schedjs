import { describe, expect, it } from 'vitest';
import {
  assertValidInputSchema,
  applyInputDefaults,
  validateInput,
} from '../src/input-schema.js';

describe('assertValidInputSchema', () => {
  it('rejects a non-object schema', () => {
    expect(() => assertValidInputSchema('nope')).toThrow(/inputSchema must be a JSON Schema object/);
    expect(() => assertValidInputSchema(null)).toThrow(/inputSchema must be a JSON Schema object/);
  });

  it('rejects an unknown type keyword', () => {
    expect(() => assertValidInputSchema({ type: 'stringish' })).toThrow(/type must be one of/);
  });

  it('rejects a non-boolean additionalProperties', () => {
    expect(() => assertValidInputSchema({ type: 'object', additionalProperties: 'yes' })).toThrow(
      /additionalProperties must be a boolean/,
    );
  });

  it('rejects a non-number minimum', () => {
    expect(() => assertValidInputSchema({ type: 'number', minimum: '1' })).toThrow(/minimum must be a number/);
  });

  it('rejects a non-array required', () => {
    expect(() => assertValidInputSchema({ type: 'object', required: 'name' })).toThrow(/required must be an array/);
  });

  it('rejects required referencing a property not in properties', () => {
    expect(() =>
      assertValidInputSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }),
    ).toThrow(/required "b" is not a declared property/);
  });

  it('rejects bad nested property schemas with a path', () => {
    expect(() =>
      assertValidInputSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'c' } } } } }),
    ).toThrow(/properties\.a\.properties\.b/);
  });

  it('accepts a valid schema with unknown keywords (description/title) ignored', () => {
    expect(() =>
      assertValidInputSchema({
        type: 'object',
        description: 'tenant params',
        properties: {
          idSeller: { type: 'integer', minimum: 1, description: 'seller id' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['idSeller'],
      }),
    ).not.toThrow();
  });

  it('rejects a default that violates its own schema (fail-fast at load)', () => {
    expect(() =>
      assertValidInputSchema({
        type: 'object',
        properties: { n: { type: 'number', default: 'not-a-number' } },
      }),
    ).toThrow(/default does not match its schema/);
    expect(() =>
      assertValidInputSchema({
        type: 'object',
        properties: { mode: { type: 'string', enum: ['auto', 'manual'], default: 'teleport' } },
      }),
    ).toThrow(/default does not match its schema/);
  });
});

describe('applyInputDefaults', () => {
  it('fills top-level defaults for missing properties', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', default: 'x' },
        b: { type: 'integer', default: 5 },
      },
    };
    expect(applyInputDefaults(schema, {})).toEqual({ a: 'x', b: 5 });
  });

  it('keeps present values — defaults never overwrite', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string', default: 'x' } },
    };
    expect(applyInputDefaults(schema, { a: 'given' })).toEqual({ a: 'given' });
  });

  it('applies nested object defaults recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: { depth: { type: 'integer', default: 3 } },
        },
      },
    };
    expect(applyInputDefaults(schema, { meta: {} })).toEqual({ meta: { depth: 3 } });
  });

  it('applies item defaults inside arrays of objects', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer', default: 1 } } } },
      },
    };
    expect(applyInputDefaults(schema, { list: [{}, { n: 9 }] })).toEqual({ list: [{ n: 1 }, { n: 9 }] });
  });

  it('leaves non-object data untouched', () => {
    expect(applyInputDefaults({ type: 'string', default: 'x' }, null)).toBeNull();
    expect(applyInputDefaults({ type: 'string', default: 'x' }, undefined)).toBeUndefined();
  });
});

describe('validateInput', () => {
  it('accepts valid data and returns it with defaults applied', () => {
    const schema = {
      type: 'object',
      properties: {
        idSeller: { type: 'integer', minimum: 1 },
        mode: { type: 'string', default: 'auto' },
      },
      required: ['idSeller'],
    };
    const res = validateInput(schema, { idSeller: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ idSeller: 2, mode: 'auto' });
  });

  it('reports a type mismatch with a dotted path', () => {
    const schema = {
      type: 'object',
      properties: { idSeller: { type: 'integer' } },
      required: ['idSeller'],
    };
    const res = validateInput(schema, { idSeller: 'two' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([{ path: 'idSeller', message: expect.stringMatching(/integer/) }]);
    }
  });

  it('reports a missing required property', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const res = validateInput(schema, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]).toMatchObject({ path: 'a' });
  });

  it('reports min/max violations on numbers', () => {
    const schema = { type: 'number', minimum: 1, maximum: 10 };
    const low = validateInput(schema, 0);
    const high = validateInput(schema, 11);
    expect(low.ok).toBe(false);
    expect(high.ok).toBe(false);
    if (!low.ok) expect(low.issues[0].message).toMatch(/>= 1/);
    if (!high.ok) expect(high.issues[0].message).toMatch(/<= 10/);
  });

  it('reports minLength/maxLength on strings', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 4 };
    expect(validateInput(schema, 'a').ok).toBe(false);
    expect(validateInput(schema, 'abcde').ok).toBe(false);
    expect(validateInput(schema, 'ab').ok).toBe(true);
  });

  it('reports minItems/maxItems on arrays', () => {
    const schema = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 };
    expect(validateInput(schema, []).ok).toBe(false);
    expect(validateInput(schema, [1, 2, 3]).ok).toBe(false);
    expect(validateInput(schema, [1]).ok).toBe(true);
  });

  it('rejects values outside an enum', () => {
    const schema = { type: 'string', enum: ['auto', 'manual'] };
    expect(validateInput(schema, 'auto').ok).toBe(true);
    const res = validateInput(schema, 'teleport');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0].message).toMatch(/must be one of: "auto", "manual"/);
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const res = validateInput(schema, { a: 'x', sneaky: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]).toMatchObject({ path: 'sneaky' });
  });

  it('collects multiple nested errors with full paths', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'integer', minimum: 0 } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    };
    const res = validateInput(schema, { outer: { inner: -1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({ path: 'outer.inner', message: expect.stringMatching(/>= 0/) });
    }
  });

  it('accepts nulls only when the schema type allows null', () => {
    expect(validateInput({ type: 'null' }, null).ok).toBe(true);
    expect(validateInput({ type: 'string' }, null).ok).toBe(false);
  });

  it('treats a schema without a type as any (no checks)', () => {
    expect(validateInput({ description: 'anything goes' }, { anything: [1, 2] }).ok).toBe(true);
  });
});
