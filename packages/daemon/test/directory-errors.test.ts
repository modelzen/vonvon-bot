import { expect, it } from 'vitest';
import { DirectoryError, directoryFailure } from '../src/config/directory-errors';

it('tells a missing volume, a held bots lock and the rest in Chinese, and passes others through (s36c2d)', () => {
  const told = (error: Error, bot?: string) => {
    const failure = directoryFailure(error, bot);
    expect(failure).toBeInstanceOf(DirectoryError);
    expect((failure as Error).cause).toBe(error);
    return (failure as Error).message;
  };
  expect(told(new Error('Namespace volume missing'), '研发助手')).toBe('「研发助手」的项目根目录不在了，它原来在另一块盘上。外接盘没接上的话，接上后重试；'
    + '整机迁移过的话，在原处建回这个文件夹后，在终端运行 vonvon bot repair-dir 研发助手，按现在的位置重新记录');
  expect(told(new Error('Bridge bots is busy on its local coordination endpoint.'))).toBe('另一个 vonvon 进程正在改 bot 的目录记录，稍后再试');
  expect(told(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('目录所在的位置不在了（外接盘没接上的话，接上后重试）');
  const other = new Error('Bridge projects is busy on its local coordination endpoint.');
  expect(directoryFailure(other)).toBe(other);
});
