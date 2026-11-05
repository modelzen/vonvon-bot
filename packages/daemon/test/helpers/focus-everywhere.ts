import { Attention, type PlaceView } from '../../src/bot/attention';

/** Keep pre-attention intake tests judging each batch immediately. */
export class FocusEverywhere extends Attention {
  override followup(): boolean { return false; }
  override due(): undefined { return undefined; }
  override state(place: string): PlaceView | undefined {
    const v = super.state(place);
    return v ? { ...v, mode: 'focus' } : { chatId: '', topic: false, mode: 'focus', intervalMs: 60_000, misses: 0 };
  }
}
