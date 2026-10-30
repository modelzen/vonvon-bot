import {execFile} from 'node:child_process';
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
export async function compileWindowsInstaller({out, architecture = 'x64', hookFile = join(root, 'packages/desktop/assets/windows-installer.nsh')}) {
  if (!isAbsolute(out) || !['x64', 'arm64'].includes(architecture)) throw Error('Use an absolute dedicated output folder and a supported architecture');
  await mkdir(out, {recursive:true});
  let sequence = 0;
  const target = {options:{oneClick:false, include:hookFile, installerLanguages:['en_US','zh_CN']}, isUnicodeEnabled:true, isPortable:false,
    packager:{config:{}, info:{cancellationToken:{cancelled:false}, buildResourcesDir:join(root, 'packages/desktop/assets')},
      getResource:async () => hookFile, getTempFile:async () => join(out, `messages-${++sequence}.nsh`)}};
  const header = await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(target);
  const templates = join(root, 'node_modules/app-builder-lib/templates/nsis');
  const output = join(out, 'installer.exe'), source = join(out, 'installer.nsi');
  await writeFile(source, `Unicode true
!define PRODUCT_NAME "Vonvon installer compile fixture"
!define VERSION "0.0.0"
!define PRODUCT_FILENAME "Vonvon installer compile fixture"
!define APP_FILENAME "Vonvon installer compile fixture"
!define APP_GUID "VonvonInstallerCompileFixture"
!define UNINSTALL_APP_KEY "VonvonInstallerCompileFixture"
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
Function .onInit
  !insertmacro initMultiUser
  !insertmacro customInit
FunctionEnd
Section
  StrCpy $launchLink "$INSTDIR\\fixture.exe"
SectionEnd
`);
  const compiler = await getMakeNsisPath();
  const result = await execute(compiler.path, ['-V2', source], {cwd:templates, env:{...process.env, ...compiler.env}, timeout:60000, maxBuffer:2*1024*1024});
  const bytes = await readFile(output);
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('NSIS did not produce a Windows executable');
  return {architecture, output, bytes:bytes.length, diagnostics:result.stdout + result.stderr};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await compileWindowsInstaller({out:process.argv[2], architecture:process.argv[3]})));
}
