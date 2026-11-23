// Read an approved feedback record from the Vonvon feedback center for development.
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {feedbackBoardUrl} from './center.mjs';

const exec = promisify(execFile);
const board = new URL(feedbackBoardUrl);
const base = board.pathname.split('/').at(-1);
const table = board.searchParams.get('table');
const columns = [
  '跟进编号', '反馈标题', '类型', '状态', '涉及功能', '影响程度', '详细说明', '如何重现', '期望效果', '使用环境',
  '排查记录', '源码依据', '待验证问题', '使用场景与现有做法', '验收标准', '截图与附件',
  '开发者回复', '结束原因', '已发布版本', '关联反馈',
];

async function readReport(id) {
  const recordId = /^rec[A-Za-z0-9]+$/.test(id);
  if (!recordId && !/^VV-[A-F0-9]{8,32}$/.test(id)) throw new Error('请输入一条反馈的跟进编号（VV-…）或飞书记录 ID（rec…）。');
  const select = recordId ? ['+record-get', '--record-id', id] : [
    '+record-list', '--filter-json', JSON.stringify({logic: 'and', conditions: [['跟进编号', '==', id]]}), '--limit', '2',
  ];
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-feedback-read-'));
  try {
    const args = ['base', ...select, '--base-token', base, '--table-id', table,
      ...columns.flatMap(field => ['--field-id', field]), '--as', 'user', '--format', 'ndjson', '--output', 'report.ndjson'];
    const {stdout} = await exec('lark-cli', args, {cwd: dir, timeout: 30_000, maxBuffer: 1_000_000});
    const receipt = JSON.parse(stdout);
    if (receipt.base_token !== base || receipt.table_id !== table || receipt.has_more || receipt.records_count !== 1) {
      throw new Error(receipt.records_count === 0 ? '找不到这条反馈。' : '未取得唯一且完整的反馈，请核对记录 ID。');
    }
    const lines = (await readFile(join(dir, 'report.ndjson'), 'utf8')).trim().split('\n');
    if (lines.length !== 1) throw new Error('反馈行数与飞书回执不符。');
    const row = JSON.parse(lines[0]);
    if (!/^rec[A-Za-z0-9]+$/.test(row.record_id) || (recordId ? row.record_id : row['跟进编号']) !== id) {
      throw new Error('返回的反馈与所选记录不一致。');
    }
    // Attachment URLs can be signed. Only expose display names to the development Agent.
    if (row['截图与附件'] != null) {
      const attachments = row['截图与附件'];
      row['截图与附件'] = Array.isArray(attachments) ? attachments.map(file => file?.name || '附件') : ['见原记录'];
    }
    return Object.fromEntries(['record_id', ...columns].filter(key => row[key] != null && row[key] !== '').map(key => [key, row[key]]));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

try {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/feedback/read-report.mjs <跟进编号或记录 ID>');
  console.log(JSON.stringify(await readReport(process.argv[2]), null, 2));
} catch (error) {
  // Do not echo a failed CLI invocation, credentials or server response bodies.
  console.error(error.cmd || error.code === 'ENOENT' ? '读取失败，请检查本机 lark-cli 及当前飞书账号对反馈表的读取权限。' : error.message);
  process.exitCode = 1;
}
