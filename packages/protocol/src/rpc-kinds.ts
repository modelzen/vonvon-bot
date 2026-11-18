import { z } from "zod";
import { requestSchema, requestSchemaForMethod, type Request } from "./rpc.js";

/**
 * One name for each thing a client can ask the daemon: `method.type`, like `command.bindGroup`. The requests in
 * `NESTED` carry their real variants one field further in, and get one name per variant: `settings.act.adminMember`,
 * `settings.save.host`, `machine.service.start`. `schedule` names its `request.action`: `schedule.create`.
 * The CLI parity test (devices 8.5) checks each name against the commands and their allowlist.
 */
export type RpcKind = { kind: string; method: string; type: string };

/** The payload field holding a method's variants, when the payload has no `type` of its own. */
const METHOD_FIELD: Record<string, readonly string[]> = { schedule: ["request"] };
/** Fields, from a request's payload, down to the union or enum whose variants each get a name. */
const NESTED: Record<string, readonly string[]> = {
  "settings.read": ["scope"],
  "settings.save": ["edit", "scope"],
  "settings.act": ["action"],
  "machine.mcp": ["request"],
  "machine.service": ["action"],
  "machine.bridgeImport": ["action"],
};

type RpcSchema = z.core.$ZodType;

function unwrap(schema: RpcSchema): RpcSchema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap());
  return schema;
}

function field(schema: RpcSchema, name: string): RpcSchema {
  const object = unwrap(schema);
  const inner = object instanceof z.ZodObject ? object.shape[name] : undefined;
  if (!(inner instanceof z.ZodType)) throw new Error(`rpcKinds: no field ${name}`);
  return inner;
}

function literal(schema: RpcSchema): string {
  const value = unwrap(schema);
  if (value instanceof z.ZodLiteral && typeof value.value === "string") return value.value;
  throw new Error("rpcKinds: a discriminator that is not a text literal");
}

/** Each variant's name, with its schema when it has one (an enum's values have none). */
function variants(schema: RpcSchema): Array<[string, RpcSchema | undefined]> {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const key = inner.def.discriminator;
    return inner.options.map(option => [literal(field(option, key)), option]);
  }
  if (inner instanceof z.ZodEnum) return inner.options.map(value => [String(value), undefined]);
  // A payload of one shape, like snapshot's and contextPreview's `{ type: "get" }`.
  if (inner instanceof z.ZodObject) return [[literal(field(inner, "type")), inner]];
  throw new Error("rpcKinds: a payload that is neither a union, an enum nor an object with a type");
}

export function rpcKinds(): RpcKind[] {
  const kinds: RpcKind[] = [];
  for (const option of requestSchema.options) {
    const method = literal(option.shape.method);
    const payload = (METHOD_FIELD[method] ?? []).reduce<RpcSchema>(field, option.shape.payload);
    for (const [type, schema] of variants(payload)) {
      const base = `${method}.${type}`;
      const path = NESTED[base];
      if (!path) { kinds.push({ kind: base, method, type }); continue; }
      if (!schema) throw new Error(`rpcKinds: ${base} has no fields`);
      for (const [sub] of variants(path.reduce(field, schema))) kinds.push({ kind: `${base}.${sub}`, method, type });
    }
  }
  return kinds;
}

/** The variant `value` is of `schema`: its discriminator's value, or the value itself for an enum. */
function variantName(schema: RpcSchema, value: unknown): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodEnum) return String(value);
  const key = inner instanceof z.ZodDiscriminatedUnion ? inner.def.discriminator : "type";
  return String(fieldValue(value, key));
}
const fieldValue = (value: unknown, name: string): unknown => (value as Record<string, unknown>)[name];

/** The `rpcKinds()` name of a parsed request, like `settings.act.voice` (devices 5.2: the permission table's key). */
export function rpcKindOf(request: Request): string {
  const option = requestSchemaForMethod(request.method);
  if (!option) throw new Error(`rpcKindOf: no method ${request.method}`);
  const path = METHOD_FIELD[request.method] ?? [];
  const payload = path.reduce<RpcSchema>(field, option.shape.payload);
  const value = path.reduce(fieldValue, request.payload);
  const type = variantName(payload, value);
  const base = `${request.method}.${type}`;
  const nested = NESTED[base];
  if (!nested) return base;
  const schema = variants(payload).find(([name]) => name === type)?.[1];
  if (!schema) return base;
  return `${base}.${variantName(nested.reduce(field, schema), nested.reduce(fieldValue, value))}`;
}
