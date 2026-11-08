/** now-share N5b: what the offscreen share window's preload, its page clock and the main process agree on. Kept free of
 * other imports, so the share window's preload bundles nothing else. */
export const shareCardChannels = {
  model: 'desktop:share-card:model',
  ready: 'desktop:share-card:ready',
} as const;

/** The animation clock steps at 60 Hz, as the app's springs expect; every third step is a GIF frame (20 fps). */
export const SHARE_STEP_MS = 50 / 3;
export const SHARE_FRAME_STEPS = 3;
export const SHARE_FRAME_MS = SHARE_STEP_MS * SHARE_FRAME_STEPS;
/** CSS pixels below the card for the frame marker; never part of the GIF. */
export const SHARE_MARKER_STRIP = 8;

/** One step of the page clock: wait for the input sent before it (and for the rail to reach `scroll`, as the compositor
 * may apply a wheel a frame late), move time on by `dt`, and paint `marker` when the step ends on a frame. */
export type ShareTick = { dt: number; pointer?: [number, number]; wheels?: number; scroll?: number; marker?: number };
export type ShareTickResult = { scrollLeft?: number };
export type ShareRailBox = { x: number; y: number; width: number; height: number };
