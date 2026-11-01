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

export function IconHome({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
    </Icon>
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

export function IconDocument({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
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

// Lucide radio: channels (Tools has the wand; the collapsed sidebar needs them distinct).
export function IconChannels({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </Icon>
  );
}

// Lucide panel-left-close / panel-left-open: collapses or expands the sidebar.
export function IconPanelLeft({ size, open }: IconProps & { open: boolean }) {
  return (
    <Icon size={size}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      {open ? <path d="m16 15-3-3 3-3" /> : <path d="m14 9 3 3-3 3" />}
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

export function IconSend({ size, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9" />
    </Icon>
  );
}

export function IconPhone({ size, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </Icon>
  );
}

export function IconPhoneOff({ size, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7a2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67" />
      <path d="M5.53 9.65a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="23" y1="1" x2="1" y2="23" />
    </Icon>
  );
}

export function IconMic({ size, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </Icon>
  );
}

export function IconMicOff({ size, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M8.89 9.11A3 3 0 0 0 9 10v2a3 3 0 0 0 5.19 2.06" />
      <path d="M12 2a3 3 0 0 1 3 3v3.34" />
      <path d="M19 10v2a7 7 0 0 1-9.96 6.27" />
      <path d="M5 10v2a7 7 0 0 0 .78 3.2" />
      <line x1="12" y1="19" x2="12" y2="22" />
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

export function IconPlug({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </Icon>
  );
}

export function IconServer({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </Icon>
  );
}

export function IconBrain({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </Icon>
  );
}

// Brand wordmark — Moonray Ventures lockup with a "powered by Curia" byline.
// The lockup PNG is used as a CSS mask filled with currentColor so it follows
// the light/dark theme (the source art is navy on transparent).
export function BrandWordmark(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="brand-wordmark" {...props}>
      <span className="brand-lockup" role="img" aria-label="Moonray Ventures" />
      <span className="brand-wordmark-sub">powered by Curia</span>
    </span>
  );
}

// Animated Moonray gibbous-moon mark, ported from the brand loader
// (MVMarketing/business_analysis/Moonray Ventures Loader.html). A faint contour,
// a breathing terminator line and an orbiting ray. Animations are defined in
// app.css (.mr-*); colour follows currentColor.
export function AnimatedMoonrayMark({ size = 32, ...rest }: { size?: number } & SVGProps<SVGSVGElement>) {
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
