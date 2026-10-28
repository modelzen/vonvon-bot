import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after packaging so the pinned NSIS compiler and plugins are available.
// Compile the real electron-builder functions and our hook, then exercise them
// against a private registry key and fake versioned application/uninstaller.
// Neither an installed Vonvon application nor its registry/data is used.
const [compiler, includes, plugins] = process.argv.slice(2);
if (process.platform !== 'win32' || !compiler || !includes || !plugins) {
  throw new Error('Usage on Windows: node scripts/windows-installer-smoke.mjs <makensis.exe> <NSIS template include dir> <plugin dir>');
}
const root = await mkdtemp(join(tmpdir(), 'vonvon-installer-smoke-'));
const registryKey = `Software\\VonvonInstallerSmoke\\${randomUUID()}`;
const hook = join(dirname(fileURLToPath(import.meta.url)), '../packages/desktop/assets/windows-installer.nsh');
const nsisPath = value => value.replaceAll('/', '\\').replaceAll('$', () => '$$');
const run = (file, args, timeout = 30_000) => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (result.error) throw result.error;
  return result;
};
async function compile(name, body, version) {
  const exe = join(root, `${name}.exe`);
  const source = join(root, `${name}.nsi`);
  await writeFile(source, `Unicode true
Name "Vonvon installer regression fixture"
OutFile "${nsisPath(exe)}"
RequestExecutionLevel user
SilentInstall silent
${version ? `VIProductVersion "${version}"
VIAddVersionKey /LANG=1033 "ProductName" "Vonvon fixture"
VIAddVersionKey /LANG=1033 "FileVersion" "${version}"
VIAddVersionKey /LANG=1033 "FileDescription" "Installer test fixture"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Test fixture"` : ''}
${body}
`);
  const built = run(compiler, ['/V2', source]);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.doesNotMatch(built.stdout + built.stderr, /unknown variable|warning 6000/i);
  return exe;
}

try {
  const cases = [
    { name: 'fresh-install', registration: false, expected: 0 },
    { name: 'orphan-registration', expected: 0 },
    { name: 'orphan-after-nonzero-error', priorExit: 7, expected: 2 },
    { name: 'orphan-with-new-destination', destinationApp: true, expected: 0 },
    { name: 'orphan-without-install-location', location: false, expected: 0 },
    { name: 'old-app-without-install-location', location: false, app: true, expected: 2 },
    { name: 'unquoted-registration', registration: 'malformed', expected: 2 },
    { name: 'missing-uninstaller-with-old-app', app: true, expected: 2 },
    { name: 'successful-uninstall', app: true, uninstaller: 'success', expected: 0 },
    { name: 'failed-uninstall', app: true, uninstaller: 'failure', expected: 2 },
    { name: 'failed-uninstaller-without-app', uninstaller: 'failure', expected: 2 },
    { name: 'legacy-uninstall-recovery', app: true, uninstaller: 'legacy', expected: 0 },
    { name: 'other-mode-failure', mode: 'all', expected: 2 },
  ];
  for (const c of cases) {
    const oldDir = join(root, c.name, 'old');
    const destination = join(root, c.name, 'new');
    await mkdir(oldDir, { recursive: true });
    await mkdir(destination, { recursive: true });
    const argsLog = join(root, c.name, 'uninstaller-args.txt');
    const helper = await compile(`${c.name}-helper`, `!include "FileFunc.nsh"
!include "LogicLib.nsh"
Section
  FileOpen $0 "${nsisPath(argsLog)}" a
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE$\\r$\\n"
  FileClose $0
  ${c.uninstaller === 'legacy' ? `\${GetParameters} $0
  ClearErrors
  \${GetOptions} $0 "--updated" $1
  IfErrors +3
  SetErrorLevel 2
  Quit` : c.uninstaller === 'failure' ? 'SetErrorLevel 2' : 'SetErrorLevel 0'}
SectionEnd`, c.uninstaller === 'legacy' ? '0.7.5.0' : '0.7.6.0');
    if (c.app) await copyFile(helper, join(oldDir, 'Vonvon Bot.exe'));
    if (c.destinationApp) await copyFile(helper, join(destination, 'Vonvon Bot.exe'));
    if (c.uninstaller) await copyFile(helper, join(oldDir, 'Uninstall.exe'));
    const sentinel = join(oldDir, 'user-data-sentinel');
    await writeFile(sentinel, 'keep existing data');
    const fixture = await compile(c.name, `!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addincludedir "${nsisPath(includes)}"
!addplugindir /x86-unicode "${nsisPath(plugins)}"
!include "StdUtils.nsh"
!define APP_EXECUTABLE_FILENAME "Vonvon Bot.exe"
!define UNINSTALL_REGISTRY_KEY "${registryKey}"
!define INSTALL_REGISTRY_KEY "${registryKey}"
!define isDeleteAppData '"false" == "true"'
Var installMode
Var perUserInstallationFolder
Var appExe
LangString uninstallFailed 1033 "Uninstall failed"
LangString appCannotBeClosed 1033 "App could not be closed"
!include "${nsisPath(hook)}"
!include "installUtil.nsh"
Section
  SetShellVarContext current
  SetRegView 64
  StrCpy $installMode "${c.mode ?? 'CurrentUser'}"
  StrCpy $perUserInstallationFolder "${c.location === false ? '' : nsisPath(oldDir)}"
  StrCpy $INSTDIR "${nsisPath(destination)}"
  StrCpy $appExe "$INSTDIR\\Vonvon Bot.exe"
  ${c.registration === false ? '' : `WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" UninstallString '${c.registration === 'malformed' ? nsisPath(join(oldDir, 'Uninstall.exe')) : `"${nsisPath(join(oldDir, 'Uninstall.exe'))}" /currentuser`}'
  ${c.location === false ? '' : `WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation "${nsisPath(oldDir)}"`}`}
  InitPluginsDir
  !insertmacro uninstallOldVersion SHELL_CONTEXT
  ${c.priorExit ? `StrCpy $R0 ${c.priorExit}` : ''}
  !insertmacro handleUninstallResult SHELL_CONTEXT
SectionEnd`);
    const result = run(fixture, ['/S']);
    assert.equal(result.status, c.expected, `${c.name}: ${result.stdout}${result.stderr}`);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep existing data');
    if (c.uninstaller === 'legacy') {
      const invocations = (await readFile(argsLog, 'utf8')).trim().split(/\r?\n/);
      assert.ok(invocations.some(line => line.includes('--updated')), JSON.stringify(invocations));
      const recovery = invocations.find(line => line.includes('--keep-shortcuts'));
      assert.ok(recovery?.includes(`/currentuser _?=${oldDir}`));
      assert.ok(recovery.includes('/KEEP_APP_DATA'));
      assert.ok(!recovery.includes('--updated') && !recovery.includes('--delete-app-data'));
    }
    // This is only our randomly named fixture key, in the view we wrote.
    run('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64']);
    process.stdout.write(`PASS ${c.name}\n`);
  }
} finally {
  run('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64']);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
