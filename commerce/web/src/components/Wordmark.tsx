export function Wordmark({ href = "#/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Erdos, home">
      <img src={`${import.meta.env.BASE_URL}site/erdos-mark.svg?v=2`} width="32" height="32" alt="" />
      Erdos
    </a>
  );
}
