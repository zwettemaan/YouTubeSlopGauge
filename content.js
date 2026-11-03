/*
 * content.js - runs on youtube.com. Finds video tiles, works out each tile's
 * channel, asks the background worker for stats, and overlays a badge.
 * Clicking a badge opens a menu to trust / block the channel.
 */
'use strict';

// Video tiles across home, search, subscriptions, watch-page sidebar, channel pages.
// YouTube changes its DOM often - this is the first place to look if badges stop appearing.
const SG_ITEM_SELECTOR = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'yt-lockup-view-model'
].join(',');

const SG_THUMB_SELECTOR = [
  'ytd-thumbnail',
  'yt-thumbnail-view-model',
  'a#thumbnail',
  'a[class*="content-image"]'
].join(',');

const SG_SCAN_DEBOUNCE_MS = 300;
const SG_BLOCK_CLASSES = ['sg-blocked-hide', 'sg-blocked-dim'];

let sgSettings = { ...SG_DEFAULTS };
let sgListIndex = new Map();      // cacheKey -> { list, id }
let sgGen = 0;                    // bumps when settings/lists change => forces re-render
let sgScanTimer = 0;
let sgMenu = null;                // currently open menu element
const sgStatsMemo = new Map();    // cacheKey -> Promise<stats>

/* ------------------------------------------------------------------------- */
function sgParseChannelPath(pathname) {
  const fn = 'sgParseChannelPath';
  let retVal = null;
  do {
    if (typeof pathname !== 'string' || pathname.length < 2) {
      break;
    }
    let m = pathname.match(/^\/(@[^\/?#]+)/);
    if (m) {
      let handle = '';
      try {
        handle = decodeURIComponent(m[1]);
      } catch (e) {
        sgWarn(fn, 'bad handle encoding', m[1]);
        break;
      }
      retVal = { kind: 'handle', value: handle };
      break;
    }
    m = pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (m) {
      retVal = { kind: 'id', value: m[1] };
      break;
    }
  } while (false);
  return retVal;
}

function sgFindChannelKey(item) {
  const fn = 'sgFindChannelKey';
  let retVal = null;
  do {
    if (!item || typeof item.querySelectorAll !== 'function') {
      break;
    }
    for (const a of item.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) {
        continue;
      }
      let url;
      try {
        url = new URL(href, location.origin);
      } catch (e) {
        continue;
      }
      if (url.hostname !== location.hostname) {
        continue;
      }
      const k = sgParseChannelPath(url.pathname);
      if (k) {
        retVal = k;
        break;
      }
    }
    if (retVal) {
      break;
    }
    // On a channel's own page the tiles carry no channel link - use the page's channel.
    retVal = sgParseChannelPath(location.pathname);
  } while (false);
  sgLog(fn, retVal);
  return retVal;
}

/* ------------------------------------------------------------------------- */
function sgGetStats(key, ck) {
  const fn = 'sgGetStats';
  let retVal = null;
  sgEntry(fn, ck);
  do {
    if (sgStatsMemo.has(ck)) {
      retVal = sgStatsMemo.get(ck);
      break;
    }
    const p = (async () => {
      let res = { ok: false, error: 'unknown error', reason: 'unknown' };
      do {
        if (!chrome.runtime || !chrome.runtime.id) {
          res.error = 'Extension was reloaded - refresh this page';
          res.reason = 'contextInvalidated';
          break;
        }
        let resp;
        try {
          resp = await chrome.runtime.sendMessage({ type: 'getChannelStats', key: key });
        } catch (e) {
          res.error = 'Messaging failed: ' + (e && e.message ? e.message : String(e));
          res.reason = 'messaging';
          break;
        }
        if (!resp || typeof resp !== 'object') {
          res.error = 'Empty response from background';
          res.reason = 'empty';
          break;
        }
        res = resp;
      } while (false);
      if (!res.ok && (res.reason === 'network' || res.reason === 'messaging')) {
        sgStatsMemo.delete(ck); // transient - allow a retry on a later scan
      }
      return res;
    })();
    sgStatsMemo.set(ck, p);
    retVal = p;
  } while (false);
  sgExit(fn);
  return retVal;
}

/* ------------------------------------------------------------------------- */
function sgFormatCount(n) {
  let retVal = '?';
  do {
    if (!Number.isFinite(n)) {
      break;
    }
    if (n >= 1e6) {
      retVal = (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
      break;
    }
    if (n >= 1e3) {
      retVal = (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
      break;
    }
    retVal = String(n);
  } while (false);
  return retVal;
}

/*
 * Turn raw stats into { level, parts:[{text, flag}], tip:[lines] }.
 * level: ok (0 flags) | warn (1 flag) | bad (2+ flags) | err
 */
function sgEvaluate(stats, s) {
  const fn = 'sgEvaluate';
  const retVal = { level: 'err', parts: [], tip: [] };
  sgEntry(fn);
  do {
    if (!stats || !stats.ok) {
      retVal.parts.push({ text: '?', flag: false });
      retVal.tip.push('Slop Gauge: ' + ((stats && stats.error) || 'no data'));
      break;
    }
    let flags = 0;
    retVal.tip.push(stats.title + (stats.handle ? '  (' + stats.handle + ')' : ''));

    // 1. Channel age
    const created = Date.parse(stats.publishedAt);
    const cutoff = Date.parse(s.newChannelCutoff);
    if (Number.isFinite(created)) {
      const isNew = Number.isFinite(cutoff) && created >= cutoff;
      flags += isNew ? 1 : 0;
      retVal.parts.push({ text: String(new Date(created).getFullYear()), flag: isNew });
      retVal.tip.push('Created ' + stats.publishedAt.slice(0, 10)
        + (isNew ? '   ⚠ on/after ' + s.newChannelCutoff : ''));
    }

    // 2. Upload rate
    if (Number.isFinite(stats.perWeek)) {
      const high = stats.perWeek > Number(s.maxPerWeek);
      flags += high ? 1 : 0;
      const ge = stats.uploadsTruncated ? '≥' : '';
      retVal.parts.push({ text: ge + stats.perWeek.toFixed(1) + '/wk', flag: high });
      retVal.tip.push(`Uploads since ${stats.rateSince}: ${ge}${stats.uploadsSince} in `
        + `${stats.weeks.toFixed(1)} wk = ${ge}${stats.perWeek.toFixed(2)}/wk`
        + (high ? `   ⚠ > ${s.maxPerWeek}/wk` : ''));
    }

    // 3. Subscribers
    if (stats.hiddenSubs) {
      retVal.parts.push({ text: 'subs hidden', flag: false });
      retVal.tip.push('Subscriber count hidden');
    } else if (Number.isFinite(stats.subscribers)) {
      const low = stats.subscribers < Number(s.minSubscribers);
      flags += low ? 1 : 0;
      retVal.parts.push({ text: sgFormatCount(stats.subscribers), flag: low });
      retVal.tip.push('Subscribers: ' + stats.subscribers.toLocaleString()
        + (low ? `   ⚠ < ${Number(s.minSubscribers).toLocaleString()}` : ''));
    }

    retVal.tip.push('Total videos: ' + stats.videoCount.toLocaleString());
    retVal.tip.push('Fetched ' + new Date(stats.fetchedAt).toLocaleString());
    retVal.tip.push('Click badge to trust / block');

    retVal.level = (flags === 0) ? 'ok' : (flags === 1) ? 'warn' : 'bad';
  } while (false);
  sgExit(fn, retVal.level);
  return retVal;
}

function sgEvaluateListed(hit, ctx) {
  const retVal = { level: 'err', parts: [], tip: [] };
  do {
    const lists = ctx.lists;
    const entry = lists && lists[hit.list] ? lists[hit.list][hit.id] : null;
    const name = entry ? (entry.title || entry.handle || hit.id) : hit.id;
    if (hit.list === 'trusted') {
      retVal.level = 'trusted';
      retVal.parts.push({ text: '✓ trusted', flag: false });
      retVal.tip.push(name + ' - on your trusted list');
    } else {
      retVal.level = 'blocked';
      retVal.parts.push({ text: '⛔ blocked', flag: false });
      retVal.tip.push(name + ' - on your blocked list');
    }
    retVal.tip.push('Click badge to change');
  } while (false);
  return retVal;
}

/* ------------------------------------------------------------------------- */
/* Badge menu                                                                 */
/* ------------------------------------------------------------------------- */
function sgCloseMenu() {
  if (sgMenu) {
    sgMenu.remove();
    sgMenu = null;
  }
}

/*
 * Build the list entry for the channel shown on a tile.
 * Returns { id, entry } or null.
 */
function sgEntryFromCtx(ctx) {
  const fn = 'sgEntryFromCtx';
  let retVal = null;
  sgEntry(fn);
  do {
    if (!ctx || !ctx.ck) {
      break;
    }
    const keys = [ctx.ck];
    let id = ctx.ck;   // fallback when stats are unavailable (no key, quota, ...)
    let title = '';
    let handle = ctx.key && ctx.key.kind === 'handle' ? ctx.key.value : '';
    const st = ctx.stats;
    if (st && st.ok && typeof st.id === 'string' && st.id) {
      id = st.id;
      keys.push(sgCacheKey({ kind: 'id', value: st.id }));
      title = st.title || '';
      if (st.handle) {
        handle = st.handle;
        keys.push(sgCacheKey({ kind: 'handle', value: st.handle }));
      }
    }
    retVal = { id: id, entry: { title: title, handle: handle, keys: keys.filter(Boolean) } };
  } while (false);
  sgExit(fn, retVal ? retVal.id : null);
  return retVal;
}

async function sgMenuAction(ctx, action) {
  const fn = 'sgMenuAction';
  sgEntry(fn, action);
  do {
    sgCloseMenu();
    if (!chrome.runtime || !chrome.runtime.id) {
      sgWarn(fn, 'extension context gone - refresh page');
      break;
    }
    if (action === 'remove') {
      if (!ctx.hit) {
        break;
      }
      await sgSetListMembership(ctx.hit.id, null, null);
      break;
    }
    if (action !== 'trusted' && action !== 'blocked') {
      sgWarn(fn, 'unknown action', action);
      break;
    }
    const e = sgEntryFromCtx(ctx);
    if (!e) {
      sgWarn(fn, 'cannot build list entry');
      break;
    }
    // If it was listed under a different id (e.g. handle-only), drop that first
    if (ctx.hit && ctx.hit.id !== e.id) {
      await sgSetListMembership(ctx.hit.id, null, null);
    }
    await sgSetListMembership(e.id, e.entry, action);
    // storage.onChanged re-renders every tab
  } while (false);
  sgExit(fn);
}

function sgOpenMenu(badge, ctx) {
  const fn = 'sgOpenMenu';
  sgEntry(fn);
  do {
    sgCloseMenu();
    if (!badge.isConnected) {
      break;
    }
    const menu = document.createElement('div');
    menu.className = 'sg-menu';

    const head = document.createElement('div');
    head.className = 'sg-menu-head';
    const st = ctx.stats;
    head.textContent = (st && st.ok && st.title) ? st.title
      : (ctx.key ? ctx.key.value : 'Channel');
    menu.appendChild(head);

    const addItem = (label, action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sg-menu-item';
      b.textContent = label;
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        sgMenuAction(ctx, action);
      });
      menu.appendChild(b);
    };

    const listed = ctx.hit ? ctx.hit.list : '';
    if (listed !== 'trusted') {
      addItem('✓ Trust this channel', 'trusted');
    }
    if (listed !== 'blocked') {
      addItem('⛔ Block this channel', 'blocked');
    }
    if (listed) {
      addItem('Remove from ' + listed + ' list', 'remove');
    }

    // Swallow clicks inside the menu so YouTube never sees them
    menu.addEventListener('click', (ev) => ev.stopPropagation());

    document.body.appendChild(menu);
    const r = badge.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, r.top - mh - 4);
    }
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';
    sgMenu = menu;
  } while (false);
  sgExit(fn);
}

/* ------------------------------------------------------------------------- */
function sgRenderBadge(thumb, ev, ctx) {
  const fn = 'sgRenderBadge';
  sgEntry(fn);
  do {
    if (!thumb || !thumb.isConnected) {
      break;
    }
    const old = thumb.querySelector(':scope > .sg-badge');
    if (old) {
      old.remove();
    }
    const badge = document.createElement('div');
    badge.className = 'sg-badge sg-' + ev.level + (ctx ? ' sg-clickable' : '');
    badge.dataset.sgGen = String(sgGen);
    ev.parts.forEach((p, i) => {
      if (i > 0) {
        badge.appendChild(document.createTextNode(' · '));
      }
      const span = document.createElement('span');
      span.textContent = p.text; // textContent only - never innerHTML with API data
      if (p.flag) {
        span.className = 'sg-flag';
      }
      badge.appendChild(span);
    });
    badge.title = ev.tip.join('\n');
    if (ctx) {
      badge.addEventListener('click', (e) => {
        // The badge sits inside the thumbnail link: stop it navigating
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        sgOpenMenu(badge, ctx);
      });
    }
    thumb.classList.add('sg-host');
    thumb.appendChild(badge);
  } while (false);
  sgExit(fn);
}

function sgRenderPending(thumb) {
  sgRenderBadge(thumb, { level: 'pending', parts: [{ text: '…', flag: false }], tip: ['Slop Gauge: loading'] }, null);
}

function sgClearBlockState(item) {
  item.classList.remove(...SG_BLOCK_CLASSES);
}

function sgApplyListed(item, thumb, ctx) {
  const fn = 'sgApplyListed';
  sgEntry(fn, ctx.hit);
  do {
    sgClearBlockState(item);
    if (ctx.hit.list === 'blocked') {
      item.classList.add(sgSettings.blockMode === 'dim' ? 'sg-blocked-dim' : 'sg-blocked-hide');
    }
    sgRenderBadge(thumb, sgEvaluateListed(ctx.hit, ctx), ctx);
  } while (false);
  sgExit(fn);
}

/* ------------------------------------------------------------------------- */
function sgProcessItem(item) {
  const fn = 'sgProcessItem';
  sgEntry(fn);
  do {
    // Skip tiles nested in another tile (new layouts wrap lockups inside rich items)
    if (item.parentElement && item.parentElement.closest(SG_ITEM_SELECTOR)) {
      break;
    }
    const thumb = item.querySelector(SG_THUMB_SELECTOR);
    if (!thumb) {
      break;
    }
    const key = sgFindChannelKey(item);
    if (!key) {
      break; // channel link not rendered yet - a later mutation will retry
    }
    const ck = sgCacheKey(key);
    if (!ck) {
      break;
    }
    const existing = thumb.querySelector(':scope > .sg-badge');
    if (item.dataset.sgKey === ck && existing && existing.dataset.sgGen === String(sgGen)) {
      break; // already up to date
    }

    item.dataset.sgKey = ck;
    sgClearBlockState(item);
    const gen = sgGen;
    const ctx = { ck: ck, key: key, stats: null, hit: null, lists: sgLists };

    // Listed channels need no API call
    const hit = sgListIndex.get(ck);
    if (hit) {
      ctx.hit = hit;
      sgApplyListed(item, thumb, ctx);
      break;
    }

    sgRenderPending(thumb);
    sgGetStats(key, ck).then((stats) => {
      // YouTube recycles tile elements - make sure this tile still shows the same channel
      if (item.dataset.sgKey !== ck || gen !== sgGen) {
        return;
      }
      const t = item.querySelector(SG_THUMB_SELECTOR);
      if (!t) {
        return;
      }
      ctx.stats = stats;
      // Tile linked by handle, list entry known by channel id (or vice versa)
      if (stats && stats.ok && stats.id) {
        const idHit = sgListIndex.get(sgCacheKey({ kind: 'id', value: stats.id }));
        if (idHit) {
          ctx.hit = idHit;
          sgApplyListed(item, t, ctx);
          return;
        }
      }
      sgRenderBadge(t, sgEvaluate(stats, sgSettings), ctx);
    });
  } while (false);
  sgExit(fn);
}

function sgScan() {
  const fn = 'sgScan';
  sgEntry(fn);
  do {
    sgScanTimer = 0;
    if (!sgSettings.enabled) {
      document.querySelectorAll('.sg-badge').forEach((b) => b.remove());
      document.querySelectorAll('.sg-blocked-hide, .sg-blocked-dim').forEach(sgClearBlockState);
      break;
    }
    const items = document.querySelectorAll(SG_ITEM_SELECTOR);
    for (const item of items) {
      try {
        sgProcessItem(item);
      } catch (e) {
        sgWarn(fn, 'processItem threw', e);
      }
    }
  } while (false);
  sgExit(fn);
}

function sgScheduleScan() {
  if (!sgScanTimer) {
    sgScanTimer = setTimeout(sgScan, SG_SCAN_DEBOUNCE_MS);
  }
}

/* ------------------------------------------------------------------------- */
let sgLists = sgEmptyLists();

async function sgLoadSettings() {
  const fn = 'sgLoadSettings';
  sgEntry(fn);
  do {
    let s;
    try {
      s = await chrome.storage.sync.get(SG_DEFAULTS);
    } catch (e) {
      sgWarn(fn, 'storage.sync.get failed', e);
      break;
    }
    if (!s || typeof s !== 'object') {
      break;
    }
    sgSettings = s;
    sgSetDebug(s.debug);
  } while (false);
  sgExit(fn);
}

async function sgReloadLists() {
  sgLists = await sgLoadLists();
  sgListIndex = sgIndexLists(sgLists);
}

async function sgInit() {
  const fn = 'sgInit';
  sgEntry(fn);
  do {
    await sgLoadSettings();
    await sgReloadLists();

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync') {
        await sgLoadSettings();
        sgStatsMemo.clear();
      } else if (area === 'local' && changes[SG_LISTS_KEY]) {
        await sgReloadLists();
      } else {
        return; // cache writes etc. - nothing to redraw
      }
      sgCloseMenu();
      sgGen++;
      sgScheduleScan();
    });

    const obs = new MutationObserver(sgScheduleScan);
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
    document.addEventListener('yt-navigate-finish', sgScheduleScan);
    document.addEventListener('yt-navigate-start', sgCloseMenu);

    // Close the menu on outside click, Escape or scroll
    document.addEventListener('click', (e) => {
      if (sgMenu && !sgMenu.contains(e.target)) {
        sgCloseMenu();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        sgCloseMenu();
      }
    }, true);
    window.addEventListener('scroll', sgCloseMenu, { capture: true, passive: true });

    sgScan();
  } while (false);
  sgExit(fn);
}

sgInit();
