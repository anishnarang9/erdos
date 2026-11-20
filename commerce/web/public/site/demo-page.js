import { initMarket } from './market.js?v=7';

const toggle = document.querySelector('.menu-toggle'), mobile = document.getElementById('mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

initMarket(document.getElementById('market'));
