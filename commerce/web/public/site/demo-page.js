import { initDemoLab } from './demo-lab.js?v=1';
import { initMarket } from './market.js?v=13';

const toggle = document.querySelector('.menu-toggle'), mobile = document.getElementById('mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

initDemoLab();
const sample = new URLSearchParams(location.search).get('sample');
if (sample) document.querySelector(`[data-sample="${CSS.escape(sample)}"]`)?.click();

initMarket(document.getElementById('market'), {
  onReplay(sampleKey) {
    document.querySelector(`[data-sample="${CSS.escape(sampleKey)}"]`)?.click();
    document.querySelector('.demo-preset-controls')?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start',
    });
    setTimeout(() => document.getElementById('run')?.click(), 700);
  },
});
