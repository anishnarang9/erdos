export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <svg viewBox="0 0 48 48" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="15" width="12" height="10" rx="3" />
          <rect x="33" y="15" width="12" height="10" rx="3" />
          <path d="M9 15v-3.6M39 15v-3.6M13 25C14 31.5 18.5 34.5 24 34.5S34 31.5 35 25" />
          <path d="M4.5 25C6 37 14 42.5 24 42.5S42 37 43.5 25" strokeOpacity=".75" />
        </g>
        <circle cx="24" cy="13" r="6.4" fill="currentColor" />
      </svg>
      Erdos
    </a>
  );
}
