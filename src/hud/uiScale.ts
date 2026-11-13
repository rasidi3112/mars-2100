import { useEffect, useState } from 'react';

// The interface is laid out for a window at least 540 px tall (500 px in the phone layout).
// Shorter windows, such as a phone held sideways, get the same layout drawn smaller instead of
// cut off at the bottom; very large screens get it drawn larger so text stays readable.
export function uiScaleFor(width: number, height: number) {
  const needed = width > 800 ? 540 : 500;
  if (height > 0 && height < needed) return Math.max(0.5, height / needed);
  if (width >= 2400 && height >= 1300) return Math.min(2, width / 1920, height / 1080);
  return 1;
}

export function useUiScale() {
  const [scale, setScale] = useState(() => (typeof window === 'undefined' ? 1 : uiScaleFor(window.innerWidth, window.innerHeight)));
  useEffect(() => {
    const update = () => setScale(uiScaleFor(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); };
  }, []);
  return scale;
}
