import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function assertPreviewStage(appDir, config) {
  if (config.appId !== 'com.vonvon.bot.preview' || config.productName !== 'Vonvon Bot Preview') {
    throw new Error('Preview packaging requires its distinct application identity');
  }
  const metadata = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
  const stamp = JSON.parse(await readFile(join(appDir, 'dist/preview-config.json'), 'utf8'));
  const updates = JSON.parse(await readFile(join(appDir, 'dist/update-config.json'), 'utf8'));
  const bytes = await readFile(join(appDir, 'desktop/main.cjs'));
  if (metadata.name !== 'vonvon-bot-preview' || stamp.format !== 1 || stamp.channel !== 'preview' ||
      stamp.mainSha256 !== createHash('sha256').update(bytes).digest('hex') ||
      Object.keys(updates).length !== 0) throw new Error('Build the isolated Preview entry before packaging');
  for (const name of ['webOrigin', 'apiOrigin']) {
    const url = new URL(stamp[name]);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== stamp[name]) {
      throw new Error('Preview requires explicitly compiled HTTPS account origins');
    }
  }
}

export default async function beforePack({packager}) {
  await assertPreviewStage(packager.info.appDir, packager.config);
}
