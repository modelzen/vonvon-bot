import { isAbsolute } from 'node:path';
import { accountVerifier } from './auth.mjs';
import { createHttpService } from './http.mjs';
import { sourceLibrary } from './source.mjs';
import { usageStore } from './usage.mjs';

process.umask(0o077);
const {
  RELEASE_CODE_ROOT: root,
  RELEASE_CODE_STATS_DB: stats,
  RELEASE_CODE_ISSUER: issuer,
  RELEASE_CODE_MCP_URL: audience,
  RELEASE_CODE_JWKS_URL: jwksUrl = issuer + '/jwks',
  RELEASE_CODE_RG: rg = 'rg',
  PORT: rawPort = '8784',
} = process.env;
const port = Number(rawPort);
if (
  !isAbsolute(root ?? '') ||
  !isAbsolute(stats ?? '') ||
  (rg !== 'rg' && !isAbsolute(rg)) ||
  !Number.isInteger(port) ||
  port <= 0 ||
  port > 65535
)
  throw new Error('Invalid release-code service configuration');
const verify = accountVerifier({ issuer, audience, jwksUrl });
const library = sourceLibrary({ root, rg });
const usage = usageStore(stats);
const service = createHttpService({ audience, issuer, verify, library, usage });
service.listen(port, '127.0.0.1');
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  service.close(() => usage.close());
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
