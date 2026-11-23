import { z } from "zod";

export const accountProviderSchema = z.enum(["github", "google", "apple"]);
export type AccountProvider = z.infer<typeof accountProviderSchema>;

export const accountAvatarUrlSchema = z.string().max(2048).url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
  const github = url.hostname === "avatars.githubusercontent.com";
  if (!github && !/^lh[3-6]\.googleusercontent\.com$/.test(url.hostname)) return false;
  const allowed = github ? ["v", "s"] : ["sz"];
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key) || !/^[1-9]\d{0,8}$/.test(value)) return false;
    if (key !== "v" && Number(value) > 1024) return false;
    seen.add(key);
  }
  return true;
});

export const accountAvatarMaxBytes = 256 * 1024;
export const accountAvatarDataUrlSchema = z.string().max(23 + 4 * Math.ceil(accountAvatarMaxBytes / 3))
  .regex(/^data:image\/(?:png|jpeg|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => {
    const data = value.slice(value.indexOf(',') + 1);
    return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) <= accountAvatarMaxBytes;
  });

export const accountStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("signedOut"),
    reason: z.enum(["failed", "expired", "cancelled", "sessionExpired"]).optional(),
  }).strict(),
  z.object({ kind: z.literal("signingIn") }).strict(),
  z.object({
    kind: z.literal("signedIn"),
    accountId: z.string().uuid(),
    displayName: z.string().min(1).max(160).refine(value => Array.from(value).length <= 80),
    avatarUrl: accountAvatarUrlSchema.optional(),
    avatarDataUrl: accountAvatarDataUrlSchema.optional(),
    profileRevision: z.number().int().min(0).max(2147483647).optional(),
    provider: accountProviderSchema,
    persistence: z.enum(["secure", "memory"]),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["configuration", "offline", "storage"]),
  }).strict(),
]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/** This desktop's account is independent of the selected device. */
export interface AccountShell {
  status(): Promise<AccountStatus>;
  login(): Promise<AccountStatus>;
  cancelLogin(): Promise<AccountStatus>;
  logout(): Promise<AccountStatus>;
  manage?(): Promise<void>;
  refresh?(): Promise<AccountStatus>;
  onStatus(listener: (status: AccountStatus) => void): () => void;
}
