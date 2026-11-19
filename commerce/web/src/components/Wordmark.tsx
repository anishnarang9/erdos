export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <svg viewBox="0 0 48 48" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="15" width="12" height="10" rx="3" />
          <rect x="33" y="15" width="12" height="10" rx="3" />
          <path d="M9 15v-3.6M39 15v-3.6M12 25c1 5 4 7.5 8.5 8.5M36 25c-1 5-4 7.5-8.5 8.5" />
        </g>
        <rect x="18.5" y="30" width="11" height="7" rx="3.2" fill="currentColor" />
        <circle cx="24" cy="13" r="6.4" fill="currentColor" />
      </svg>
      Erdos
    </a>
  );
}
