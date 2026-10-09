import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECTION_IDS, resolveRoute, showRoute } from '../../../extension/alpha/ui/shell/shell.js';

const html = readFileSync(new URL('../../../extension/alpha/ui/shell/index.html', import.meta.url), 'utf8');

test('AP105-01: static shell exposes exactly seven fixed navigable areas', () => {
  const links = [...html.matchAll(/data-section="([^"]+)"/g)].map(x => x[1]);
  const sections = [...html.matchAll(/data-panel="([^"]+)"/g)].map(x => x[1]);
  assert.deepEqual(links, SECTION_IDS);
  assert.deepEqual(sections, SECTION_IDS);
  for (const id of SECTION_IDS) {
    assert.match(html, new RegExp('href="#' + id + '"'));
    assert.match(html, new RegExp('aria-labelledby="alpha-heading-' + id + '"'));
  }
  assert.match(html, /<nav\b[^>]*aria-label="Alpha sections"/);
  assert.doesNotMatch(html, /role="tablist"|moduleId|dynamic-module|onclick=/i);
});

test('AP105-02: skip link, natural links, focus targets and unknown route fallback', () => {
  assert.match(html, /class="alpha-skip" href="#content"/);
  assert.match(html, /<main\b[^>]*id="content"[^>]*tabindex="-1"/);
  assert.equal((html.match(/tabindex="-1"/g) || []).length, SECTION_IDS.length + 1);
  assert.equal(resolveRoute('#accounts'), 'accounts');
  assert.equal(resolveRoute('#bogus'), 'overview');
  assert.equal(resolveRoute('#__proto__'), 'overview');
});

test('AP105-02: route change sets one panel and accessible current link with focus', () => {
  let focused = null;
  const links = SECTION_IDS.map(id => ({
    dataset: { section: id }, attrs: {},
    classList: { toggle(name, value) { assert.equal(name, 'is-current'); this.current = value; } },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; }
  }));
  const panels = SECTION_IDS.map(id => ({ dataset: { panel: id }, hidden: id !== 'overview' }));
  const headings = Object.fromEntries(SECTION_IDS.map(id => ['alpha-heading-' + id, {
    textContent: id, focus() { focused = id; }
  }]));
  const doc = {
    title: '',
    querySelectorAll(key) { return key === '[data-section]' ? links : key === '[data-panel]' ? panels : []; },
    querySelector() { return panels.find(p => !p.hidden); },
    getElementById(id) { return headings[id]; }
  };
  assert.equal(showRoute(doc, '#refresher', { focus: true }), 'refresher');
  assert.equal(focused, 'refresher');
  assert.deepEqual(panels.filter(p => !p.hidden).map(p => p.dataset.panel), ['refresher']);
  assert.deepEqual(links.filter(l => l.attrs['aria-current']).map(l => l.dataset.section), ['refresher']);
  assert.equal(showRoute(doc, '#content', { focus: true }), 'refresher');
  assert.equal(showRoute(doc, '#unknown'), 'overview');
  assert.deepEqual(panels.filter(p => !p.hidden).map(p => p.dataset.panel), ['overview']);
});

test('AP105-01: shell contains no provider or storage mutation authority', () => {
  const shell = readFileSync(new URL('../../../extension/alpha/ui/shell/shell.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /\b(?:fetch|XMLHttpRequest|indexedDB|localStorage|browser\.|chrome\.|eval\s*\()/);
  assert.doesNotMatch(html, /<iframe|<form\b|<script\b[^>]*src="https?:/i);
});
