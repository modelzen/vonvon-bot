import { FeishuReadRefused } from './denial';
import { cleanCell, parseRef, reading } from './documents';
import { ask, jsonBytes, RESULT_BUDGET, type ReadDeps } from './shared';

export interface BaseCondition { field: string; operator: string; value?: string[] }
export interface BaseFilter { conjunction?: 'and' | 'or'; conditions: BaseCondition[] }
export interface PageRequest { limit?: number; cursor?: string }
export interface BaseRequest extends PageRequest {
  base: string;
  /** Without it: the tables if there is no table, else the records. */
  what?: 'tables' | 'fields' | 'views' | 'records';
  table?: string;
  view?: string;
  fields?: string[];
  filter?: BaseFilter;
}
/** Items as Feishu gave them: what a cell holds depends on the field's type, and the model reads it as it is. */
export interface BasePage { items: unknown[]; total?: number; cursor?: string }

/** Feishu's page: the same size every time, so a cursor's place in one stays right whatever `limit` asks for next. */
const PAGE_SIZE = 100;
export interface FeishuPage { code?: number; data?: { items?: unknown[]; has_more?: boolean; page_token?: string; total?: number } }

/** A page may not fit one result, so the cursor is where in which Feishu page: `<items to skip>:<page_token>`. */
function pagePlace(cursor: string | undefined): { skip: number; pageToken?: string } {
  if (cursor === undefined) return { skip: 0 };
  const match = /^(\d+):(.*)$/.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new FeishuReadRefused('cursor 不对：用上一次结果里的 cursor，原样传回来。');
  return { skip: Number(match[1]), ...(match[2] ? { pageToken: match[2] } : {}) };
}

/** One Feishu page from the cursor's place, as much of it as fits. */
export async function pageOf(request: PageRequest, call: (pageToken: string | undefined) => Promise<FeishuPage>, tooBig = '这一条太大，一次读不完。读记录时用 fields 少读几列。'): Promise<BasePage> {
  const { skip, pageToken } = pagePlace(request.cursor);
  const data = (await call(pageToken)).data;
  const found = data?.items ?? [];
  const items: unknown[] = [];
  const total = data?.total !== undefined ? { total: data.total } : {};
  const here = (index: number): string => `${index}:${pageToken ?? ''}`;
  let used = 0;
  for (let index = skip; index < found.length; index++) {
    if (items.length === request.limit) return { items, ...total, cursor: here(index) };
    const clean = cleanCell(found[index]);
    used += jsonBytes(clean);
    if (used > RESULT_BUDGET) {
      if (!items.length) throw new FeishuReadRefused(tooBig);
      return { items, ...total, cursor: here(index) };
    }
    items.push(clean);
  }
  return { items, ...total, ...(data?.has_more && data.page_token ? { cursor: `0:${data.page_token}` } : {}) };
}

/** `field` here is Feishu's `field_name`; `isEmpty` and `isNotEmpty` still want a `value`, an empty one. */
const filterBody = ({ conjunction, conditions }: BaseFilter): Record<string, unknown> => ({ conjunction: conjunction ?? 'and',
  conditions: conditions.map(({ field, operator, value }) => ({ field_name: field, operator, value: value ?? [] })) });

/**
 * Read a 多维表格 (dm-agent 7.1): its tables, one table's fields or views, or its records. One Feishu page per call. Records
 * always go through `records/search`, which takes a view and a filter both; Feishu ignores the view when there is a filter.
 */
export async function readBase(deps: ReadDeps, request: BaseRequest): Promise<BasePage> {
  const ref = parseRef(request.base);
  const table = request.table ?? ref.tableId, view = request.view ?? ref.viewId;
  const what = request.what ?? (table ? 'records' : 'tables');
  if (what !== 'tables' && !table) throw new FeishuReadRefused(`读 ${what} 要写 table：数据表的 id，在 what: tables 的结果里。`);
  if (what !== 'records' && (request.fields || request.filter)) throw new FeishuReadRefused('fields 和 filter 只用于读记录（what: records）。');
  return reading(deps, ref, 'bitable', token => {
    const app = `/open-apis/bitable/v1/apps/${encodeURIComponent(token)}`;
    const tablePath = `${app}/tables/${encodeURIComponent(table ?? '')}`;
    const params = (pageToken: string | undefined) => ({ page_size: PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) });
    const get = (url: string, extra: Record<string, string> = {}) => pageOf(request, pageToken =>
      ask(deps, 'base', () => deps.channel.rawClient.request<FeishuPage>({ method: 'GET', url, params: { ...params(pageToken), ...extra } })));
    if (what === 'tables') return get(`${app}/tables`);
    if (what === 'fields') return get(`${tablePath}/fields`, view ? { view_id: view } : {});
    if (what === 'views') return get(`${tablePath}/views`);
    const body = { ...(view ? { view_id: view } : {}), ...(request.fields ? { field_names: request.fields } : {}), ...(request.filter ? { filter: filterBody(request.filter) } : {}) };
    return pageOf(request, pageToken => ask(deps, 'base', () => deps.channel.rawClient.request<FeishuPage>({ method: 'POST', url: `${tablePath}/records/search`, params: params(pageToken), data: body })));
  });
}
