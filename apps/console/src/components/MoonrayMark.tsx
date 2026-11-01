// MoonrayMark.tsx — the Moonray Ventures mark (circle with a crescent arc), the same geometry as
// the favicon on moonray.ventures. Drawn with currentColor so it follows the page's text colour in
// light and dark, unlike the dark-navy PNG on the marketing site.

export function MoonrayMark({ size = 56 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label="Moonray Ventures"
      fill="none"
      stroke="currentColor"
      strokeWidth={12}
      strokeLinecap="round"
    >
      <circle cx="100" cy="100" r="80" />
      <path d="M100 20 A40 80 0 0 0 100 180" />
    </svg>
  );
}
