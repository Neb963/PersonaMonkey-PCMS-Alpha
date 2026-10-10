/** P305: observations and metrics only. No browser, network or source-edit authority. */
const INTERVAL = 600_000;
const DAY = 86_400_000;
const FAILURE = Object.freeze({
  INVALID_REQUEST: 'Invalid visibility request', UNAVAILABLE: 'Visibility observation unavailable',
  UNSUPPORTED_CAPABILITY: 'Trusted Perchance observation not available',
  STALE_REVISION: 'Observation clock or pagination changed',
  RATE_LIMIT: 'Daily observation request budget exhausted',
  RECOVERY_HOLD: 'Visibility ledger needs reconciliation', NOT_APPLIED: 'Unknown generator'
});
const validKey = x => typeof x === 'string' && (x === 'hub' ||
  (x.length >= 4 && x.length <= 80 && /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(x)));
const integer = x => Number.isSafeInteger(x) && x >= 0;
const validTime = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x) && Number.isFinite(Date.parse(x));
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const fail = code => Object.assign(new Error(code), { code });
const check = (ok, code = 'INVALID_REQUEST') => { if (!ok) throw fail(code); };
const error = code => ({ok:false,error:{code:FAILURE[code] ? code : 'UNAVAILABLE',
  message: FAILURE[code] || FAILURE.UNAVAILABLE,retryable:false},revision:0});
const ok = (result, revision = 0) => ({ok:true,result,revision});
const iso = ms => new Date(ms).toISOString();
const day = ms => iso(ms).slice(0,10);
const unique = (keys, cap = 2000) => Array.isArray(keys) && keys.length <= cap &&
  keys.every(validKey) && new Set(keys).size === keys.length;
const evidence = list => Array.isArray(list) && list.length <= 32 &&
  list.every(x => typeof x === 'string' && x.length > 0 && x.length <= 128) && new Set(list).size === list.length;
const initial = ms => ({version:1, day:day(ms), used:0, highWaterMs:ms,
  lastFeedRequestMs:null, feed:null, stats:{}});
function stateOf(raw, ms) {
  if (raw === null) return initial(ms);
  check(plain(raw) && raw.version === 1 && /^\d{4}-\d\d-\d\d$/.test(raw.day) &&
    integer(raw.used) && integer(raw.highWaterMs) &&
    (raw.lastFeedRequestMs === null || integer(raw.lastFeedRequestMs)) &&
    (raw.feed === null || plain(raw.feed)) && plain(raw.stats), 'RECOVERY_HOLD');
  check(ms >= raw.highWaterMs, 'STALE_REVISION');
  const next = structuredClone(raw);
  if (day(ms) !== next.day) {check(day(ms) > next.day, 'STALE_REVISION'); next.day = day(ms); next.used = 0;}
  next.highWaterMs = ms;
  return next;
}
function normalizeFeed(raw, ms) {
  check(plain(raw) && raw.source === 'TRUSTED_RENDERED_RECENT' &&
    unique(raw.feedKeys) && unique(raw.renderedKeys) && validTime(raw.asOf) &&
    Date.parse(raw.asOf) <= ms && ms - Date.parse(raw.asOf) <= INTERVAL &&
    evidence(raw.evidenceRefs), 'UNSUPPORTED_CAPABILITY');
  // Rendered order, not the raw feed index, is the visibility ranking.
  const pinnedKeys = raw.pinnedKeys ?? [], filteredKeys = raw.filteredKeys ?? [];
  check(unique(pinnedKeys) && unique(filteredKeys) && pinnedKeys.every(k => raw.renderedKeys.includes(k)) &&
    filteredKeys.every(k => raw.feedKeys.includes(k) && !raw.renderedKeys.includes(k)), 'UNSUPPORTED_CAPABILITY');
  return {feedKeys:[...raw.feedKeys],renderedKeys:[...raw.renderedKeys],
    pinnedKeys:[...pinnedKeys],filteredKeys:[...filteredKeys],
    evidenceRefs:[...raw.evidenceRefs],asOf:raw.asOf};
}
function observation(key, feed, ms) {
  const recent = ms - Date.parse(feed.asOf) <= INTERVAL * 2;
  const f = feed.feedKeys.indexOf(key), r = feed.renderedKeys.indexOf(key);
  return {key, feedPosition:recent && f >= 0 ? f + 1 : null,
    renderedPosition:recent && r >= 0 ? r + 1 : null,
    status:!recent ? 'UNKNOWN' : r >= 0 ? 'VISIBLE' : f >= 0 ? 'LIKELY_FILTERED' : 'NOT_VISIBLE',
    asOf:feed.asOf,evidenceRefs:[...feed.evidenceRefs]};
}
function cadence(record) {
  if (record.fleetIntent === 'EXCLUDED') return 72 * 3_600_000;
  if (record.fleetIntent !== 'MANAGED' || record.listingObserved !== 'PUBLIC') return DAY;
  return record.refreshState === 'ACTIVE' ? 3_600_000 : 12 * 3_600_000;
}
function metrics(points, nowMs) {
  const latest = points?.at(-1);
  if (!latest) return {dailyViews:null, weeklyViews:null,lastObservedAtMs:null,staleAgeMs:null,isStale:1};
  const delta = (span, tolerance) => {
    const cutoff = latest.at - span;
    const baseline = [...points].reverse().find(p => p.at <= cutoff && cutoff - p.at <= tolerance);
    return baseline && baseline.count <= latest.count ? latest.count - baseline.count : null;
  };
  const age = nowMs - latest.at;
  return {dailyViews:delta(DAY,6*3_600_000),weeklyViews:delta(7*DAY,DAY),
    lastObservedAtMs:latest.at,staleAgeMs:age,isStale:age > 26*3_600_000 ? 1 : 0};
}
/** Pure advice to P403. Never executes refreshes, reloads or Perchance edits. */
export function classifyRetry({observation:obs,activeCount,margin=0.1,failedAttempts=0,
  lastAttemptAtMs=null,nowMs}={}) {
  check(plain(obs) && ['VISIBLE','NOT_VISIBLE','LIKELY_FILTERED','UNKNOWN'].includes(obs.status) &&
    integer(activeCount) && typeof margin === 'number' && Number.isFinite(margin) && margin >= 0 && margin <= 1 &&
    integer(failedAttempts) && integer(nowMs) && (lastAttemptAtMs === null || integer(lastAttemptAtMs)));
  const target = Math.ceil(activeCount * (1 + margin));
  if (obs.status === 'UNKNOWN') return {action:'WAIT_FOR_OBSERVATION',target,delayMs:null};
  if (obs.status === 'VISIBLE' && integer(obs.renderedPosition) && obs.renderedPosition > 0 &&
    obs.renderedPosition <= target) return {action:'ON_TARGET',target,delayMs:null};
  if (failedAttempts >= 3) return {action:'SUSPEND',target,delayMs:null};
  const cause = obs.status === 'LIKELY_FILTERED' ? 'FILTERED' :
    obs.status === 'NOT_VISIBLE' ? 'ABSENT' : 'BELOW_TARGET';
  const base = cause === 'FILTERED' ? 3_600_000 : cause === 'ABSENT' ? 1_800_000 : INTERVAL;
  const delay = Math.min(6*3_600_000,base * 2 ** failedAttempts);
  return {action:lastAttemptAtMs !== null && nowMs - lastAttemptAtMs < delay ? 'BACKOFF' : 'RETRY_ELIGIBLE',
    reason:cause,target,delayMs:delay};
}
/** All observations are supplied by already-authorized PersonaMonkey execution.
 * The injected ledger must implement *durable atomic* read/update, not memory-only
 * state in production; createVisibilityLedger provides IndexedDB persistence.
 */
export function createVisibilityService({inventory,feedSource,statsSource,ledger,clock=()=>Date.now(),
  dailyRequestLimit=1000}={}) {
  check(inventory && typeof inventory.list === 'function' && typeof inventory.get === 'function' &&
    feedSource && typeof feedSource.observe === 'function' &&
    ledger && typeof ledger.read === 'function' && typeof ledger.update === 'function' &&
    typeof clock === 'function' && integer(dailyRequestLimit) && dailyRequestLimit >= 144);
  const now = () => {const value=clock(); check(integer(value)); return value;};
  const run = async f => {try{return await f();}catch(e){return error(e?.code);}};
  const read = async ms => stateOf(await ledger.read(),ms);
  async function poll(ms) {
    const current = await read(ms);
    if (current.lastFeedRequestMs !== null && ms - current.lastFeedRequestMs < INTERVAL) return;
    let reserved=false;
    await ledger.update(raw => {
      const s=stateOf(raw,ms);
      if (s.lastFeedRequestMs === null || ms - s.lastFeedRequestMs >= INTERVAL) {
        check(s.used < dailyRequestLimit,'RATE_LIMIT');
        s.used++; s.lastFeedRequestMs=ms; reserved=true;
      }
      return s;
    });
    if (!reserved) return;
    // Failed or timed-out reads consume the request reservation. No instant replay.
    let source;
    try {source=normalizeFeed(await feedSource.observe(),ms);} catch {throw fail('UNAVAILABLE');}
    await ledger.update(raw => {
      const s=stateOf(raw,ms);
      if (s.lastFeedRequestMs === ms) s.feed=source; // stale worker cannot replace newer feed
      return s;
    });
  }
  async function inventoryRows() {
    const keys=new Set(),rows=[]; let cursor;
    for(let page=0;page<100;page++) {
      const response=await inventory.list({limit:250,...(cursor?{cursor}:{})});
      check(response?.ok && plain(response.result) && Array.isArray(response.result.items),'UNAVAILABLE');
      for(const row of response.result.items){check(plain(row)&&validKey(row.key)&&!keys.has(row.key),'RECOVERY_HOLD');keys.add(row.key);rows.push(row);}
      if(response.result.cursor === null) return rows;
      check(typeof response.result.cursor==='string' && response.result.cursor && response.result.cursor!==cursor,'RECOVERY_HOLD');
      cursor=response.result.cursor;
    }
    throw fail('RECOVERY_HOLD');
  }
  async function known(key) {
    check(validKey(key)); const item=await inventory.get({key});
    check(item?.ok && item.result?.key===key,'NOT_APPLIED'); return item.result;
  }
  async function statsFor(key,record,ms) {
    let s=await read(ms),entry=s.stats[key];
    if (!entry || !integer(entry.lastAttemptAtMs) || ms - entry.lastAttemptAtMs >= cadence(record)) {
      check(statsSource && typeof statsSource.readViews === 'function','UNSUPPORTED_CAPABILITY');
      let reserved=false;
      await ledger.update(raw => {
        const next=stateOf(raw,ms),current=next.stats[key];
        if (current && integer(current.lastAttemptAtMs) && ms - current.lastAttemptAtMs < cadence(record)) return next;
        // Reserve all remaining 10-minute global polls for the rest of this UTC day.
        const remainder=Math.ceil((Date.parse(next.day+'T00:00:00Z')+DAY-ms)/INTERVAL);
        check(next.used < dailyRequestLimit - remainder,'RATE_LIMIT');
        next.used++; next.stats[key]={lastAttemptAtMs:ms,points:current?.points ?? []}; reserved=true;
        return next;
      });
      if (reserved) {
        let raw;
        try {raw=await statsSource.readViews({key});}catch{throw fail('UNAVAILABLE');}
        check(plain(raw) && raw.source === 'TRUSTED_GENERATOR_VIEWS' &&
          integer(raw.views) && validTime(raw.asOf) && Date.parse(raw.asOf)<=ms &&
          ms-Date.parse(raw.asOf)<=INTERVAL,'UNSUPPORTED_CAPABILITY');
        await ledger.update(state => {
          const next=stateOf(state,ms),current=next.stats[key];
          if (current?.lastAttemptAtMs===ms) {
            const points=current.points.filter(p=>p.at>=ms-9*DAY);
            const at=Date.parse(raw.asOf);
            if (!points.length || at > points.at(-1).at) points.push({at,count:raw.views});
            next.stats[key]={lastAttemptAtMs:ms,points:points.slice(-256)};
          }
          return next;
        });
      }
      s=await read(ms);entry=s.stats[key];
    }
    return metrics(entry?.points,ms);
  }
  return Object.freeze({
    async observeRecent({cursor,limit=100}={}) {return run(async()=>{
      check(integer(limit) && limit>=1 && limit<=250 && (cursor===undefined||typeof cursor==='string'));
      const ms=now();await poll(ms);const s=await read(ms);
      check(s.feed,'UNAVAILABLE');const rows=await inventoryRows();let offset=0;
      const stamp=String(Date.parse(s.feed.asOf));
      if(cursor!==undefined){const m=/^v1\.(\d+)\.(\d+)$/.exec(cursor);check(m && m[1]===stamp,'STALE_REVISION');offset=Number(m[2]);check(integer(offset)&&offset>0&&offset<rows.length);}
      const slice=rows.slice(offset,offset+limit),next=offset+slice.length;
      return ok({items:slice.map(r=>observation(r.key,s.feed,ms)),
        cursor:next<rows.length?'v1.'+stamp+'.'+next:null,asOf:s.feed.asOf});
    });},
    async getPosition({key}={}) {return run(async()=>{
      await known(key);const ms=now();await poll(ms);const s=await read(ms);
      check(s.feed,'UNAVAILABLE');return ok(observation(key,s.feed,ms));
    });},
    async collectStats({key}={}) {return run(async()=>{
      const record=await known(key),ms=now();return ok(await statsFor(key,record,ms));
    });},
    /** Bounded work for a P201 alarm handler; stats are read-only and optional. */
    async collectDueStats({limit=16}={}) {return run(async()=>{
      check(integer(limit)&&limit>=1&&limit<=64);
      const ms=now(),rows=await inventoryRows(),s=await read(ms);
      const due=rows.filter(r=>!s.stats[r.key] || ms-s.stats[r.key].lastAttemptAtMs>=cadence(r))
        .sort((a,b)=>(s.stats[a.key]?.lastAttemptAtMs??-1)-(s.stats[b.key]?.lastAttemptAtMs??-1) || a.key.localeCompare(b.key));
      const sampled=[];
      for(const record of due.slice(0,limit)) {
        try {sampled.push({key:record.key,stats:await statsFor(record.key,record,ms)});}
        catch(e){if(e?.code==='RATE_LIMIT')break; sampled.push({key:record.key,error:e?.code||'UNAVAILABLE'});}
      }
      return ok({items:sampled,asOf:iso(ms)});
    });},
    async budget() {return run(async()=>{const ms=now(),s=await read(ms);
      return ok({used:s.used,remaining:dailyRequestLimit-s.used,day:s.day});
    });}
  });
}
