export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <svg viewBox="0 0 32 32" aria-hidden>
        <path d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3Z" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" />
        <path d="M9.6 16.4 14 20.8 22.4 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9.6" cy="16.4" r="2.1" fill="currentColor" />
        <circle cx="14" cy="20.8" r="2.1" fill="currentColor" />
        <circle cx="22.4" cy="12" r="2.1" fill="currentColor" />
      </svg>
      Erdos
    </a>
  );
}
