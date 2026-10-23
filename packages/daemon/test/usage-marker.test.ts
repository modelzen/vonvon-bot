import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { libraryLocation } from '../src/project/library';
import { deliveredIds, recordUsage, settleTurn } from '../src/bot/turn-usage';
import { parseUsageMarkers } from '../src/bot/usage-marker';
import type { SessionContext } from '../src/bot/session-store';

const IDS = new Set(['p_prj_0a1b2c3d:k2qa', 'b:9p1x', 'p_prj_0a1b2c3d:r4t7']);
const parse = (text: string, nonce = '7f3a') => parseUsageMarkers(text, nonce, IDS);

describe('<vonvon-mem> parsing', () => {
  it('reads the ids of a marker that carries the session mark', () => {
    expect(parse('好的。\n<vonvon-mem n="7f3a" used="p_prj_0a1b2c3d:k2qa,b:9p1x"/>')).toEqual(['p_prj_0a1b2c3d:k2qa', 'b:9p1x']);
    expect(parse(`<vonvon-mem n='7f3a' used='b:9p1x'>`)).toEqual(['b:9p1x']);
    expect(parse('<vonvon-mem used="b:9p1x" n="7f3a" />')).toEqual(['b:9p1x']);
  });
  it('ignores a marker with another mark or none', () => {
    expect(parse('<vonvon-mem n="0000" used="b:9p1x"/>')).toEqual([]);
    expect(parse('<vonvon-mem used="b:9p1x"/>')).toEqual([]);
    expect(parse('<vonvon-mem n="7f3a" used="b:9p1x"/>', '')).toEqual([]);
  });
  it('drops an id the session was not handed, and repeats', () => {
    expect(parse('<vonvon-mem n="7f3a" used="b:9p1x,b:zzzz,p_prj_ffffffff:aaaa,b:9p1x"/>')).toEqual(['b:9p1x']);
    expect(parse('<vonvon-mem n="7f3a" used="../../etc/passwd, b:9p1x，p_prj_0a1b2c3d:r4t7"/>')).toEqual(['b:9p1x', 'p_prj_0a1b2c3d:r4t7']);
  });
  it('adds several markers up and finds none in text without one', () => {
    expect(parse('<vonvon-mem n="7f3a" used="b:9p1x"/> 中间 <vonvon-mem n="7f3a" used="p_prj_0a1b2c3d:k2qa"/>')).toEqual(['b:9p1x', 'p_prj_0a1b2c3d:k2qa']);
    expect(parse('没有用到记忆')).toEqual([]);
    expect(parse('＜vonvon-mem n="7f3a" used="b:9p1x"/>')).toEqual([]);
  });
});

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const PROJECT = 'prj_0a1b2c3d';

function context(): SessionContext {
  return {
    versions: { role: 'aaaaaa' }, nonce: '7f3a',
    memory: {
      bot: { storeId: 'b', branches: ['合作方式'], items: { 'b:9p1x': ['h1', '合作方式', 1] } },
      project: { storeId: `p_${PROJECT}`, branches: ['决定'], items: { [`p_${PROJECT}:k2qa`]: ['h2', '决定', 1], [`p_${PROJECT}:r4t7`]: ['h3', '决定', 0] } },
    },
    lastTurn: { at: 1, injected: 3, used: [] },
  };
}

describe('the end of a turn', () => {
  it('records how many entries the session holds and only those the model named that it holds', () => {
    const delivered = context();
    expect(deliveredIds(delivered).size).toBe(3);
    const { context: next, used } = settleTurn(delivered, `好\n<vonvon-mem n="7f3a" used="b:9p1x,p_${PROJECT}:gone,p_${PROJECT}:r4t7"/>`, 99);
    expect(used).toEqual(['b:9p1x', `p_${PROJECT}:r4t7`]);
    expect(next.lastTurn).toEqual({ at: 99, injected: 3, used });
    // what the next turn hands over is not touched
    expect(next.versions).toEqual(delivered.versions);
    expect(next.nonce).toBe('7f3a');
    expect(next.memory).toEqual(delivered.memory);
  });

  it('counts a turn without a marker as using nothing', () => {
    expect(settleTurn(context(), '这一轮没用记忆', 5).context.lastTurn).toEqual({ at: 5, injected: 3, used: [] });
  });

  it('writes usage.json of the memory each id came from, and nothing for an unmarked turn', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-marker-')));
    roots.push(dir);
    const location = projectMemoryLocation(PROJECT, { library: libraryLocation(dir) });
    const project = new MemoryStore(location);
    const bot = new MemoryStore(botMemoryLocation(join(dir, 'bots', 'cli_a')));
    const delivered = context();
    await recordUsage(delivered, [], { bot, project });
    expect(await project.readUsage()).toEqual({});
    await recordUsage(delivered, ['b:9p1x', `p_${PROJECT}:k2qa`], { bot, project });
    await recordUsage(delivered, [`p_${PROJECT}:k2qa`], { bot, project });
    expect(Object.keys(await bot.readUsage())).toEqual(['b:9p1x']);
    const usage = await project.readUsage();
    expect(Object.keys(usage)).toEqual([`p_${PROJECT}:k2qa`]);
    expect(usage[`p_${PROJECT}:k2qa`]!.useCount).toBe(2);
    expect(JSON.parse(readFileSync(join(location.dir, 'usage.json'), 'utf8'))[`p_${PROJECT}:k2qa`].lastUsedAt).toBeGreaterThan(0);
    await recordUsage(delivered, ['b:9p1x'], undefined);
  });
});
