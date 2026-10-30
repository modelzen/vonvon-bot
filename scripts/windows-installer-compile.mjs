import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
// Initialize the public entry point before loading its internal target class.
require('app-builder-lib');
const {NsisTarget} = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
const {getMakeNsisPath} = require('app-builder-lib/out/toolsets/windows.js');
const execute = promisify(execFile);

/** Compile the real generated builder header and assisted pages without building
 * Electron or running a Windows executable. Only the application payload is omitted. */
export async function compileWindowsInstaller({out, architecture = 'x64', uninstaller = false, hookFile = join(root, 'packages/desktop/assets/windows-installer.nsh'), env = process.env}) {
  if (!isAbsolute(out) || !['x64', 'arm64'].includes(architecture)) throw Error('Use an absolute dedicated output folder and a supported architecture');
  await mkdir(out, {recursive:true});
  let sequence = 0;
  const target = {options:{oneClick:false, include:hookFile, installerLanguages:['en_US','zh_CN']}, isUnicodeEnabled:true, isPortable:false,
    packager:{config:{}, info:{cancellationToken:{cancelled:false}, buildResourcesDir:join(root, 'packages/desktop/assets')},
      getResource:async () => hookFile, getTempFile:async () => join(out, `messages-${++sequence}.nsh`)}};
  const header = await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(target);
  const templates = join(root, 'node_modules/app-builder-lib/templates/nsis');
  const installSection = await readFile(join(templates, 'installSection.nsh'), 'utf8');
  const launchStart = installSection.indexOf('!macro doStartApp');
  if (launchStart < 0) throw Error('NSIS install launch template changed; update the compile fixture');
  // Keep the real launch tail: its StartApp expansion declares a global which
  // must not also be declared by the custom finish-page function.
  const launchSection = installSection.slice(launchStart);
  const initializer = uninstaller ? (await readFile(join(templates, 'uninstaller.nsh'), 'utf8')).match(/Function un.onInit[\s\S]*?FunctionEnd/)?.[0] : `Function .onInit
  !insertmacro initMultiUser
  !insertmacro customInit
FunctionEnd`;
  if (!initializer) throw Error('NSIS uninstaller initialization changed');
  const output = join(out, 'installer.exe'), source = join(out, 'installer.nsi');
  await writeFile(source, `Unicode true
${uninstaller ? '!define BUILD_UNINSTALLER' : ''}
!define PRODUCT_NAME "Vonvon installer compile fixture"
!define VERSION "0.0.0"
!define PRODUCT_FILENAME "Vonvon installer compile fixture"
!define APP_FILENAME "Vonvon installer compile fixture"
!define APP_GUID "VonvonInstallerCompileFixture-${randomUUID()}"
!define UNINSTALL_APP_KEY "VonvonInstallerCompileFixture-${randomUUID()}"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define ${architecture === 'arm64' ? 'APP_ARM64' : 'APP_64'}
!define allowToChangeInstallationDirectory
${header}
!addincludedir "${templates}"
!include "${join(templates, 'common.nsh')}"
!include MUI2.nsh
!include "${join(templates, 'multiUser.nsh')}"
OutFile "${output}"
RequestExecutionLevel user
Var appExe
Var launchLink
!include "${join(templates, 'assistedInstaller.nsh')}"
!insertmacro addLangs
!ifmacrodef customHeader
  !insertmacro customHeader
!endif
${uninstaller ? 'Function un.checkAppRunning\nFunctionEnd' : ''}
${initializer}
Section
  StrCpy $launchLink "$INSTDIR\\fixture.exe"
${uninstaller ? `WriteUninstaller "${join(out, 'uninstaller.exe')}"` : launchSection}
SectionEnd
${uninstaller ? 'Section "un.Uninstall"\nSectionEnd' : ''}
`);
  const compiler = await getMakeNsisPath();
  // Match NsisTarget.executeMakensis and builder-util's macOS child locale.
  // macOS iconv still needs UTF-8 locale even with explicit INPUTCHARSET.
  const locale = process.platform === 'darwin' ? {LANG:'en_US.UTF-8', LC_CTYPE:'en_US.UTF-8', LC_ALL:'en_US.UTF-8'} : {};
  const result = await execute(compiler.path, ['-INPUTCHARSET', 'UTF8', '-V2', source], {cwd:templates, env:{...env, ...compiler.env, ...locale}, timeout:60000, maxBuffer:2*1024*1024});
  const bytes = await readFile(output);
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('NSIS did not produce a Windows executable');
  return {architecture, output, bytes:bytes.length, diagnostics:result.stdout + result.stderr};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await compileWindowsInstaller({out:process.argv[2], architecture:process.argv[3]})));
}
