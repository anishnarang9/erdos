export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <svg viewBox="0 0 48 48" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="15" width="12" height="10" rx="3" />
          <rect x="33" y="15" width="12" height="10" rx="3" />
          <path d="M9 15v-3.6M39 15v-3.6" />
          <path d="M13 25A11 11 0 0 0 35 25Z" />
        </g>
        <circle cx="24" cy="13" r="6.4" fill="currentColor" />
      </svg>
      Erdos
    </a>
  );
}
