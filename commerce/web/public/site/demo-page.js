// Demo page: mobile menu plus the three-sample replay (demo-lab.js). ?sample=paid|refused|bounty preselects a sample.
import { initDemoLab } from './demo-lab.js?v=9';
import { initMarket } from './market.js?v=3';

const toggle = document.querySelector('.menu-toggle'), mobile = document.getElementById('mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

initDemoLab();
const sample = new URLSearchParams(location.search).get('sample');
if (sample) document.querySelector(`[data-sample="${CSS.escape(sample)}"]`)?.click();

// Marketplace listings over the API; runnable Arc jobs replay in the demo below.
initMarket(document.getElementById('market'), {
  onReplay(sample) {
    document.querySelector(`[data-sample="${CSS.escape(sample)}"]`)?.click();
    document.querySelector('.demo-preset-controls')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => document.getElementById('run')?.click(), 700);
  },
});
