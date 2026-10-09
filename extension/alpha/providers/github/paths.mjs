/** Literal, single-generator GitHub path expansion; never normalize untrusted paths. */
const PLACEHOLDER = /\{(folder|slug)\}/g;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertGitHubPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    throw new TypeError('Unsafe GitHub path');
  }
  for (const part of value.split('/')) {
    if (!SAFE_SEGMENT.test(part) || part.includes('..') || part.endsWith('.') ||
        WINDOWS_NAME.test(part) || part === '.git') {
      throw new TypeError('Unsafe GitHub path');
    }
  }
  return value;
}
function validTemplate(value) {
  if (typeof value !== 'string' || /[{}$*?%]/.test(value.replace(PLACEHOLDER, 'placeholder'))) {
    throw new TypeError('Unsafe GitHub path template');
  }
  assertGitHubPath(value.replace(PLACEHOLDER, 'placeholder'));
  return value;
}
function mappingValue(value) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value.includes('..') ||
      value.endsWith('.') || WINDOWS_NAME.test(value) || value === '.git') {
    throw new TypeError('Unsafe generator path mapping');
  }
  return value;
}

/** No regex supplied by callers, URI decoding, path joining or implicit folder→slug mapping. */
export function createGitHubPathTemplates({
  root = 'generators/{folder}', status = 'DEPLOYMENT.md',
  pjs = 'main.pjs', html = 'index.html', thumbnail = 'thumbnail.jpeg'
} = {}) {
  const templates = Object.freeze({root: validTemplate(root), status: validTemplate(status),
    pjs: validTemplate(pjs), html: validTemplate(html), thumbnail: validTemplate(thumbnail)});
  if (!root.includes('{folder}') && !root.includes('{slug}')) {
    throw new TypeError('Generator root must use an explicit folder or slug');
  }
  const keys = ['status', 'pjs', 'html', 'thumbnail'];
  function resolve({folder, slug}) {
    const values = { folder: mappingValue(folder), slug: mappingValue(slug) };
    const expand = template => assertGitHubPath(template.replace(PLACEHOLDER, (_, name) => values[name]));
    const base = expand(templates.root);
    const result = Object.fromEntries(keys.map(key => [key, assertGitHubPath(`${base}/${expand(templates[key])}`)]));
    const lower = Object.values(result).map(x => x.toLowerCase());
    if (new Set(lower).size !== lower.length) throw new TypeError('Ambiguous configured filenames');
    return Object.freeze(result);
  }
  return Object.freeze({templates, resolve});
}
