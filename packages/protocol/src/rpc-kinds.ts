import { z } from "zod";
import { requestSchema } from "./rpc.js";

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

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap());
  return schema;
}

function field(schema: z.ZodTypeAny, name: string): z.ZodTypeAny {
  const object = unwrap(schema);
  const inner = object instanceof z.ZodObject ? (object.shape as Record<string, z.ZodTypeAny>)[name] : undefined;
  if (!inner) throw new Error(`rpcKinds: no field ${name}`);
  return inner;
}

function literal(schema: z.ZodTypeAny): string {
  const value = unwrap(schema);
  if (value instanceof z.ZodLiteral && typeof value.value === "string") return value.value;
  throw new Error("rpcKinds: a discriminator that is not a text literal");
}

/** Each variant's name, with its schema when it has one (an enum's values have none). */
function variants(schema: z.ZodTypeAny): Array<[string, z.ZodTypeAny | undefined]> {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const options = inner.options as z.ZodObject<z.ZodRawShape>[];
    return options.map(option => [literal(field(option, inner.discriminator)), option]);
  }
  if (inner instanceof z.ZodEnum) return (inner.options as string[]).map(value => [value, undefined]);
  // A payload of one shape, like snapshot's and contextPreview's `{ type: "get" }`.
  if (inner instanceof z.ZodObject) return [[literal(field(inner, "type")), inner]];
  throw new Error("rpcKinds: a payload that is neither a union, an enum nor an object with a type");
}

export function rpcKinds(): RpcKind[] {
  const kinds: RpcKind[] = [];
  for (const option of requestSchema.options) {
    const method = literal(option.shape.method);
    const payload = (METHOD_FIELD[method] ?? []).reduce<z.ZodTypeAny>(field, option.shape.payload);
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
