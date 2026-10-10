import type { ApiLifetime } from '../../src/server/http';

export function createApiLifetimeFake(calls: string[] = []): ApiLifetime {
  return {
    async beginDrain() { calls.push('drain'); },
    async release() { calls.push('release'); },
  };
}
