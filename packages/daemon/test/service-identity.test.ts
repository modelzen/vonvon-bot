import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const adapterNames = ['launchd', 'systemd', 'win-startup', 'adapter'] as const;
const adapterSources = adapterNames.map(name => {
  const path = fileURLToPath(new URL(`../src/service/${name}.ts`, import.meta.url));
  const source = readFileSync(path, 'utf8');
  return { name, source, ast: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true) };
});

function callsIn(ast: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return calls;
}

function literal(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function arrayStrings(node: ts.Node | undefined): string[] {
  return node && ts.isArrayLiteralExpression(node)
    ? node.elements.map(element => literal(element)).filter((value): value is string => value !== null)
    : [];
}

function commandArrays(node: ts.Node | undefined): string[][] {
  if (node && ts.isConditionalExpression(node)) {
    return [...commandArrays(node.whenTrue), ...commandArrays(node.whenFalse)];
  }
  return node && ts.isArrayLiteralExpression(node) ? [arrayStrings(node)] : [];
}

function isRun(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'd' && call.expression.name.text === 'run';
}

function isSpawn(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && ['spawn', 'spawnSync'].includes(call.expression.text);
}

function enclosingFunction(node: ts.Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
  }
  return null;
}

describe('V5 service adapter identity', () => {
  it.each(adapterSources)('$name has no legacy Bridge service identifier', ({ source }) => {
    expect(source).not.toMatch(/(?:ai\.)?feishu-codex-bridge/i);
  });

  it.each(adapterSources)('$name does not import legacy control or Codex binary resolution', ({ ast }) => {
    const imports = ast.statements
      .filter(ts.isImportDeclaration)
      .map(statement => literal(statement.moduleSpecifier));
    expect(imports.filter(path => path && /(?:^|\/)(?:control|codex-bin)(?:\.(?:ts|js))?$/.test(path))).toEqual([]);
  });

  it.each(adapterSources)('$name never dispatches a manager or process force-stop', ({ name, ast }) => {
    const forbidden = callsIn(ast).flatMap(call => {
      const executable = isSpawn(call) ? literal(call.arguments[0]) : null;
      const options = isSpawn(call) ? commandArrays(call.arguments[1]) : [];
      if (executable === 'taskkill') return ['taskkill'];
      if (executable === 'systemctl' && options.some(args => args.some(arg => ['stop', 'restart', 'kill'].includes(arg)))) return ['systemctl force-stop'];
      if (executable === '/bin/launchctl' && options.some(args => args.includes('kickstart') && args.includes('-k'))) return ['kickstart -k'];
      const forwarded = isRun(call) || name === 'systemd' && ts.isIdentifier(call.expression) && call.expression.text === 'command';
      const args = forwarded ? commandArrays(call.arguments[0]) : [];
      if (name === 'systemd' && args.some(command => command.some(arg => ['stop', 'restart', 'kill'].includes(arg)))) return ['systemctl force-stop'];
      if (name === 'launchd' && isRun(call) && args.some(command => command.includes('kickstart') && command.includes('-k'))) return ['kickstart -k'];
      return [];
    });
    expect(forbidden).toEqual([]);
  });

  it('dispatches exactly one bootout, inside launchd unloadBarrier', () => {
    const occurrences = adapterSources.flatMap(({ name, ast }) => callsIn(ast).flatMap(call => {
      const commands = isRun(call) ? commandArrays(call.arguments[0]) : [];
      const executable = isSpawn(call) ? literal(call.arguments[0]) : null;
      const options = executable === '/bin/launchctl' ? commandArrays(call.arguments[1]) : [];
      return commands.some(args => args[0] === 'bootout') || executable === 'bootout' || options.some(args => args[0] === 'bootout')
        ? [`${name}:${enclosingFunction(call)}`] : [];
    }));
    expect(occurrences).toEqual(['launchd:unloadBarrier']);
  });

  it('routes uninstall, install replacement, and install rollback through unloadBarrier', () => {
    const launchd = adapterSources.find(source => source.name === 'launchd');
    if (!launchd) throw new Error('launchd adapter source missing');
    const ast = launchd.ast;
    const contexts = callsIn(ast).flatMap(call => {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'unloadBarrier') return [];
      const request = call.arguments[0];
      if (!request || !ts.isObjectLiteralExpression(request)) return [];
      return request.properties.flatMap(property =>
        ts.isPropertyAssignment(property) && property.name.getText(ast) === 'context'
          ? [literal(property.initializer)] : []);
    });
    expect(contexts).toContain('install-replacement');
    expect(contexts).toContain('install-rollback');
    const uninstall = (() => {
      let found: ts.MethodDeclaration | undefined;
      function visit(node: ts.Node): void {
        if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'uninstall') found = node;
        ts.forEachChild(node, visit);
      }
      visit(ast);
      return found;
    })();
    expect(uninstall).toBeDefined();
    if (!uninstall) return;
    expect(callsIn(ast).some(call =>
      ts.isIdentifier(call.expression) && call.expression.text === 'unloadBarrier'
        && call.pos >= uninstall.pos && call.end <= uninstall.end)).toBe(true);
    expect(uninstall.getText(ast)).toContain("context: 'uninstall'");
  });
});
