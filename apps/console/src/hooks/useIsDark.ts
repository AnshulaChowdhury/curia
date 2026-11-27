// Whether the console is showing dark right now: the chosen theme, else the system's. Follows later changes.

import { useEffect, useState } from 'react';

const DARK = '(prefers-color-scheme: dark)';

function isDark(): boolean {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return window.matchMedia(DARK).matches;
}

export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const look = () => setDark(isDark());
    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const system = window.matchMedia(DARK);
    system.addEventListener('change', look);
    look();
    return () => { observer.disconnect(); system.removeEventListener('change', look); };
  }, []);
  return dark;
}
