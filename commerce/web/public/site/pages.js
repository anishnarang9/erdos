// For Agents page: mobile menu and guide-index highlighting. (The demo lives on the home page: demo-lab.js.)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const toggle = $('.menu-toggle'), mobile = $('#mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

const links = $$('.doc-nav a');
if (links.length) {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }), { rootMargin: '-30% 0px -60% 0px' });
  $$('.doc-section').forEach((s) => io.observe(s));
}
