import type { ProcessHost } from '../../src/provider/process/process-host';

export const idleHost = { admit: async () => undefined, closeAll: async () => {}, owesWork: () => false, snapshot: () => [] } as unknown as ProcessHost;
