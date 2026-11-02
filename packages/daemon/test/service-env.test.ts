import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyServiceEnv, parseServiceEnv, passedEnv, SERVICE_ENV_MARKER } from '../src/cli/service-env';

describe('<data dir>/env (owner 2026-11-02: a server behind a proxy)', () => {
  const roots: string[] = [];
  const root = (text?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-service-env-'));
    roots.push(dir);
    if (text !== undefined) writeFileSync(join(dir, 'env'), text);
    return dir;
  };
  afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('reads NAME=value lines, comments, export and one pair of outer quotes', () => {
    expect(parseServiceEnv('﻿# 代理\nHTTPS_PROXY=http://127.0.0.1:7890\r\nexport NO_PROXY="localhost,127.0.0.1"\n\n  OPENAI_BASE_URL = \'https://a.example/v1#x\'\nEMPTY=\nURL=http://h/?a=b\n')).toEqual({
      values: [['HTTPS_PROXY', 'http://127.0.0.1:7890'], ['NO_PROXY', 'localhost,127.0.0.1'], ['OPENAI_BASE_URL', 'https://a.example/v1#x'], ['EMPTY', ''], ['URL', 'http://h/?a=b']],
      ignored: [],
      own: [],
    });
  });

  it('skips lines that are not NAME=value and names the service sets itself', () => {
    expect(parseServiceEnv('just words\n1BAD=x\n=x\nVONVON_HOME=/tmp/x\npath=/bin\nElectron_Run_As_Node=0\nOK=1')).toEqual({
      values: [['OK', '1']],
      ignored: [1, 2, 3],
      own: ['VONVON_HOME', 'path', 'Electron_Run_As_Node'],
    });
  });

  it('applies the file over what the process has, keeps the service\'s own names, and never prints a value', () => {
    const dir = root('HTTPS_PROXY=http://proxy:1\nOPENAI_API_KEY=sk-secret\nVONVON_HOME=/elsewhere\nnot a line\n');
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://old:2', VONVON_HOME: dir, PATH: '/usr/bin' };
    const note = applyServiceEnv(dir, env);
    expect(env).toMatchObject({ HTTPS_PROXY: 'http://proxy:1', OPENAI_API_KEY: 'sk-secret', VONVON_HOME: dir, PATH: '/usr/bin', [SERVICE_ENV_MARKER]: 'HTTPS_PROXY,OPENAI_API_KEY' });
    expect(note).toBe(`已从 ${join(dir, 'env')} 读入环境变量：HTTPS_PROXY、OPENAI_API_KEY。第 4 行不是"名字=值"，没用。VONVON_HOME 由服务自己设，文件里的不用。`);
    expect(note).not.toMatch(/sk-secret|proxy:1/);
  });

  it('a restart that inherits the environment drops what the file no longer has', () => {
    const dir = root('HTTPS_PROXY=http://proxy:1\nNO_PROXY=localhost\n');
    const env: NodeJS.ProcessEnv = {};
    applyServiceEnv(dir, env);
    writeFileSync(join(dir, 'env'), 'NO_PROXY=127.0.0.1\n');
    const next = { ...env };
    applyServiceEnv(dir, next);
    expect(next).toEqual({ NO_PROXY: '127.0.0.1', [SERVICE_ENV_MARKER]: 'NO_PROXY' });
    // a marker naming the service's own variables is not trusted
    const own: NodeJS.ProcessEnv = { PATH: '/usr/bin', VONVON_HOME: dir, [SERVICE_ENV_MARKER]: 'PATH,VONVON_HOME' };
    applyServiceEnv(root(), own);
    expect(own).toEqual({ PATH: '/usr/bin', VONVON_HOME: dir });
  });

  // 0.9.0 Linux acceptance (task 287): the 本机环境's npm got no HTTPS_PROXY, so installs failed behind a proxy
  it('passes the file\'s names and the proxy names on to a child built anew, never the service\'s own or a session marker', () => {
    const dir = root('OPENAI_BASE_URL=https://a.example/v1\nFEISHU_CODEX_BRIDGE=1\nHOME=/elsewhere\n');
    const env: NodeJS.ProcessEnv = { https_proxy: 'http://terminal:1', NO_PROXY: 'localhost', All_Proxy: 'socks5://p:2', HOME: '/home/u', PATH: '/usr/bin',
      VONVON_HOME: dir, VONVON_SESSION: 's', VONVON_SCOPE: 'bot=x', SECRET_OF_THE_DAEMON: 'x', HTTP_PROXY_EXTRA: 'x' };
    applyServiceEnv(dir, env);
    expect(passedEnv(env)).toEqual({ https_proxy: 'http://terminal:1', NO_PROXY: 'localhost', All_Proxy: 'socks5://p:2', OPENAI_BASE_URL: 'https://a.example/v1', HOME: '/elsewhere' });
    expect(passedEnv({})).toEqual({});
  });

  it('no file: nothing changes and nothing is said; an unreadable one is said', () => {
    const env: NodeJS.ProcessEnv = { A: '1' };
    expect(applyServiceEnv(root(), env)).toBeUndefined();
    expect(env).toEqual({ A: '1' });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(applyServiceEnv('/x', env, () => { throw denied; })).toBe('读不了 /x/env（EACCES），里面的环境变量没用上。');
    expect(applyServiceEnv('/x', env, () => '# 先空着\n')).toBe('/x/env 里没有环境变量。');
  });
});
