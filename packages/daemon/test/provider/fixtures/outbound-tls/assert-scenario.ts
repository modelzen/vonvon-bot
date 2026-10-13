import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { requestPinned } from '../../../../src/provider/outbound/policy';

declare module 'node:tls' {
  interface TLSSocket { servername?: string | false }
}

function parseScenario(value: string | undefined) {
  switch (value) {
    case 'ipv6':
    case 'ipv4':
    case 'dns':
    case 'mismatch':
    case 'untrusted':
      return value;
    default:
      throw new Error(`Unknown TLS scenario: ${value}`);
  }
}

async function main(): Promise<void> {
  const [argument, fixtures] = process.argv.slice(2);
  assert.ok(fixtures, 'Missing TLS certificate fixture directory');
  const scenario = parseScenario(argument);
  const image = Buffer.from('image');
  let seen: { host?: string; servername?: string | false } = {};
  const server = createServer({
    key: await readFile(join(fixtures, 'key.pem')),
    cert: await readFile(join(fixtures, 'cert.pem')),
  }, (request, response) => {
    assert.ok(request.socket instanceof TLSSocket);
    seen = { host: request.headers.host, servername: request.socket.servername };
    response.setHeader('content-type', 'image/png');
    response.end(image);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string', 'Missing test server port');
    const port = address.port;
    switch (scenario) {
      case 'ipv6': {
        const response = await requestPinned(new URL(`https://[::1]:${port}/a.png`), '::1', AbortSignal.timeout(3000));
        assert.deepStrictEqual(response.body, image);
        assert.deepStrictEqual(seen, { host: `[::1]:${port}`, servername: false });
        break;
      }
      case 'ipv4': {
        const response = await requestPinned(new URL(`https://127.0.0.1:${port}/a.png`), '127.0.0.1', AbortSignal.timeout(3000));
        assert.deepStrictEqual(response.body, image);
        assert.deepStrictEqual(seen, { host: `127.0.0.1:${port}`, servername: false });
        break;
      }
      case 'dns': {
        const response = await requestPinned(new URL(`https://example.test:${port}/a.png`), '127.0.0.1', AbortSignal.timeout(3000));
        assert.deepStrictEqual(response.body, image);
        assert.deepStrictEqual(seen, { host: `example.test:${port}`, servername: 'example.test' });
        break;
      }
      case 'mismatch':
        await assert.rejects(requestPinned(new URL(`https://other.test:${port}/a.png`), '127.0.0.1', AbortSignal.timeout(3000)),
          { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        await assert.rejects(requestPinned(new URL(`https://[::2]:${port}/a.png`), '::1', AbortSignal.timeout(3000)),
          { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        break;
      case 'untrusted':
        await assert.rejects(requestPinned(new URL(`https://[::1]:${port}/a.png`), '::1', AbortSignal.timeout(3000)),
          { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        break;
      default: {
        const exhaustive: never = scenario;
        throw new Error(`Unknown TLS scenario: ${exhaustive}`);
      }
    }
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
