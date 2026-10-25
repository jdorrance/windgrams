export interface ViewportSize { width: number; height: number; orientation?: string }

/** Chart layout follows width. Retain viewport identity during height-only
 * changes from browser chrome, keyboards or window resizing. Orientation and
 * width changes still refresh the layout; phones in landscape stay compact.
 */
export function createWindgramViewport(read: () => ViewportSize) {
  let previous: (ViewportSize & { compact: boolean; portrait: boolean }) | undefined;
  return () => {
    const size = read();
    if (previous && size.width === previous.width && size.orientation === previous.orientation) return previous;
    previous = {
      ...size,
      compact: size.width <= 960,
      portrait: size.height > size.width,
    };
    return previous;
  };
}

export const windgramViewport = createWindgramViewport(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  orientation: window.screen.orientation?.type,
}));
