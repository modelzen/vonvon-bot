import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {directFeedbackAttachments} from '../src/feedback/attachments';

let root: string;
beforeEach(async () => {root = await mkdtemp(join(tmpdir(), 'feedback-resources-'));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});
const message: NormalizedMessage = {chatType: 'group', chatId: 'oc_g', messageId: 'om_1', senderId: 'ou_a',
  rawContentType: 'post', resources: [{type: 'file', fileKey: 'belongs-to-om1', fileName: '../../clip.jpg'},
    {type: 'image', fileKey: 'img_1'}, {type: 'file', fileKey: 'belongs-to-om1'}],
  content: '图片', mentions: [], mentionAll: false, mentionedBot: true, createTime: 1};
const signal = new AbortController().signal;

it('maps only direct descriptors from this exact message to opaque references', async () => {
  const files = directFeedbackAttachments(message);
  const [first] = files.refs;
  expect(files.refs.map(item => item.name)).toEqual(['clip.jpg', '图片']);
  expect(directFeedbackAttachments({...message, rawContentType: 'merge_forward'}).refs).toEqual([]);
  const get = vi.fn(async () => Readable.from(['selected']));
  const read = async (paths: readonly string[]) => Promise.all(paths.map(path => readFile(path, 'utf8')));
  for (const illegal of [['/etc/hosts'], [directFeedbackAttachments(message).refs[0]!.ref], [first!.ref, first!.ref]]) {
    await expect(files.withFiles(illegal, root, get, signal, read)).rejects.toThrow();
  }
  expect(get).not.toHaveBeenCalled();
  expect(await files.withFiles([], root, get, signal, read)).toEqual([]);
  expect(await files.withFiles([first!.ref], root, get, signal, read)).toEqual(['selected']);
  expect(get).toHaveBeenCalledWith('om_1', {type: 'file', key: 'belongs-to-om1', name: 'clip.jpg'});
  expect(await readdir(root)).toEqual([]);
});

it.each([[21], [20, 20, 1], [0]])('bounds streaming bytes without content length and cleans staging for %j MiB', async (...sizes) => {
  const files = directFeedbackAttachments({...message, resources: sizes.map((_, i) => ({type: 'file', fileKey: String(i)}))});
  const use = vi.fn();
  await expect(files.withFiles(files.refs.map(r => r.ref), root, async (_, resource) => {
    const chunk = Buffer.alloc(1024 * 1024);
    return Readable.from((function* () {for (let i = 0; i < sizes[Number(resource.key)]!; i++) yield chunk;})());
  }, signal, use)).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
