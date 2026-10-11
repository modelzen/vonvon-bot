import { PiExtensionHost } from "./host.js";
import { piExtensions } from "./registry.js";
import type { Logger } from "../../../paseo/logger.js";
import type { PiExtension } from "./contract.js";

export const piExtensionRuntimeBridge = piExtensions
  .flatMap((extension) => extension.runtimeBridge ?? [])
  .join("\n");

export type { PiExtensionHost } from "./host.js";
export type { PiExtensionEventOutput } from "./host.js";

export function createPiExtensionHost(
  logger?: Pick<Logger, "warn">,
  extensions: readonly PiExtension[] = piExtensions,
  hydrationByteBudget?: number,
): PiExtensionHost {
  return new PiExtensionHost(extensions, logger, hydrationByteBudget);
}
