import { ApiError } from './errors.mjs';

// One service process for the initial deployment. Charge in-flight checks before yielding
// to PostgreSQL, keep a charge for an incorrect code, refund other outcomes.
export function codeAttempts({ now = Date.now, maxAccounts = 8192, limit = 10, windowMs = 600_000 } = {}) {
  const accounts = new Map();
  function begin(account) {
    const at = now();
    let slot = accounts.get(account);
    if (!slot || slot.until <= at) {
      if (accounts.size >= maxAccounts) {
        for (const [key, entry] of accounts) {
          if (entry.until <= at) accounts.delete(key);
        }
        if (accounts.size >= maxAccounts) throw new ApiError(429, 'rate_limited', Math.ceil(windowMs/1000));
      }
      slot = { attempts: 0, until: at + windowMs };
      accounts.set(account, slot);
    }
    if (slot.attempts >= limit) {
      throw new ApiError(429, 'rate_limited', Math.max(1, Math.ceil((slot.until-at)/1000)));
    }
    slot.attempts++;
    return function finish(invalidCode) {
      if (!invalidCode && --slot.attempts === 0 && accounts.get(account) === slot) accounts.delete(account);
    };
  }
  return { begin };
}
