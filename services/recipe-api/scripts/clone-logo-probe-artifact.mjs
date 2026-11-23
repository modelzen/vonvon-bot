import { cp } from 'node:fs/promises';
import { validateDecoderRoot } from '../src/logo-sandbox.mjs';

export async function cloneLogoProbeArtifact(original, target) {
  validateDecoderRoot(original);
  await cp(original,target,{recursive:true,verbatimSymlinks:true});
  return validateDecoderRoot(target);
}
