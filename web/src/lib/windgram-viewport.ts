export interface ViewportSize { width: number; height: number; orientation?: string }

/** Mobile browser chrome changes height during scrolling. Retain the first
 * height until the width or screen orientation changes, including on redraws
 * caused by changing forecast hours, models or units. Desktop remains resizable.
 */
export function createWindgramViewport(read: () => ViewportSize) {
  let previous: (ViewportSize & { compact: boolean; portrait: boolean }) | undefined;
  return () => {
    const size = read();
    if (previous && size.width === previous.width && size.orientation === previous.orientation
      && (previous.compact || size.height === previous.height)) return previous;
    previous = {
      ...size,
      compact: size.width <= 640 || (size.width <= 960 && size.height <= 600),
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
