// Persistence is owned by one request coordinator per origin pair. A live
// reference keeps the existing identity checks valid across async boundaries.
export function createAuthMap(kind, storage, expiresAt, { encode = value => value, decode = value => value, clock = Date.now } = {}) {
  if (!storage) {
    const entries = new Map();
    return Object.assign(entries, {
      save() {},
      prune(now) {
        for (const [key, value] of entries) if (expiresAt(value) <= now) entries.delete(key);
      },
    });
  }
  const references = new Map();
  const remember = (key, value) => {
    if (value !== null && typeof value === 'object') {
      references.set(key, { value: new WeakRef(value), expiresAt: expiresAt(value) });
    }
  };
  return {
    get size() { return storage.count(kind); },
    get(key) {
      if (typeof key !== 'string') return undefined;
      const reference = references.get(key);
      if (reference?.expiresAt > clock()) {
        const active = reference.value.deref();
        if (active) return active;
      }
      references.delete(key);
      const stored = storage.get(kind, key);
      if (stored === undefined) return undefined;
      const value = decode(stored);
      remember(key, value);
      return value;
    },
    set(key, value, deadline = expiresAt(value)) {
      storage.set(kind, key, encode(value), deadline);
      remember(key, value);
    },
    save(key, value) {
      this.set(key, value);
    },
    delete(key) {
      if (typeof key !== 'string') return;
      references.delete(key);
      storage.delete(kind, key);
    },
    prune(now) {
      storage.prune(kind, now);
      for (const [key, entry] of references) {
        if (entry.expiresAt <= now || !entry.value.deref()) references.delete(key);
      }
    },
    clear() {
      // Disposing a live coordinator must not revoke everyone else's sessions.
      references.clear();
    },
  };
}
