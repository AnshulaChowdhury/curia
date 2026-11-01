// Curia — Lucide icon set, inlined. ISC-licensed; lucide.dev.
import { useId } from 'react';
import type { SVGProps, ReactNode, HTMLAttributes } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  children?: ReactNode;
}

function Icon({ children, size = 16, viewBox = '0 0 24 24', strokeWidth = 2, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconChat({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

export function IconMemory({ size }: IconProps) {
  return (
    <Icon size={size}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Icon>
  );
}

export function IconGraph({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="2" />
      <circle cx="4" cy="4" r="2" />
      <circle cx="20" cy="4" r="2" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="20" r="2" />
      <line x1="5.4" y1="5.4" x2="10.6" y2="10.6" />
      <line x1="18.6" y1="5.4" x2="13.4" y2="10.6" />
      <line x1="10.6" y1="13.4" x2="5.4" y2="18.6" />
      <line x1="18.6" y1="18.6" x2="13.4" y2="13.4" />
    </Icon>
  );
}

export function IconPerson({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}

export function IconChecklist({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <polyline points="9 12 11 14 16 9" />
    </Icon>
  );
}

export function IconClock({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Icon>
  );
}

export function IconSettings({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

export function IconWand({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </Icon>
  );
}

export function IconChevron({ collapsed }: { collapsed?: boolean }) {
  return (
    <svg
      className={`chevron${collapsed ? ' collapsed' : ''}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconSearch({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

export function IconPlus({ size }: IconProps) {
  return (
    <Icon size={size}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Icon>
  );
}

export function IconSend({ size }: IconProps) {
  return (
    <Icon size={size}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9" />
    </Icon>
  );
}

export function IconAutonomy({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 2a10 10 0 0 1 7.38 16.75" />
      <path d="M4.62 18.75A10 10 0 0 1 12 2" />
      <circle cx="12" cy="12" r="1" />
      <line x1="12" y1="11" x2="16" y2="7" />
    </Icon>
  );
}

// Brand wordmark — "Moonray Ventures OS" with "powered by Curia" byline.
// Text-based (not SVG paths) so it inherits the theme colour via currentColor.
export function BrandWordmark(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="brand-wordmark" {...props}>
      <span className="brand-wordmark-name">Moonray Ventures OS</span>
      <span className="brand-wordmark-sub">powered by Curia</span>
    </span>
  );
}

// Animated Moonray gibbous-moon mark, ported from the brand loader
// (MVMarketing/business_analysis/Moonray Ventures Loader.html). A faint contour,
// a breathing terminator line and an orbiting ray. Animations are defined in
// app.css (.mr-*); colour follows currentColor.
export function MoonrayMark({ size = 32, ...rest }: { size?: number } & SVGProps<SVGSVGElement>) {
  const clipId = useId();
  const sw = 8;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="Moonray Ventures" {...rest}>
      <defs>
        <clipPath id={clipId}><circle cx="100" cy="100" r="80" /></clipPath>
      </defs>
      <path className="mr-glow" d="M100 20 A80 80 0 0 1 100 180 A40 80 0 0 1 100 20 Z" fill="currentColor" />
      <circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" strokeWidth={sw} opacity=".22" />
      <g clipPath={`url(#${clipId})`}>
        <path className="mr-phase" d="M100 20 A80 80 0 0 0 100 180" fill="none" stroke="currentColor"
              strokeWidth={sw} strokeLinecap="round" vectorEffect="non-scaling-stroke"
              style={{ strokeWidth: (sw * size) / 200 }} />
      </g>
      <circle className="mr-orbit" cx="100" cy="100" r="80" fill="none" stroke="currentColor"
              strokeWidth={sw} strokeLinecap="round" strokeDasharray="150 353" />
    </svg>
  );
}
