import {expect, it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ModelCatalog} from '@vonvon/protocol';
import {SpeedChoice} from '../src/settings/SettingsPanel';

const catalog: ModelCatalog = {backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: '2026-10-29T00:00:00Z', titleEfforts: [], models: [
  {id: 'plain', displayName: 'Plain', description: '', supportedEfforts: [], defaultEffort: 'none', isDefault: true, hidden: false, serviceTiers: [{id: 'standard', name: 'Standard', description: ''}]},
  {id: 'fast', displayName: 'Fast', description: '', supportedEfforts: [], defaultEffort: 'none', isDefault: false, hidden: false, serviceTiers: [{id: 'standard', name: 'Standard', description: ''}, {id: 'fast', name: 'Fast', description: ''}]},
  {id: 'full', displayName: 'Full', description: '', supportedEfforts: [], defaultEffort: 'none', isDefault: false, hidden: false, serviceTiers: [{id: 'standard', name: 'Standard', description: ''}, {id: 'fast', name: 'Fast', description: ''}, {id: 'ultrafast', name: 'Ultrafast', description: ''}]},
]};
const show = (model: string, tier = 'standard', source: ModelCatalog | undefined = catalog) => renderToStaticMarkup(createElement(SpeedChoice, {
  tier, catalog: source, selection: {kind: 'explicit', model, effort: 'none'}, disabled: false, onChange: () => {},
}));

it('hides the lightning control without confirmed acceleration for the selected model', () => {
  expect(show('plain')).toBe('');
  expect(show('missing')).toBe('');
  expect(show('fast', 'fast', {...catalog, state: 'fallback'})).toBe('');
  expect(show('fast', 'fast', {...catalog, state: 'unavailable'})).toBe('');
  const customMatchingNative = renderToStaticMarkup(createElement(SpeedChoice, {
    tier: 'fast', catalog, selection: {kind: 'explicit', model: 'fast', effort: 'none', custom: true}, disabled: false, onChange: () => {},
  }));
  expect(customMatchingNative).toBe('');
});

it('offers ordinary and only confirmed acceleration tiers in a compact menu', () => {
  const fast = show('fast');
  expect(fast).toContain('aria-label="响应速度：普通"');
  expect(fast).toContain('>普通</span>');
  expect(fast).toContain('>Fast</span>');
  expect(fast).not.toContain('Ultrafast');
  expect(fast).not.toContain('settings-speed-active');
  expect(show('full')).toContain('>Ultrafast</span>');
});

it('labels active acceleration and presents unsupported saved speed as ordinary', () => {
  expect(show('full', 'ultrafast')).toContain('settings-speed-active">Ultrafast</span>');
  const unsupported = show('fast', 'ultrafast');
  expect(unsupported).toContain('aria-label="响应速度：普通"');
  expect(unsupported).not.toContain('Ultrafast');
});
