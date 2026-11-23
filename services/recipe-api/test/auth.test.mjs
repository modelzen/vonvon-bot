import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createVerifier } from '../src/auth.mjs';

test('Supabase signed access tokens require the project, account role, key and expiry', async t => {
  const {privateKey,publicKey} = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'project-test', alg: 'ES256' };
  const jwks = createServer((req,res) => {
    assert.equal(req.url, '/auth/v1/.well-known/jwks.json');
    res.end(JSON.stringify({keys:[jwk]}));
  });
  jwks.listen(0, '127.0.0.1');
  await once(jwks,'listening');
  t.after(() => new Promise(resolve => jwks.close(resolve)));
  const issuer = 'http://127.0.0.1:' + jwks.address().port + '/auth/v1';
  const verify = createVerifier(issuer), account = 'abc00000-0000-4000-8000-000000000001';
  const claims = {iss: issuer, sub: account, aud:'authenticated', role:'authenticated',
    exp: Math.floor(Date.now()/1000)+120};
  const sign = (fields = {}, header = {alg:'ES256',kid:'project-test'}, key = privateKey) =>
    new SignJWT({...claims,...fields}).setProtectedHeader(header).sign(key);
  assert.deepEqual(await verify(await sign()), {issuer,subject:account});
  for (const bad of [{iss:issuer+'/other'},{aud:'anon'},{role:'service_role'},{sub:'missing'},
    {exp: 1},{exp:undefined},{is_anonymous:true}]) {
    await assert.rejects(verify(await sign(bad)), {status:401});
  }
  await assert.rejects(verify(await sign({}, {alg:'ES256'})),{status:401});
  const other = await generateKeyPair('ES256');
  await assert.rejects(verify(await sign({},undefined,other.privateKey)), {status:401});
});
