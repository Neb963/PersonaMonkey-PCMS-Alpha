/** In-memory index of durable GeneratorRecord projections. No browser execution. */
const enumIntent = new Set(['MANAGED', 'EXCLUDED']);
const enumListing = new Set(['PUBLIC', 'UNLISTED', 'UNKNOWN']);
const finite = n => Number.isSafeInteger(n) && n >= 0;
const invalid = () => { throw Object.assign(new Error('Invalid inventory query'), { code: 'INVALID_REQUEST' }); };

export function createGeneratorIndex(records, revision) {
  if (!Array.isArray(records) || !finite(revision)) invalid();
  const byKey = new Map(), byAccount = new Map(), byIntent = new Map(), byListing = new Map();
  for (const record of records) {
    if (!record || typeof record.key !== 'string' || byKey.has(record.key)) invalid();
    byKey.set(record.key, record);
    for (const [bucket, value] of [[byAccount, record.accountId], [byIntent, record.fleetIntent], [byListing, record.listingObserved]]) {
      if (!bucket.has(value)) bucket.set(value, []);
      bucket.get(value).push(record);
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const sort = map => { for (const rows of map.values()) rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0); };
  sort(byAccount); sort(byIntent); sort(byListing);

  /** Stable offset cursor rejects changed store revisions and changed filters. */
  function query({ key = '', accountId, fleetIntent, listingObserved, cursor, limit = 100 } = {}) {
    if (typeof key !== 'string' || key.length > 100 || !/^[a-z0-9_-]*$/.test(key) ||
        (accountId !== undefined && (typeof accountId !== 'string' || accountId.length > 256)) ||
        (fleetIntent !== undefined && !enumIntent.has(fleetIntent)) ||
        (listingObserved !== undefined && !enumListing.has(listingObserved)) ||
        !finite(limit) || limit < 1 || limit > 250) invalid();
    const signature = JSON.stringify([key, accountId ?? null, fleetIntent ?? null, listingObserved ?? null]);
    let offset = 0;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 1024) invalid();
      const match = /^i1\.([0-9]+)\.([0-9]+)\.([0-9a-f]+)$/.exec(cursor);
      if (!match || !finite(Number(match[1])) || !finite(Number(match[2]))) invalid();
      if (Number(match[1]) !== revision || match[3] !== hex(signature))
        throw Object.assign(new Error('Inventory index has changed'), { code: 'STALE_REVISION' });
      offset = Number(match[2]);
    }
    let rows = accountId !== undefined ? (byAccount.get(accountId) ?? []) :
      fleetIntent !== undefined ? (byIntent.get(fleetIntent) ?? []) :
      listingObserved !== undefined ? (byListing.get(listingObserved) ?? []) : sorted;
    if (key || (fleetIntent !== undefined && accountId !== undefined) ||
        (listingObserved !== undefined && (fleetIntent !== undefined || accountId !== undefined))) {
      rows = rows.filter(r => r.key.includes(key) &&
        (fleetIntent === undefined || r.fleetIntent === fleetIntent) &&
        (listingObserved === undefined || r.listingObserved === listingObserved));
    }
    if (offset > rows.length || (cursor !== undefined && offset === 0)) invalid();
    const items = rows.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, cursor: next < rows.length ? `i1.${revision}.${next}.${hex(signature)}` : null,
      total: rows.length, revision };
  }
  return Object.freeze({ revision, size: sorted.length, get: key => byKey.get(key) ?? null, query });
}
function hex(s) { return Array.from(new TextEncoder().encode(s), x => x.toString(16).padStart(2, '0')).join(''); }
