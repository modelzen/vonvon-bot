import { z } from "zod";

export const accountProviderSchema = z.enum(["github", "google", "apple"]);
export type AccountProvider = z.infer<typeof accountProviderSchema>;

export const accountAvatarUrlSchema = z.string().max(2048).url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
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
    displayName: z.string().min(1).max(80),
    avatarUrl: accountAvatarUrlSchema.optional(),
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
  onStatus(listener: (status: AccountStatus) => void): () => void;
}
