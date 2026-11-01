// HeroBackground.tsx — slowly turning lunar rings, ported from the moonray.ventures hero.
// Each ring has a travelling highlight; where highlights from different ring families cross, a soft
// glow appears. Colours follow the console theme (data-theme, else the OS setting).

import { useEffect, useRef } from 'react';

interface Ring {
  group: number; ax: number; ay: number; R: number;
  angle: number; vel: number; gap: number; arc: number; alpha: number; w: number;
}

const TAU = Math.PI * 2;
const mod = (v: number, m: number) => ((v % m) + m) % m;
const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Line strength (INTENSITY) and extra glow factor (GLOW) per theme; light needs more strength to
// stay visible against the pale background.
const STRENGTH = {
  dark: { INTENSITY: 0.75, GLOW: 0.35 },
  light: { INTENSITY: 1, GLOW: 0.4 },
};

function isLightTheme(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light') return true;
  if (forced === 'dark') return false;
  return !window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function HeroBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const speed = reduce ? 0.25 : 1;
    let W = 0, H = 0, rings: Ring[] = [], t = 0, last = performance.now(), raf = 0;

    const build = () => {
      const r = rng(11);
      const big = Math.max(W, H);
      rings = [];
      // Three centres placed so their ring families overlap across the page.
      const anchors = [
        { x: 0.76, y: 0.3, s: 0.36 },
        { x: 0.98, y: 0.98, s: 0.46 },
        { x: 0.3, y: 0.92, s: 0.4 },
      ];
      anchors.forEach((a, i) => {
        const R = a.s * big;
        for (let k = 0; k < 4; k++) {
          rings.push({
            group: i, ax: a.x, ay: a.y, R: R * (1 - k * 0.14),
            angle: r() * TAU,
            vel: (0.16 + r() * 0.14) * ((i + k) % 2 ? -1 : 1), // rad/s, alternating direction
            gap: 0.06 + r() * 0.08,
            arc: 0.6 + r() * 0.5,
            alpha: 0.06 + r() * 0.05,
            w: 1 + r() * 0.6,
          });
        }
      });
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    const highlight = (s: Ring) => {
      const p = s.angle + t * s.vel;
      const head = s.vel > 0 ? p : p + s.gap;
      return { p, from: s.vel > 0 ? head - s.arc : head };
    };

    const hlWeight = (s: Ring, from: number, th: number) => {
      const d = mod(th - from, TAU);
      if (d > s.arc) return 0;
      const u = d / s.arc;
      return s.vel > 0 ? u : 1 - u;
    };

    const intersections = (a: Ring, b: Ring, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
      if (d > a.R + b.R || d < Math.abs(a.R - b.R) || d === 0) return [];
      const l = (a.R * a.R - b.R * b.R + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, a.R * a.R - l * l));
      const mx = ax + (dx * l) / d, my = ay + (dy * l) / d;
      return [[mx + (h * dy) / d, my - (h * dx) / d], [mx - (h * dy) / d, my + (h * dx) / d]];
    };

    const glow = (x: number, y: number, k: number, rgb: string, isLight: boolean, strength: { INTENSITY: number; GLOW: number }) => {
      if (x < -60 || y < -60 || x > W + 60 || y > H + 60) return;
      const a = Math.min(1, k * (isLight ? 0.32 : 0.55) * strength.INTENSITY * strength.GLOW);
      const rad = 8 + 16 * k;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(0.25, `rgba(${rgb},${a * 0.45})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) { last = now; return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      t += dt * speed;

      const isLight = isLightTheme();
      const rgb = isLight ? '27,31,59' : '233,231,245';
      const strength = isLight ? STRENGTH.light : STRENGTH.dark;

      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      const state = rings.map((s) => ({ s, cx: s.ax * W, cy: s.ay * H, ...highlight(s) }));

      for (const { s, cx, cy, p, from } of state) {
        const a = Math.min(1, s.alpha * strength.INTENSITY);
        ctx.lineWidth = s.w;
        ctx.strokeStyle = `rgba(${rgb},${a})`;
        ctx.beginPath(); ctx.arc(cx, cy, s.R, p + s.gap, p + TAU); ctx.stroke();

        if (ctx.createConicGradient) {
          const grad = ctx.createConicGradient(from, cx, cy);
          const f = s.arc / TAU, hi = Math.min(1, a * 2.8);
          if (s.vel > 0) { grad.addColorStop(0, `rgba(${rgb},0)`); grad.addColorStop(f, `rgba(${rgb},${hi})`); }
          else { grad.addColorStop(0, `rgba(${rgb},${hi})`); grad.addColorStop(f, `rgba(${rgb},0)`); }
          grad.addColorStop(Math.min(1, f + 0.0001), `rgba(${rgb},0)`);
          grad.addColorStop(1, `rgba(${rgb},0)`);
          ctx.strokeStyle = grad;
        } else {
          ctx.strokeStyle = `rgba(${rgb},${a * 2})`;
        }
        ctx.lineWidth = s.w + 0.4;
        ctx.beginPath(); ctx.arc(cx, cy, s.R, from, from + s.arc); ctx.stroke();
      }

      // Glow where a highlight crosses a ring from a different centre.
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      for (let i = 0; i < state.length; i++) {
        for (let j = i + 1; j < state.length; j++) {
          const A = state[i], B = state[j];
          if (!A || !B || A.s.group === B.s.group) continue;
          for (const [x, y] of intersections(A.s, B.s, A.cx, A.cy, B.cx, B.cy)) {
            if (x === undefined || y === undefined) continue;
            const wa = hlWeight(A.s, A.from, Math.atan2(y - A.cy, x - A.cx));
            const wb = hlWeight(B.s, B.from, Math.atan2(y - B.cy, x - B.cx));
            const k = Math.min(1, Math.max(wa, wb) + 0.5 * Math.min(wa, wb));
            if (k > 0.02) glow(x, y, k, rgb, isLight, strength);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="hero-bg" />;
}
