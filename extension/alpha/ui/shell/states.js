// DOM-only presentational states. No network, storage, provider or Core authority.
export const STATE_KINDS = Object.freeze(['loading', 'empty', 'error']);

const defaults = Object.freeze({
  loading: Object.freeze({ title: 'Loading…', message: 'Retrieving the latest information.' }),
  empty: Object.freeze({ title: 'Nothing to display', message: 'No records are available for this view.' }),
  error: Object.freeze({ title: 'Unable to load', message: 'The requested information could not be displayed.' })
});

export function createState(doc, { kind = 'empty', title, message, onRetry } = {}) {
  if (!STATE_KINDS.includes(kind)) throw new TypeError('Unsupported UI state');
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('A document is required');
  if (onRetry !== undefined && (kind !== 'error' || typeof onRetry !== 'function')) {
    throw new TypeError('Retry is supported only as an error-state callback');
  }
  const root = doc.createElement('div');
  root.className = 'alpha-state';
  root.dataset.kind = kind;
  root.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  root.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  root.setAttribute('aria-atomic', 'true');

  const glyph = doc.createElement('span');
  glyph.className = 'alpha-state-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = kind === 'loading' ? '◌' : kind === 'error' ? '!' : '—';

  const content = doc.createElement('div');
  content.className = 'alpha-state-copy';
  const heading = doc.createElement('h3');
  heading.textContent = title ?? defaults[kind].title;
  const detail = doc.createElement('p');
  detail.textContent = message ?? defaults[kind].message;
  content.append(heading, detail);
  if (onRetry) {
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'alpha-button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', onRetry);
    content.append(retry);
  }
  root.append(glyph, content);
  return root;
}

export function renderState(target, options) {
  if (!target || typeof target.replaceChildren !== 'function' || !target.ownerDocument) {
    throw new TypeError('A DOM target is required');
  }
  const node = createState(target.ownerDocument, options);
  target.replaceChildren(node);
  return node;
}
