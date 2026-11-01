// MoonrayRings.tsx — slowly turning concentric rings around three centres, glowing faintly where a
// ring's bright segment crosses a ring from another centre. Ported from the moonray.ventures hero
// (MVOS business_analysis/MoonrayRings.tsx) and toned down for the console: thinner lines, a dimmer
// and smaller glow, and a slower drift, so the rings stay in the background.
//
// Fills its nearest `position: relative` ancestor and sits behind the content (give content
// `position: relative`). Colours follow the console theme (data-theme, else the OS setting).
// Pauses while the tab is hidden and slows down for prefers-reduced-motion.

import { useEffect, useRef } from 'react';

/** Ring centre and outer radius: x/y are fractions of width/height; s is a fraction of the larger side. */
export interface RingAnchor { x: number; y: number; s: number }

export interface MoonrayRingsProps {
  anchors?: RingAnchor[];
  /** Circles per centre. */
  rings?: number;
  /** Line and glow strength; 1 is the moonray.ventures hero's own strength (its default was 1.3). */
  intensity?: number;
  speed?: number;
  /** Fade towards the bottom so dense pages stay calm. */
  fade?: boolean;
  className?: string;
}

interface Ring {
  group: number; ax: number; ay: number; R: number;
  angle: number; vel: number; gap: number; arc: number; alpha: number; w: number;
}

const DEFAULT_ANCHORS: RingAnchor[] = [
  { x: 0.86, y: 0.06, s: 0.3 },
  { x: 1.04, y: 0.62, s: 0.4 },
  { x: 0.3, y: 0.42, s: 0.34 },
];

const TAU = Math.PI * 2;
const mod = (v: number, m: number) => ((v % m) + m) % m;
const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Moonlight on navy in dark; ink on paper in light. Glow peaks (glow × intensity) sit just under
// moonray.ventures' own hero (0.14 dark, 0.13 light).
const PALETTE = {
  dark: { rgb: '233,231,245', glow: 0.17, blend: 'lighter' as GlobalCompositeOperation },
  light: { rgb: '27,31,59', glow: 0.15, blend: 'source-over' as GlobalCompositeOperation },
};

function isLightTheme(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light') return true;
  if (forced === 'dark') return false;
  return !window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function MoonrayRings({
  anchors = DEFAULT_ANCHORS,
  rings = 4,
  intensity = 0.7,
  speed = 0.6,
  fade = true,
  className = 'hero-bg',
}: MoonrayRingsProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ intensity, speed });
  live.current = { intensity, speed };

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, t = 0, last = performance.now(), raf = 0, running = true;
    let shapes: Ring[] = [];

    const build = () => {
      const r = rng(11);
      const big = Math.max(W, H);
      shapes = [];
      anchors.forEach((a, i) => {
        for (let k = 0; k < rings; k++) {
          shapes.push({
            group: i, ax: a.x, ay: a.y, R: a.s * big * (1 - k * 0.14),
            angle: r() * TAU,
            vel: (0.16 + r() * 0.14) * ((i + k) % 2 ? -1 : 1), // rad/s, alternating direction
            gap: 0.06 + r() * 0.08,
            arc: 0.6 + r() * 0.5,
            alpha: 0.05 + r() * 0.04,
            w: 0.8 + r() * 0.4,
          });
        }
      });
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    const hlWeight = (s: Ring, from: number, th: number) => {
      const d = mod(th - from, TAU);
      if (d > s.arc) return 0;
      const u = d / s.arc;
      return s.vel > 0 ? u : 1 - u;
    };

    const intersections = (a: Ring, b: Ring, ax: number, ay: number, bx: number, by: number): [number, number][] => {
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
      if (d > a.R + b.R || d < Math.abs(a.R - b.R) || d === 0) return [];
      const l = (a.R * a.R - b.R * b.R + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, a.R * a.R - l * l));
      const mx = ax + (dx * l) / d, my = ay + (dy * l) / d;
      return [[mx + (h * dy) / d, my - (h * dx) / d], [mx - (h * dy) / d, my + (h * dx) / d]];
    };

    const draw = () => {
      const I = live.current.intensity;
      const pal = isLightTheme() ? PALETTE.light : PALETTE.dark;
      const L = pal.rgb;
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      const state = shapes.map((s) => {
        const p = s.angle + t * s.vel;
        const head = s.vel > 0 ? p : p + s.gap;
        return { s, p, cx: s.ax * W, cy: s.ay * H, from: s.vel > 0 ? head - s.arc : head };
      });

      for (const { s, p, cx, cy, from } of state) {
        const a = Math.min(1, s.alpha * I);
        ctx.lineWidth = s.w;
        ctx.strokeStyle = `rgba(${L},${a})`;
        ctx.beginPath(); ctx.arc(cx, cy, s.R, p + s.gap, p + TAU); ctx.stroke();

        // Travelling highlight: a little brighter than the ring, fading along its arc.
        const hi = Math.min(1, a * 2.2);
        if (typeof ctx.createConicGradient === 'function') {
          const g = ctx.createConicGradient(from, cx, cy);
          const f = s.arc / TAU;
          if (s.vel > 0) { g.addColorStop(0, `rgba(${L},0)`); g.addColorStop(f, `rgba(${L},${hi})`); }
          else { g.addColorStop(0, `rgba(${L},${hi})`); g.addColorStop(f, `rgba(${L},0)`); }
          g.addColorStop(Math.min(1, f + 0.0001), `rgba(${L},0)`);
          g.addColorStop(1, `rgba(${L},0)`);
          ctx.strokeStyle = g;
        } else {
          ctx.strokeStyle = `rgba(${L},${hi * 0.6})`;
        }
        ctx.lineWidth = s.w + 0.3;
        ctx.beginPath(); ctx.arc(cx, cy, s.R, from, from + s.arc); ctx.stroke();
      }

      // Soft glow where a highlight crosses a ring from a different centre.
      ctx.globalCompositeOperation = pal.blend;
      for (let i = 0; i < state.length; i++) {
        for (let j = i + 1; j < state.length; j++) {
          const A = state[i], B = state[j];
          if (!A || !B || A.s.group === B.s.group) continue;
          for (const [x, y] of intersections(A.s, B.s, A.cx, A.cy, B.cx, B.cy)) {
            if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
            const wa = hlWeight(A.s, A.from, Math.atan2(y - A.cy, x - A.cx));
            const wb = hlWeight(B.s, B.from, Math.atan2(y - B.cy, x - B.cx));
            const k = Math.min(1, Math.max(wa, wb) + 0.5 * Math.min(wa, wb));
            if (k <= 0.02) continue;
            const al = Math.min(1, k * pal.glow * I), rad = 8 + 14 * k;
            const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
            rg.addColorStop(0, `rgba(${L},${al})`);
            rg.addColorStop(0.25, `rgba(${L},${al * 0.45})`);
            rg.addColorStop(1, `rgba(${L},0)`);
            ctx.fillStyle = rg;
            ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      t += dt * live.current.speed * (reduce ? 0.25 : 1);
      draw();
      if (running) raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      running = false; cancelAnimationFrame(raf); ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [anchors, rings]);

  const mask = fade
    ? 'linear-gradient(to bottom, #000 0%, rgba(0,0,0,.65) 45%, rgba(0,0,0,.25) 100%)'
    : undefined;

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 0,
        WebkitMaskImage: mask, maskImage: mask,
      }}
    />
  );
}
