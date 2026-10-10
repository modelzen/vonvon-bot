/** Structural subset of the Pino logger used by the pinned provider. */
export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  trace(message: string): void;
  trace(data: unknown, message: string): void;
  debug(message: string): void;
  debug(data: unknown, message: string): void;
  info(message: string): void;
  info(data: unknown, message: string): void;
  warn(message: string): void;
  warn(data: unknown, message: string): void;
  error(message: string): void;
  error(data: unknown, message: string): void;
}
