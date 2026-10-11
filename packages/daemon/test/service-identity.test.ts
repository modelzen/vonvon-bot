import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '../src');
function sources() {
  const read = (file: string) => readFileSync(join(sourceRoot, file), 'utf8');
  return {
    'service/adapter.ts': read('service/adapter.ts'),
    'service/launchd.ts': read('service/launchd.ts'),
    'service/systemd.ts': read('service/systemd.ts'),
    'service/win-startup.ts': read('service/win-startup.ts'),
    'service/common.ts': read('service/common.ts'),
    'host/bootstrap.ts': read('host/bootstrap.ts'),
  };
}
type Sources = ReturnType<typeof sources>;

function parse(body: string): ts.SourceFile {
  return ts.createSourceFile('fixture.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(node: ts.Node): void { result.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return result;
}
function name(node: ts.Node): string {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${name(node.expression)}.${node.name.text}`;
  return '';
}
function words(node: ts.Node): string[] {
  return nodes(node).filter(ts.isStringLiteralLike).flatMap(literal => literal.text.split(/[\s/\\]+/));
}
function enclosingFunction(node: ts.Node): string {
  let parent = node.parent;
  while (parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) return parent.name ? name(parent.name) : '';
    parent = parent.parent;
  }
  return '';
}
function property(node: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const member of node.properties) {
    if (ts.isPropertyAssignment(member) && name(member.name) === key) return member.initializer;
  }
  return undefined;
}

function violations(source: Sources): string[] {
  const failures: string[] = [];
  const bootouts: { file: string; node: ts.Node }[] = [];
  for (const [file, body] of Object.entries(source)) {
    if (file === 'host/bootstrap.ts') continue;
    if (/feishu-codex-bridge|vonvon-bridge|FEISHU_CODEX_BRIDGE_SERVICE|SERVICE_ENV_FLAG|service\.pid|CODEX_BIN/i.test(body)) failures.push(`${file}: legacy identity`);
    if (/\btaskkill\b|\bschtasks\b|__win-relaunch|\brelaunch\.json\b/i.test(body)) failures.push(`${file}: legacy Windows relauncher`);
    for (const node of nodes(parse(body))) {
      const module = ts.isImportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (module && ts.isStringLiteralLike(module) && /(?:^|\/)(?:control|codex-bin)(?:\.ts|\.js)?$/.test(module.text)) failures.push(`${file}: legacy import`);
      if (ts.isStringLiteralLike(node) && node.text.split(/\s+/).includes('bootout')) bootouts.push({ file, node });
      if (!ts.isCallExpression(node)) continue;
      const callee = name(node.expression);
      const commandWords = node.arguments.flatMap(words);
      const managerRunner = ['d.run', 'command', 'runSystemctl', 'runLaunchctl'].includes(callee);
      const forbiddenVerb = commandWords.some(word => ['stop', 'restart', 'kill'].includes(word));
      if (callee === 'process.kill'
        || (forbiddenVerb && (managerRunner || commandWords.some(word => word === 'systemctl' || word === 'systemctl.exe')))
        || (commandWords.includes('kickstart') && commandWords.includes('-k'))) failures.push(`${file}: live daemon stop or kill`);
    }
  }
  const [bootout] = bootouts;
  if (bootouts.length !== 1 || !bootout || bootout.file !== 'service/launchd.ts' || enclosingFunction(bootout.node) !== 'unloadBarrier') failures.push('bootout must occur once inside unloadBarrier');
  const launchdCalls = nodes(parse(source['service/launchd.ts'])).filter(ts.isCallExpression).filter(call => name(call.expression) === 'unloadBarrier');
  for (const context of ['install-replacement', 'install-rollback', 'uninstall']) {
    const found = launchdCalls.some(call => {
      if (name(call.arguments[1] ?? call) !== 's') return false;
      if (context === 'uninstall') return enclosingFunction(call) === 'uninstall' && name(call.arguments[0] ?? call) === 'request';
      const request = call.arguments[0];
      const scope = property(request, 'scope');
      const kind = property(scope, 'kind');
      const actualContext = property(request, 'context');
      return enclosingFunction(call) === 'install' && actualContext !== undefined && name(actualContext) === context
        && kind !== undefined && name(kind) === (context === 'install-replacement' ? 'all-owners' : 'job-only')
        && (context !== 'install-rollback' || name(property(scope, 'context') ?? call) === context);
    });
    if (!found) failures.push(`missing unloadBarrier callsite: ${context}`);
  }
  const bootstrapNodes = nodes(parse(source['host/bootstrap.ts']));
  const calls = bootstrapNodes.filter(ts.isCallExpression);
  const registration = calls.find(call => name(call.expression) === 'readStartupRegistration');
  const owner = calls.find(call => name(call.expression) === 'readRunningPidLock');
  const registrationGuard = bootstrapNodes.filter(ts.isIfStatement).find(statement =>
    nodes(statement.expression).some(node => ts.isIdentifier(node) && node.text === 'registration')
    && nodes(statement.thenStatement).some(ts.isReturnStatement));
  const ownerGuard = bootstrapNodes.filter(ts.isIfStatement).find(statement =>
    nodes(statement.expression).some(node => ts.isIdentifier(node) && node.text === 'serviceManaged')
    && nodes(statement.thenStatement).some(node => node === owner)
    && nodes(statement.thenStatement).some(ts.isReturnStatement));
  const mutexes = calls.filter(call => name(call.expression) === 'acquireMutex');
  const pidLocks = calls.filter(call => name(call.expression) === 'acquirePidLock');
  if (!registration || !owner || !registrationGuard || !ownerGuard || mutexes.length === 0 || pidLocks.length === 0
    || [...mutexes, ...pidLocks].some(call => call.getStart() <= Math.max(registrationGuard.end, ownerGuard.end, registration.end, owner.end))
    || pidLocks.some(call => mutexes.some(mutex => mutex.getStart() > call.getStart()))) failures.push('registration and owner guard must precede both locks');
  return failures;
}

function insertInFunction(body: string, statement: string): string {
  const fn = nodes(parse(body)).find(node => ts.isFunctionDeclaration(node) && node.body !== undefined
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error('Expected a function body for mutation');
  const at = fn.body.getStart() + 1;
  const mutated = body.slice(0, at) + '\n' + statement + '\n' + body.slice(at);
  expect(ts.transpileModule(mutated, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).diagnostics ?? []).toEqual([]);
  return mutated;
}
function replaceCall(body: string, callee: string, replacement: string, context?: string): string {
  const call = nodes(parse(body)).filter(ts.isCallExpression).find(node => name(node.expression) === callee && (!context || words(node).includes(context) || enclosingFunction(node) === context));
  if (!call) throw new Error(`Missing mutation target ${callee} ${context ?? ''}`);
  return body.slice(0, call.getStart()) + replacement + body.slice(call.end);
}

describe('V5 service source identity and lifecycle guard', () => {
  it('keeps adapter identity and lifecycle on the original V5 path', () => {
    expect(violations(sources())).toEqual([]);
  });
  it.each([
    ["const label = 'ai.feishu-codex-bridge.bot';", 'legacy identity'],
    ["await import('./control.ts');", 'legacy import'],
    ["await import('./codex-bin.js');", 'legacy import'],
    ["await d.run(['--user', 'stop', unit]);", 'live daemon stop or kill'],
    ["await command(['--user', 'restart', unit]);", 'live daemon stop or kill'],
    ["await d.run(['--user', 'kill', unit]);", 'live daemon stop or kill'],
    ["spawnSync('systemctl', ['--user', 'stop', unit]);", 'live daemon stop or kill'],
    ["spawn('systemctl', ['--user', 'restart', unit]);", 'live daemon stop or kill'],
    ["execFile('systemctl', ['--user', 'kill', unit]);", 'live daemon stop or kill'],
    ["exec('systemctl --user stop vonvon-bot.service');", 'live daemon stop or kill'],
    ["await d.run(['kickstart', '-k', job]);", 'live daemon stop or kill'],
    ['process.kill(42);', 'live daemon stop or kill'],
    ["spawnSync('taskkill', ['/T', '/F', '/PID', '42']);", 'legacy Windows relauncher'],
    ["await d.run(['bootout', job]);", 'bootout must occur once inside unloadBarrier'],
  ])('rejects an executable statement mutant: %s', (statement, failure) => {
    const original = sources();
    expect(violations({ ...original, 'service/systemd.ts': insertInFunction(original['service/systemd.ts'], statement) }).some(item => item.includes(failure))).toBe(true);
  });
  it.each([
    "import { stopInstallation } from './control';",
    "import './control.ts';",
    "import { readServiceCodexBin } from './codex-bin';",
    "import './codex-bin.js';",
  ])('rejects a module import mutant: %s', statement => {
    const original = sources();
    expect(violations({ ...original, 'service/systemd.ts': statement + '\n' + original['service/systemd.ts'] })).toContain('service/systemd.ts: legacy import');
  });
  it.each(['await acquireMutex(paths.appDir, "host");', 'const earlyOwner = await acquirePidLock(paths.appDir);'])('rejects every early lock call independent of assignment: %s', statement => {
    const original = sources();
    expect(violations({ ...original, 'host/bootstrap.ts': insertInFunction(original['host/bootstrap.ts'], statement) })).toContain('registration and owner guard must precede both locks');
  });
  it('accepts lock assignment renaming without changing ordering', () => {
    const original = sources();
    const bootstrap = original['host/bootstrap.ts'].replace('lock = await acquireMutex(', 'const renamedMutex = await acquireMutex(').replace('owner = await acquirePidLock(', 'const renamedOwner = await acquirePidLock(');
    expect(violations({ ...original, 'host/bootstrap.ts': bootstrap })).toEqual([]);
  });
  it('rejects moving the real mutex call before registration', () => {
    const original = sources();
    const removed = replaceCall(original['host/bootstrap.ts'], 'acquireMutex', 'undefined');
    expect(violations({ ...original, 'host/bootstrap.ts': insertInFunction(removed, 'await acquireMutex(paths.appDir, "host");') })).toContain('registration and owner guard must precede both locks');
  });
  it.each(['install-replacement', 'install-rollback', 'uninstall'])('rejects dropping the %s unload barrier callsite', context => {
    const original = sources();
    const changed = replaceCall(original['service/launchd.ts'], 'unloadBarrier', "Promise.resolve({ kind: 'unloaded' })", context);
    expect(violations({ ...original, 'service/launchd.ts': changed })).toContain(`missing unloadBarrier callsite: ${context}`);
  });
  it('rejects moving the sole bootout outside unloadBarrier', () => {
    const original = sources();
    const launchd = original['service/launchd.ts'].replace("['bootout', job]", "['print', job]");
    expect(launchd).not.toBe(original['service/launchd.ts']);
    expect(violations({ ...original, 'service/launchd.ts': launchd, 'service/systemd.ts': insertInFunction(original['service/systemd.ts'], "await d.run(['bootout', job]);") })).toContain('bootout must occur once inside unloadBarrier');
  });
});
