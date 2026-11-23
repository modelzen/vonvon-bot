import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredRecipeApiOrigin } from '../src/config/account-deployment.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('recipe API deployment', () => {
  it('keeps a bundled destination when service startup has a different environment', () => {
    vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', 'https://recipes.example.test/');
    vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://other.example.test');
    expect(configuredRecipeApiOrigin()).toBe('https://recipes.example.test');
  });

  it('lets an unconfigured standalone distribution use its explicit environment', () => {
    vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', undefined);
    vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://recipes.example.test');
    expect(configuredRecipeApiOrigin()).toBe('https://recipes.example.test');
  });

  it('does not replace an invalid bundled destination with ambient configuration', () => {
    vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', 'https://recipes.example.test/api');
    vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://other.example.test');
    expect(configuredRecipeApiOrigin()).toBeUndefined();
  });

  it.each([
    'http://127.0.0.1:4317', 'http://recipes.example.test',
    'https://user:password@recipes.example.test', 'https://recipes.example.test/api',
    'https://recipes.example.test?target=other', 'https://recipes.example.test#fragment',
  ])('rejects non-origin or insecure deployment %s', value => {
    vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', value);
    expect(configuredRecipeApiOrigin()).toBeUndefined();
  });
});
