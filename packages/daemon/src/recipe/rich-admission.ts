/** Acquire before reading the active pointer. A switch can never commit while an old holder is executing. */
export class RecipeAdmissions {
  private slots = new Map<string, { readers: number; closed: boolean; drained?: () => void }>();
  private entry(slot: string) {
    const entry = this.slots.get(slot) ?? { readers: 0, closed: false };
    this.slots.set(slot, entry);
    return entry;
  }
  acquire(slot: string): () => void {
    const entry = this.entry(slot);
    if (entry.closed) throw new Error('配方正在更新，请稍后重试');
    entry.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.readers === 0) {
        if (entry.closed) entry.drained?.();
        else this.slots.delete(slot);
      }
    };
  }
  async exclusive<T>(slot: string, commit: () => Promise<T>, timeoutMs = 30000): Promise<T> {
    const entry = this.entry(slot);
    if (entry.closed) throw new Error('另一项配方更新正在进行');
    entry.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (entry.readers)
        await new Promise<void>((resolve, reject) => {
          entry.drained = resolve;
          timer = setTimeout(() => reject(new Error('群内任务尚未结束，请稍后重试')), timeoutMs);
        });
      return await commit();
    } finally {
      clearTimeout(timer);
      entry.closed = false;
      delete entry.drained;
      if (!entry.readers) this.slots.delete(slot);
    }
  }
}
export const recipeAdmissions = new RecipeAdmissions();
export const recipeSlot = (botId: string, chatId: string): string => JSON.stringify([botId, chatId]);
