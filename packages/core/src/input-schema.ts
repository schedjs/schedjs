/**
 * inputSchema — JSON Schema subset for task run parameters (Р10, task:1658).
 *
 * The task's `inputSchema` declares the shape of run `data` (tenant params):
 * types, bounds, defaults, descriptions. It powers (a) fail-fast validation of
 * `data` at create_schedule / update_schedule / run_once (400 with details),
 * (b) default application, and (c) UI/MCP form rendering (trigger.dev model —
 * the schema is self-describing; consumers render fields from it).
 *
 * Supported keyword subset (the rest is ignored per JSON Schema semantics):
 *   - type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
 *   - enum: value must be one of the listed literals
 *   - number/integer: minimum, maximum
 *   - string: minLength, maxLength
 *   - array: items (single schema), minItems, maxItems
 *   - object: properties (map of subschemas), required (array of names),
 *     additionalProperties (boolean — false rejects unknown keys)
 *   - default: applied when the property is absent (never overwrites present)
 *   - description: metadata for UI/MCP forms — ignored by validation
 *
 * A schema node without `type` validates as "any" (no checks at that node) —
 * schemas that want checks must declare `type`.
 */

export interface InputValidationIssue {
  /** Dotted path to the offending value; '' = the root value. */
  path: string;
  /** Human-readable reason (included in the 400 response). */
  message: string;
}

/** Thrown by engine-level validation (triggerTask) — the admin API maps it to 400. */
export class InputValidationError extends Error {
  constructor(readonly issues: InputValidationIssue[]) {
    super(`input data does not match the task's inputSchema: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'InputValidationError';
  }
}

const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Type-check a single value against one schema node (recursively validates). */
function checkNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: InputValidationIssue[],
  applyDefaults: boolean,
): unknown {
  // enum applies to any value regardless of type — reject early (JSON Schema
  // semantics: enum is a constraining keyword independent of type)
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    issues.push({
      path,
      message: `must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
    });
    return value;
  }

  const type = schema.type;
  if (type === undefined) {
    // "any" node — recurse into properties/items only as far as the value allows
    if (isPlainObject(value) && isPlainObject(schema.properties)) {
      return checkObject(schema, value, path, issues, applyDefaults);
    }
    if (Array.isArray(value) && isPlainObject(schema.items)) {
      return value.map((item, i) =>
        checkNode(schema.items as Record<string, unknown>, item, `${path}[${i}]`, issues, applyDefaults),
      );
    }
    return value;
  }

  switch (type) {
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: `expected a string, got ${describe(value)}` });
        return value;
      }
      const minLength = schema.minLength;
      if (typeof minLength === 'number' && value.length < minLength) {
        issues.push({ path, message: `must be at least ${minLength} characters (got ${value.length})` });
      }
      const maxLength = schema.maxLength;
      if (typeof maxLength === 'number' && value.length > maxLength) {
        issues.push({ path, message: `must be at most ${maxLength} characters (got ${value.length})` });
      }
      return value;
    }
    case 'number':
    case 'integer': {
      const isInt = type === 'integer';
      if (typeof value !== 'number' || !Number.isFinite(value) || (isInt && !Number.isInteger(value))) {
        issues.push({ path, message: `expected ${isInt ? 'an integer' : 'a number'}, got ${describe(value)}` });
        return value;
      }
      const minimum = schema.minimum;
      if (typeof minimum === 'number' && value < minimum) {
        issues.push({ path, message: `must be >= ${minimum} (got ${value})` });
      }
      const maximum = schema.maximum;
      if (typeof maximum === 'number' && value > maximum) {
        issues.push({ path, message: `must be <= ${maximum} (got ${value})` });
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `expected a boolean, got ${describe(value)}` });
      }
      return value;
    }
    case 'null': {
      if (value !== null) {
        issues.push({ path, message: `expected null, got ${describe(value)}` });
      }
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected an array, got ${describe(value)}` });
        return value;
      }
      const minItems = schema.minItems;
      if (typeof minItems === 'number' && value.length < minItems) {
        issues.push({ path, message: `must have at least ${minItems} items (got ${value.length})` });
      }
      const maxItems = schema.maxItems;
      if (typeof maxItems === 'number' && value.length > maxItems) {
        issues.push({ path, message: `must have at most ${maxItems} items (got ${value.length})` });
      }
      const items = schema.items;
      if (isPlainObject(items)) {
        return value.map((item, i) => checkNode(items, item, `${path}[${i}]`, issues, applyDefaults));
      }
      return value;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: `expected an object, got ${describe(value)}` });
        return value;
      }
      return checkObject(schema, value, path, issues, applyDefaults);
    }
    default:
      // unreachable — assertValidInputSchema guards the keyword at load time
      return value;
  }
}

function checkObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  issues: InputValidationIssue[],
  applyDefaults: boolean,
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // default application: fill absent properties from schema defaults (never overwrite)
  const out: Record<string, unknown> = { ...value };
  if (applyDefaults) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (out[key] === undefined && isPlainObject(propSchema) && propSchema.default !== undefined) {
        out[key] = propSchema.default;
      }
    }
  }

  // required check
  for (const key of required) {
    if (out[key] === undefined) {
      issues.push({ path: joinPath(path, key), message: 'required property is missing' });
    }
  }

  // per-property validation + nested defaults
  for (const [key, propSchema] of Object.entries(properties)) {
    if (out[key] === undefined) continue;
    const checked = isPlainObject(propSchema)
      ? checkNode(propSchema, out[key], joinPath(path, key), issues, applyDefaults)
      : out[key];
    // recursion may have produced defaults for nested objects — keep the checked value
    if (checked !== out[key]) out[key] = checked;
  }

  // additionalProperties: false → reject unknown keys (typos in tenant params)
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in properties)) {
        issues.push({ path: joinPath(path, key), message: 'unknown property (additionalProperties is false)' });
      }
    }
  }

  return out;
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * Shape-check an inputSchema (fail-fast at tasks.json load / runtime task
 * registration). Throws a descriptive Error naming the offending node.
 * Unknown keywords are allowed (description/format/…) — only the supported
 * subset is validated for shape.
 */
export function assertValidInputSchema(schema: unknown, where = 'inputSchema'): void {
  if (!isPlainObject(schema)) {
    throw new Error(`${where} must be a JSON Schema object`);
  }
  walk(schema, where, new Set());
}

function walk(node: Record<string, unknown>, path: string, seen: Set<object>): void {
  if (seen.has(node)) return; // guard against cyclic schemas
  seen.add(node);

  const type = node.type;
  if (type !== undefined) {
    if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
      throw new Error(`${path}.type must be one of ${TYPES.join(' | ')}, got ${JSON.stringify(type)}`);
    }
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    const v = node[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`${path}.${key} must be a number`);
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties must be a boolean`);
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) {
    throw new Error(`${path}.enum must be an array`);
  }
  const properties = node.properties;
  if (properties !== undefined) {
    if (!isPlainObject(properties)) throw new Error(`${path}.properties must be an object`);
    for (const [key, sub] of Object.entries(properties)) {
      if (!isPlainObject(sub)) throw new Error(`${path}.properties.${key} must be an object`);
      walk(sub, `${path}.properties.${key}`, seen);
    }
  }
  const required = node.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) {
      throw new Error(`${path}.required must be an array of property names`);
    }
    if (isPlainObject(properties)) {
      for (const r of required as string[]) {
        if (!(r in properties)) {
          throw new Error(`${path}.required "${r}" is not a declared property (add it to ${path}.properties)`);
        }
      }
    }
  }
  const items = node.items;
  if (items !== undefined) {
    if (!isPlainObject(items)) throw new Error(`${path}.items must be an object (single schema)`);
    walk(items, `${path}.items`, seen);
  }

  // fail-fast: a `default` that violates its own schema is a bug in the schema
  // (e.g. a string default on a number property) — catch it at load, not at the
  // first run. validateInput applies nested defaults to the default value,
  // which is harmless (JSON schemas are acyclic by construction).
  if (node.default !== undefined) {
    const res = validateInput(node, node.default);
    if (!res.ok) {
      const detail = res.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`${path}.default does not match its schema: ${detail}`);
    }
  }
}

/**
 * Recursively fill absent properties with their schema `default`. Present
 * values are never overwritten; non-object data passes through unchanged.
 */
export function applyInputDefaults(schema: Record<string, unknown>, data: unknown): unknown {
  if (!isPlainObject(schema)) return data;
  const issues: InputValidationIssue[] = [];
  return checkNode(schema, data, '', issues, true);
}

export type InputValidationResult =
  | { ok: true; data: unknown }
  | { ok: false; issues: InputValidationIssue[] };

/**
 * Validate `data` against the task's inputSchema and apply defaults. Returns
 * the effective data (defaults filled) on success — callers store THAT, so the
 * worker always sees the complete parameter set.
 */
export function validateInput(schema: Record<string, unknown>, data: unknown): InputValidationResult {
  const issues: InputValidationIssue[] = [];
  const effective = checkNode(schema, data, '', issues, true);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: effective };
}
