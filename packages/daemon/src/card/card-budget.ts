import type { CardObject } from './cards';

/**
 * Whole-card capacity limits for Feishu CardKit 2.0.
 *
 * Feishu rejects cards exceeding ~30 KB UTF-8 JSON, 200 total `tag` components
 * (error 300305), or 5 native `table` components. We keep conservative
 * ceilings below the hard limits to leave headroom for runtime icon
 * substitution (`standard_icon` -> `custom_icon`), `<at>` guard escaping,
 * and finalization notes.
 */
export interface CardBudget {
  readonly maxBytes: number;
  readonly maxComponents: number;
  readonly maxTables: number;
}

export interface CardMetrics {
  readonly bytes: number;
  readonly components: number;
  readonly tables: number;
}

export const CARD_MAX_BYTES = 26_000;
export const CARD_MAX_COMPONENTS = 180;
export const CARD_MAX_TABLES = 5;

export const DEFAULT_CARD_BUDGET: CardBudget = {
  maxBytes: CARD_MAX_BYTES,
  maxComponents: CARD_MAX_COMPONENTS,
  maxTables: CARD_MAX_TABLES,
};

/** Reserve headroom when freezing/updating a card that may gain a continuation
 * note, terminal status line, or icon key expansion. */
export const CONTINUATION_RESERVE: Partial<CardMetrics> = {
  bytes: 1_200,
  components: 10,
};

/**
 * Measure exact UTF-8 serialized size, recursive `tag` component count
 * (matching Feishu CardKit 2.0's 200-component validator and
 * `compileCardDisplay`), and native `table` count.
 */
export function measureCard(cardObj: CardObject): CardMetrics {
  const bytes = Buffer.byteLength(JSON.stringify(cardObj), 'utf8');
  let components = 0;
  let tables = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.tag === 'string') {
      components += 1;
      if (record.tag === 'table') tables += 1;
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'tag') continue;
      walk(value);
    }
  };
  walk(cardObj.header);
  walk(cardObj.body);
  return { bytes, components, tables };
}

export function fitsCardMetrics(
  metrics: CardMetrics,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
  reserve?: Partial<CardMetrics>,
): boolean {
  return metrics.bytes + (reserve?.bytes ?? 0) <= budget.maxBytes
    && metrics.components + (reserve?.components ?? 0) <= budget.maxComponents
    && metrics.tables + (reserve?.tables ?? 0) <= budget.maxTables;
}

export function fitsCard(
  cardObj: CardObject,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
  reserve?: Partial<CardMetrics>,
): boolean {
  return fitsCardMetrics(measureCard(cardObj), budget, reserve);
}

/** Build and measure a candidate card; returns null if building throws (e.g.,
 * `compileCardDisplay` strict 200-component / 100 KB guard). */
export function tryMeasureCard(build: () => CardObject): CardMetrics | null {
  try {
    return measureCard(build());
  } catch {
    return null;
  }
}

export function tryFitsCard(
  build: () => CardObject,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
  reserve?: Partial<CardMetrics>,
): boolean {
  const metrics = tryMeasureCard(build);
  return metrics !== null && fitsCardMetrics(metrics, budget, reserve);
}
