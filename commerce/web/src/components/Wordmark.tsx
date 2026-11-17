export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Proof chamber, home">
      <svg viewBox="0 0 30 30" aria-hidden>
        <rect x="1.5" y="1.5" width="27" height="27" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M15 1.5v27M1.5 15h27" stroke="currentColor" strokeWidth="2.4" />
      </svg>
      proof chamber
    </a>
  );
}
