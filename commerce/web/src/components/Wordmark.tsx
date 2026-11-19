export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <svg viewBox="0 0 32 32" aria-hidden>
        <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 6.5v19" strokeWidth="2.6" />
          <path d="M8 6.5h14.5M8 25.5h14.5" strokeWidth="2.2" strokeOpacity=".7" />
          <path d="M8 16l5.2 5.2L26 9.6" strokeWidth="2.8" />
        </g>
        <circle cx="8" cy="6.5" r="2.1" fill="currentColor" />
        <circle cx="8" cy="16" r="2.1" fill="currentColor" />
        <circle cx="8" cy="25.5" r="2.1" fill="currentColor" />
        <circle cx="26" cy="9.6" r="2.6" fill="currentColor" />
      </svg>
      Erdos
    </a>
  );
}
