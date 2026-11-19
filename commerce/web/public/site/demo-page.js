// Demo page: mobile menu plus the three-sample replay (demo-lab.js). ?sample=paid|refused|bounty preselects a sample.
import { initDemoLab } from './demo-lab.js?v=7';

const toggle = document.querySelector('.menu-toggle'), mobile = document.getElementById('mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

initDemoLab();
const sample = new URLSearchParams(location.search).get('sample');
if (sample) document.querySelector(`[data-sample="${CSS.escape(sample)}"]`)?.click();
