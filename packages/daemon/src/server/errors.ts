export class RpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function unsupported(): never {
  throw new RpcError('unsupported', '当前 daemon 不支持此操作。');
}
