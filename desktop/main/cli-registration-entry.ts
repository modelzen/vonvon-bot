import {join} from 'node:path';
import {registerCli,removeCli,type CliRegistrationOptions} from './cli-registration';

async function main():Promise<void> {
  const [action,scope,appRoot]=process.argv.slice(2);
  if ((action!=='install'&&action!=='remove') || (scope!=='user'&&scope!=='system') || !appRoot)
    throw new Error('Usage: cli-registration install|remove user|system APP_ROOT');
  const platform=process.platform;
  if (platform!=='darwin'&&platform!=='win32') throw new Error('Unsupported platform.');
  const options:CliRegistrationOptions={platform,scope,runtime:join(appRoot,platform==='darwin'?'Contents/Resources/runtime':'resources/runtime')};
  const result=await (action==='install'?registerCli(options):removeCli(options));
  process.stdout.write(`${result.message}\n`);
  if (result.kind==='error') process.exitCode=1;
}

void main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
