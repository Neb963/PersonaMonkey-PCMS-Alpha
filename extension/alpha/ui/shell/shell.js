import { renderState } from './states.js';

export const SECTION_IDS = Object.freeze([
  'overview', 'supply', 'refresher', 'accounts', 'generators', 'attention', 'settings'
]);

export function resolveRoute(hash) {
  const route = typeof hash === 'string' && hash.startsWith('#') ? hash.slice(1) : '';
  return SECTION_IDS.includes(route) ? route : 'overview';
}

export function showRoute(doc, hash, { focus = false } = {}) {
  if (hash === '#content') return doc.querySelector('[data-panel]:not([hidden])')?.dataset.panel ?? 'overview';
  const selected = resolveRoute(hash);
  for (const link of doc.querySelectorAll('[data-section]')) {
    const current = link.dataset.section === selected;
    link.classList.toggle('is-current', current);
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const page of doc.querySelectorAll('[data-panel]')) {
    page.hidden = page.dataset.panel !== selected;
  }
  const heading = doc.getElementById('alpha-heading-' + selected);
  if (heading && focus) heading.focus({ preventScroll: true });
  doc.title = (heading?.textContent || 'Overview') + ' — PersonaMonkey PCMS Alpha';
  return selected;
}

export function bootShell(doc, view) {
  for (const slot of doc.querySelectorAll('[data-state-slot]')) {
    renderState(slot, {
      kind: 'empty',
      title: slot.dataset.title,
      message: slot.dataset.message
    });
  }
  showRoute(doc, view.location.hash);
  view.addEventListener('hashchange', () => showRoute(doc, view.location.hash, { focus: true }));
}

// Native anchors provide Tab/Enter navigation. Only the displayed panel changes.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootShell(document, window), { once: true });
  } else {
    bootShell(document, window);
  }
}
