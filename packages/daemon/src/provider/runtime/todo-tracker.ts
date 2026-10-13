import type { TodoItem } from '../model';

const MAX_ITEMS = 50;
const MAX_TEXT_CHARS = 80;

export class TodoTracker {
  private items: TodoItem[] | null = null;

  replace(items: TodoItem[] | null): TodoItem[] | null {
    this.items = items?.slice(0, MAX_ITEMS).map(item => ({
      text: item.text.slice(0, MAX_TEXT_CHARS),
      status: item.status,
    })) ?? null;
    return this.list();
  }

  list(): TodoItem[] | null {
    return this.items?.map(item => ({ ...item })) ?? null;
  }
}
