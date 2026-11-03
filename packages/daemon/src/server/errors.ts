import { AdminWriteError } from '../admin/ops';
import { NotWiredYetError } from '../admin/service';
import { GroupUpstreamError, InvalidGroupInput } from '../admin/groups';
import { SettingsInputError } from '../admin/settings-parse';
import { CodexSetupConflict } from '../agent/codex-appserver/setup';
import { LibraryError } from '../project/library';

export class RpcError extends Error {
  /** `details` goes into the error envelope, for a program to read (both versions of a `protocol_mismatch`). */
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
export function unsupported(): never {
  throw new RpcError('unsupported', '当前 daemon 不支持此操作。');
}
/** devices 4.7: what a draining daemon answers a request it no longer takes; the connection stays (Codex review 248). */
export const DRAINING_MESSAGE = 'daemon 正在停止或重启（比如在升级），这个请求没有处理。等它重新启动后再试。';
export const drainingError = (): RpcError => new RpcError('draining', DRAINING_MESSAGE);

/** The error envelope for a failed request; an `RpcError`'s `details` go with it (a protocol 1 peer drops them, ws.ts). */
export function errorEnvelope(id: string, error: unknown): { type: 'error'; id: string; code: string; message: string; details?: Record<string, unknown> } {
  return {
    type: 'error', id, code: getRpcErrorCode(error), message: error instanceof Error ? error.message : '操作失败。',
    ...(error instanceof RpcError && error.details ? { details: error.details } : {}),
  };
}

export function getRpcErrorCode(error: unknown): string {
  if (error instanceof RpcError) return error.code;
  if (error instanceof AdminWriteError || error instanceof CodexSetupConflict || error instanceof LibraryError) return 'conflict';
  if (error instanceof GroupUpstreamError) return 'upstream';
  if (error instanceof InvalidGroupInput || error instanceof SettingsInputError || error instanceof URIError) return 'invalid_request';
  if (error instanceof NotWiredYetError) return 'unsupported';
  return 'operation_failed';
}
