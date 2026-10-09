import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const tokens = readFileSync(new URL('../../../extension/alpha/ui/styles/tokens.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../../../extension/alpha/ui/styles/shell.css', import.meta.url), 'utf8');
function colorIn(block, token) {
  const match = block.match(new RegExp('--' + token + ':\\s*(#[0-9a-fA-F]{6})\\s*;'));
  assert.ok(match, token + ' color token is missing');
  return match[1];
}
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}
test('AP105-02: foreground and secondary text meet WCAG AA in light and dark', () => {
  const light = tokens.match(/:root\s*\{([^}]*)\}/)?.[1];
  const dark = tokens.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1];
  assert.ok(light && dark);
  for (const theme of [light, dark]) {
    for (const foreground of ['alpha-text', 'alpha-muted']) {
      for (const background of ['alpha-bg', 'alpha-surface', 'alpha-surface-subtle']) {
        assert.ok(contrast(colorIn(theme, foreground), colorIn(theme, background)) >= 4.5,
          foreground + ' on ' + background + ' insufficient contrast');
      }
    }
  }
  assert.match(tokens, /prefers-color-scheme:\s*dark/);
  assert.match(tokens, /:root\[data-theme="light"\]/);
});
test('AP105-01/02: visible focus, responsive density, high contrast and reduced motion', () => {
  assert.match(layout, /:focus-visible/);
  assert.match(layout, /aria-current="page"/);
  assert.match(layout, /\.alpha-page\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(layout, /max-width:\s*800px/);
  assert.match(layout, /forced-colors:\s*active/);
  assert.match(layout, /prefers-reduced-motion:\s*reduce/);
  for (const primitive of ['alpha-button', 'alpha-input', 'alpha-select', 'alpha-textarea', 'alpha-table', 'alpha-field-error', 'alpha-state']) {
    assert.ok(layout.includes('.' + primitive), primitive + ' primitive is missing');
  }
});
