import {expect, it} from 'vitest';
import type {ModelCatalog, ProjectSettingsView} from '@vonvon/protocol';
import {allowedEfforts, editModelAccess, effortGroups} from '../src/settings/model-access-draft';

type Value = NonNullable<ProjectSettingsView['sections']['modelAccess']>['stored'];
const models: ModelCatalog['models'] = [
  {id: 'alpha', displayName: 'Alpha', description: '', hidden: false, isDefault: true, supportedEfforts: ['low', 'high'], defaultEffort: 'low', serviceTiers: [{id: 'fast', name: 'Fast', description: ''}, {id: 'ultrafast', name: 'UltraFast', description: ''}]},
  {id: 'beta', displayName: 'Beta', description: '', hidden: false, isDefault: false, supportedEfforts: ['high', 'low'], defaultEffort: 'high'},
  {id: 'gamma', displayName: 'Gamma', description: '', hidden: false, isDefault: false, supportedEfforts: ['high'], defaultEffort: 'high'},
  {id: 'hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false, supportedEfforts: ['ultra'], defaultEffort: 'ultra'},
];
const initial = (): Value => ({backend: 'codex-appserver', models: ['alpha'], efforts: ['low', 'high'], defaultModel: 'alpha', defaultEffort: 'low'});
const edit = (value: Value, action: Parameters<typeof editModelAccess>[2]) => editModelAccess(value, models, action);

it('groups selected visible models by the exact supported Effort set regardless of order', () => {
  const value = {...initial(), models: ['alpha', 'beta', 'gamma', 'hidden']};
  const groups = effortGroups(value, models);
  expect(groups.map(group => group.models.map(model => model.id))).toEqual([['alpha', 'beta'], ['gamma']]);
  expect(groups[0]?.efforts).toEqual(['low', 'high']);
});

it('adds a model with its supported Efforts, an empty acceleration set, and unchanged default', () => {
  const result = edit(initial(), {type: 'model', id: 'gamma'}).value!;
  expect(result.models).toEqual(['alpha', 'gamma']);
  expect(allowedEfforts(result, 'gamma')).toEqual(['high']);
  expect(result.modelServiceTiers?.gamma).toEqual([]);
  expect([result.defaultModel, result.defaultEffort]).toEqual(['alpha', 'low']);
});

it('materializes a legacy global Effort union only within each model native capability set', () => {
  const legacy: Value = {...initial(), models: ['alpha', 'gamma']};
  const next = edit(legacy, {type: 'defaultModel', id: 'gamma'}).value!;
  expect(next.modelEfforts?.alpha).toEqual(['low', 'high']);
  expect(next.modelEfforts?.gamma).toEqual(['high']);
  expect(next.defaultModel).toBe('gamma');
  expect(next.defaultEffort).toBe('high');
});

it('prevents the last model and last supported Effort from being removed', () => {
  const sole = {...initial(), modelEfforts: {alpha: ['low']}, efforts: ['low']};
  expect(edit(sole, {type: 'model', id: 'alpha'}).value).toBeUndefined();
  expect(edit(sole, {type: 'effort', ids: ['alpha'], effort: 'low'}).value).toBeUndefined();
});

it('reassigns the default model and Effort when the previous default is removed', () => {
  const value = {...initial(), models: ['alpha', 'gamma'], modelEfforts: {alpha: ['low'], gamma: ['high']}};
  const result = edit(value, {type: 'model', id: 'alpha'}).value!;
  expect(result.models).toEqual(['gamma']);
  expect([result.defaultModel, result.defaultEffort]).toEqual(['gamma', 'high']);
  expect(result.modelEfforts?.alpha).toBeUndefined();
});

it('selecting a default Effort permits it for that group first and leaves other groups alone', () => {
  const value = {...initial(), models: ['alpha', 'gamma'], modelEfforts: {alpha: ['low'], gamma: ['high']}};
  const result = edit(value, {type: 'defaultEffort', ids: ['alpha'], effort: 'high'});
  expect(result.value?.defaultEffort).toBe('high');
  expect(result.value?.modelEfforts?.alpha).toEqual(['low', 'high']);
  expect(result.value?.modelEfforts?.gamma).toEqual(['high']);
  expect(result.notice).toContain('已允许 high');
});

it('edits one capability group without changing a model in another group or the input', () => {
  const value = {...initial(), models: ['alpha', 'beta', 'gamma'], modelEfforts: {alpha: ['low', 'high'], beta: ['low', 'high'], gamma: ['high']}};
  const next = edit(value, {type: 'effort', ids: ['alpha', 'beta'], effort: 'low'}).value!;
  expect(next.modelEfforts).toEqual({alpha: ['high'], beta: ['high'], gamma: ['high']});
  expect(next.defaultEffort).toBe('high');
  expect(value.modelEfforts?.alpha).toEqual(['low', 'high']);
});

it('removes a retired Effort even when only part of a capability group still has it', () => {
  const current = models.map(model => model.id === 'alpha' || model.id === 'beta' ? {...model, supportedEfforts: ['high' as const]} : model);
  const value: Value = {...initial(), models: ['alpha', 'beta'], modelEfforts: {alpha: ['high', 'low'], beta: ['high']}, defaultEffort: 'high'};
  const next = editModelAccess(value, current, {type: 'effort', ids: ['alpha', 'beta'], effort: 'low'}).value!;
  expect(next.modelEfforts).toEqual({alpha: ['high'], beta: ['high']});
});

it('toggles only native acceleration options and removes settings for a removed model', () => {
  const fast = edit(initial(), {type: 'tier', id: 'alpha', tier: 'fast'}).value!;
  expect(fast.modelServiceTiers?.alpha).toEqual(['fast']);
  expect(edit(fast, {type: 'tier', id: 'beta', tier: 'fast'}).value).toBeUndefined();
  const withOther = edit(fast, {type: 'model', id: 'gamma'}).value!;
  const removed = edit(withOther, {type: 'model', id: 'alpha'}).value!;
  expect(removed.modelServiceTiers?.alpha).toBeUndefined();
  expect(removed.models).toEqual(['gamma']);
});
