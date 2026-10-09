import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, renderState, STATE_KINDS } from '../../../extension/alpha/ui/shell/states.js';

function fakeDocument() {
  return {
    createElement(tagName) {
      return {
        tagName, dataset: {}, attrs: {}, children: [], listeners: {}, textContent: '',
        setAttribute(name, value) { this.attrs[name] = value; },
        append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.listeners[name] = callback; }
      };
    }
  };
}
test('AP105-03: reusable loading, empty and error states have accessible semantics', () => {
  const doc = fakeDocument();
  assert.deepEqual(STATE_KINDS, ['loading', 'empty', 'error']);
  for (const kind of STATE_KINDS) {
    const node = createState(doc, { kind });
    assert.equal(node.dataset.kind, kind);
    assert.equal(node.attrs.role, kind === 'error' ? 'alert' : 'status');
    assert.equal(node.attrs['aria-live'], kind === 'error' ? 'assertive' : 'polite');
    assert.equal(node.children[0].attrs['aria-hidden'], 'true');
    assert.ok(node.children[1].children[0].textContent.length);
    assert.ok(node.children[1].children[1].textContent.length);
  }
});

test('AP105-03: state text is never interpreted as HTML; retry is optional and explicit', () => {
  const doc = fakeDocument();
  let retries = 0;
  const title = '<img src=x onerror=alert(1)>';
  const target = {
    ownerDocument: doc,
    replaceChildren(...children) { this.children = children; }
  };
  const node = renderState(target, {
    kind: 'error', title, message: '<script>unsafe</script>', onRetry: () => retries++
  });
  assert.equal(target.children[0], node);
  const copy = node.children[1];
  assert.equal(copy.children[0].textContent, title);
  assert.equal(copy.children[1].textContent, '<script>unsafe</script>');
  assert.equal(copy.children[2].type, 'button');
  copy.children[2].listeners.click();
  assert.equal(retries, 1);
});

test('AP105-03: unknown states and misleading retry states fail closed', () => {
  const doc = fakeDocument();
  assert.throws(() => createState(doc, { kind: 'unknown' }), TypeError);
  assert.throws(() => createState(doc, { kind: 'loading', onRetry: () => {} }), TypeError);
  assert.throws(() => renderState(null, { kind: 'empty' }), TypeError);
});
