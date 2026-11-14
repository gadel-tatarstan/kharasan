/**
 * One pointer stream is shared by the canvas and the numbers laid over it.
 *
 * A gesture that starts on a value chip must still be able to pan or zoom the
 * plan, so the canvas listens in the capture phase and follows the pointer as
 * soon as it starts moving. Chips subscribe here to learn that the press turned
 * into a canvas gesture: they then drop a pending long-press and swallow the
 * click that would otherwise open the editor after a drag.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let active = false;

/** True while the canvas is panning or pinch-zooming. */
export const isCanvasGestureActive = () => active;

export function setCanvasGestureActive(next: boolean) {
  if (active === next) return;
  active = next;
  if (!next) return;
  for (const fn of [...listeners]) fn();
}

/** Runs when a press turns into a canvas gesture. Returns an unsubscribe. */
export function onCanvasGestureStart(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
