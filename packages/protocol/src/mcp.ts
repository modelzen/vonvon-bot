import { z } from 'zod';
const provider = z.enum(['codex', 'claude']);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const mcpConfigSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), command: z.string().min(1).max(4096), args: z.array(z.string().max(10000)).max(100), env: z.record(envName, z.string().max(10000)).optional() }).strict(),
  z.object({ transport: z.literal('http'), url: z.string().url().max(10000), bearerTokenEnvVar: envName.optional() }).strict(),
]);
export const mcpRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), provider }).strict(),
  z.object({ action: z.literal('add'), provider, name, revision: z.string().min(1), config: mcpConfigSchema }).strict(),
  z.object({ action: z.literal('remove'), provider, name, revision: z.string().min(1) }).strict(),
]);
export const mcpReplySchema = z.object({
  type: z.literal('mcp'), provider, configPath: z.string(), revision: z.string(),
  status: z.enum(['ready', 'unavailable', 'conflict']), cliAvailable: z.boolean(), message: z.string().optional(), changed: z.boolean().optional(),
  entries: z.array(z.object({ name: z.string(), transport: z.enum(['stdio', 'http', 'sse', 'unknown']), source: z.literal('user'), command: z.string().optional(), argumentCount: z.number().int().optional(), urlOrigin: z.string().optional(), envNames: z.array(z.string()), headerNames: z.array(z.string()), enabled: z.boolean(), authorization: z.literal('not-checked'), loginArgv: z.array(z.string()).optional() })),
});
export type McpRequest = z.infer<typeof mcpRequestSchema>;
export type McpReply = z.infer<typeof mcpReplySchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
