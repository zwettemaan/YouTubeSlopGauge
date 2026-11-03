/*
 * content.js - runs on youtube.com. Finds video tiles, works out each tile's
 * channel, asks the background worker for stats, and overlays a badge.
 * Clicking a badge opens a menu to trust / block the channel.
 */
'use strict';

let sgSettings = { ...SG_DEFAULTS };
let sgListIndex = new Map();      // cacheKey -> { list, id }
let sgGen = 0;                    // bumps when settings/lists change => forces re-render
let sgScanTimer = 0;
let sgMenu = null;                // currently open menu element
const sgStatsMemo = new Map();    // cacheKey -> Promise<stats>

/* ------------------------------------------------------------------------- */
function sgParseChannelPath(pathname) {
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
        sgWarn('bad handle encoding', m[1]);
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
  }
  while (CONDITION_LADDER_END);
  return retVal;
}

function sgFindChannelKey(item) {
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
  }
  while (CONDITION_LADDER_END);
  sgNote(retVal);
  return retVal;
}

/* ------------------------------------------------------------------------- */
function sgGetStats(key, ck) {
  let retVal = null;
  sgEntry(ck);
  do {
    if (sgStatsMemo.has(ck)) {
      retVal = sgStatsMemo.get(ck);
      break;
    }
    const p = (async () => {
      let res = { ok: false, error: SG_TXT_UNKNOWN_ERROR, reason: 'unknown' };
      do {
        if (!chrome.runtime || !chrome.runtime.id) {
          res.error = SG_TXT_ERR_EXTENSION_RELOADED;
          res.reason = 'contextInvalidated';
          break;
        }
        let resp;
        try {
          resp = await chrome.runtime.sendMessage({ type: 'getChannelStats', key: key });
        } catch (e) {
          res.error = sgFormat(SG_TXT_ERR_MESSAGING, e && e.message ? e.message : String(e));
          res.reason = 'messaging';
          break;
        }
        if (!resp || typeof resp !== 'object') {
          res.error = 'Empty response from background';
          res.reason = 'empty';
          break;
        }
        res = resp;
      }
      while (CONDITION_LADDER_END);
      if (!res.ok && (res.reason === 'network' || res.reason === 'messaging')) {
        sgStatsMemo.delete(ck); // transient - allow a retry on a later scan
      }
      return res;
    })();
    sgStatsMemo.set(ck, p);
    retVal = p;
  }
  while (CONDITION_LADDER_END);
  sgExit();
  return retVal;
}

/* ------------------------------------------------------------------------- */
function sgFormatCount(n) {
  let retVal = SG_TXT_UNKNOWN_VALUE;
  do {
    if (!Number.isFinite(n)) {
      break;
    }
    if (n >= SG_COUNT_MILLION) {
      const decimals = n >= SG_COUNT_MILLION * SG_COUNT_NO_DECIMALS_FACTOR ? 0 : SG_COUNT_DECIMALS;
      retVal = (n / SG_COUNT_MILLION).toFixed(decimals) + SG_TXT_MILLION_SUFFIX;
      break;
    }
    if (n >= SG_COUNT_THOUSAND) {
      const decimals = n >= SG_COUNT_THOUSAND * SG_COUNT_NO_DECIMALS_FACTOR ? 0 : SG_COUNT_DECIMALS;
      retVal = (n / SG_COUNT_THOUSAND).toFixed(decimals) + SG_TXT_THOUSAND_SUFFIX;
      break;
    }
    retVal = String(n);
  }
  while (CONDITION_LADDER_END);
  return retVal;
}

/*
 * Turn raw stats into { level, parts:[{text, flag}], tip:[lines] }.
 * level: ok (0 flags) | warn (1 flag) | bad (2+ flags) | err
 */
function sgEvaluate(stats, s) {
  const retVal = { level: 'err', parts: [], tip: [] };
  sgEntry();
  do {
    if (!stats || !stats.ok) {
      retVal.parts.push({ text: SG_TXT_UNKNOWN_VALUE, flag: false });
      retVal.tip.push(sgFormat(SG_TXT_TIP_ERROR, (stats && stats.error) || SG_TXT_TIP_NO_DATA));
      break;
    }
    let flags = 0;
    retVal.tip.push(stats.handle ? sgFormat(SG_TXT_TIP_TITLE_HANDLE, stats.title, stats.handle) : stats.title);

    // 1. Channel age
    const created = Date.parse(stats.publishedAt);
    const cutoff = Date.parse(s.newChannelCutoff);
    if (Number.isFinite(created)) {
      const isNew = Number.isFinite(cutoff) && created >= cutoff;
      flags += isNew ? 1 : 0;
      retVal.parts.push({ text: String(new Date(created).getFullYear()), flag: isNew });
      retVal.tip.push(sgFormat(SG_TXT_TIP_CREATED, stats.publishedAt.slice(0, SG_ISO_DATE_LENGTH))
        + (isNew ? sgFormat(SG_TXT_TIP_CREATED_FLAG, s.newChannelCutoff) : ''));
    }

    // 2. Upload rate
    if (Number.isFinite(stats.perWeek)) {
      const high = stats.perWeek > Number(s.maxPerWeek);
      flags += high ? 1 : 0;
      const ge = stats.uploadsTruncated ? SG_TXT_AT_LEAST : '';
      retVal.parts.push({
        text: sgFormat(SG_TXT_BADGE_RATE, ge, stats.perWeek.toFixed(SG_RATE_BADGE_DECIMALS)),
        flag: high
      });
      retVal.tip.push(sgFormat(SG_TXT_TIP_UPLOADS, stats.rateSince, ge, stats.uploadsSince,
        stats.weeks.toFixed(SG_WEEKS_TIP_DECIMALS), stats.perWeek.toFixed(SG_RATE_TIP_DECIMALS))
        + (high ? sgFormat(SG_TXT_TIP_UPLOADS_FLAG, s.maxPerWeek) : ''));
    }

    // 3. Subscribers
    if (stats.hiddenSubs) {
      retVal.parts.push({ text: SG_TXT_BADGE_SUBS_HIDDEN, flag: false });
      retVal.tip.push(SG_TXT_TIP_SUBS_HIDDEN);
    } else if (Number.isFinite(stats.subscribers)) {
      const low = stats.subscribers < Number(s.minSubscribers);
      flags += low ? 1 : 0;
      retVal.parts.push({ text: sgFormatCount(stats.subscribers), flag: low });
      retVal.tip.push(sgFormat(SG_TXT_TIP_SUBS, stats.subscribers.toLocaleString())
        + (low ? sgFormat(SG_TXT_TIP_SUBS_FLAG, Number(s.minSubscribers).toLocaleString()) : ''));
    }

    retVal.tip.push(sgFormat(SG_TXT_TIP_VIDEOS, stats.videoCount.toLocaleString()));
    retVal.tip.push(sgFormat(SG_TXT_TIP_FETCHED, new Date(stats.fetchedAt).toLocaleString()));
    retVal.tip.push(SG_TXT_TIP_CLICK_TO_LIST);

    retVal.level = (flags === 0) ? 'ok' : (flags === 1) ? 'warn' : 'bad';
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal.level);
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
      retVal.parts.push({ text: SG_TXT_BADGE_TRUSTED, flag: false });
      retVal.tip.push(sgFormat(SG_TXT_TIP_ON_TRUSTED, name));
    } else {
      retVal.level = 'blocked';
      retVal.parts.push({ text: SG_TXT_BADGE_BLOCKED, flag: false });
      retVal.tip.push(sgFormat(SG_TXT_TIP_ON_BLOCKED, name));
    }
    retVal.tip.push(SG_TXT_TIP_CLICK_TO_CHANGE);
  }
  while (CONDITION_LADDER_END);
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
  let retVal = null;
  sgEntry();
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
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal ? retVal.id : null);
  return retVal;
}

async function sgMenuAction(ctx, action) {
  sgEntry(action);
  do {
    sgCloseMenu();
    if (!chrome.runtime || !chrome.runtime.id) {
      sgWarn('extension context gone - refresh page');
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
      sgWarn('unknown action', action);
      break;
    }
    const e = sgEntryFromCtx(ctx);
    if (!e) {
      sgWarn('cannot build list entry');
      break;
    }
    // If it was listed under a different id (e.g. handle-only), drop that first
    if (ctx.hit && ctx.hit.id !== e.id) {
      await sgSetListMembership(ctx.hit.id, null, null);
    }
    await sgSetListMembership(e.id, e.entry, action);
    // storage.onChanged re-renders every tab
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

function sgOpenMenu(badge, ctx) {
  sgEntry();
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
      : (ctx.key ? ctx.key.value : SG_TXT_MENU_CHANNEL);
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
      addItem(SG_TXT_MENU_TRUST, 'trusted');
    }
    if (listed !== 'blocked') {
      addItem(SG_TXT_MENU_BLOCK, 'blocked');
    }
    if (listed) {
      addItem(sgFormat(SG_TXT_MENU_REMOVE, listed), 'remove');
    }

    // Swallow clicks inside the menu so YouTube never sees them
    menu.addEventListener('click', (ev) => ev.stopPropagation());

    document.body.appendChild(menu);
    const r = badge.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(r.left, window.innerWidth - mw - SG_MENU_VIEWPORT_MARGIN_PX);
    let top = r.bottom + SG_MENU_BADGE_GAP_PX;
    if (top + mh > window.innerHeight - SG_MENU_VIEWPORT_MARGIN_PX) {
      top = Math.max(SG_MENU_VIEWPORT_MARGIN_PX, r.top - mh - SG_MENU_BADGE_GAP_PX);
    }
    menu.style.left = Math.max(SG_MENU_VIEWPORT_MARGIN_PX, left) + 'px';
    menu.style.top = top + 'px';
    sgMenu = menu;
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

/* ------------------------------------------------------------------------- */
function sgRenderBadge(thumb, ev, ctx) {
  sgEntry();
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
        badge.appendChild(document.createTextNode(SG_TXT_BADGE_SEPARATOR));
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
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

function sgRenderPending(thumb) {
  sgRenderBadge(thumb, { level: 'pending', parts: [{ text: SG_TXT_BADGE_PENDING, flag: false }], tip: [SG_TXT_TIP_LOADING] }, null);
}

function sgClearBlockState(item) {
  item.classList.remove(...SG_BLOCK_CLASSES);
}

function sgApplyListed(item, thumb, ctx) {
  sgEntry(ctx.hit);
  do {
    sgClearBlockState(item);
    if (ctx.hit.list === 'blocked') {
      item.classList.add(sgSettings.blockMode === 'dim' ? 'sg-blocked-dim' : 'sg-blocked-hide');
    }
    sgRenderBadge(thumb, sgEvaluateListed(ctx.hit, ctx), ctx);
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

/* ------------------------------------------------------------------------- */
function sgProcessItem(item) {
  sgEntry();
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
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

function sgScan() {
  sgEntry();
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
        sgError('processItem threw', e);
      }
    }
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

function sgScheduleScan() {
  if (!sgScanTimer) {
    sgScanTimer = setTimeout(sgScan, SG_SCAN_DEBOUNCE_MS);
  }
}

/* ------------------------------------------------------------------------- */
let sgLists = sgEmptyLists();

async function sgLoadSettings() {
  sgEntry();
  do {
    let s;
    try {
      s = await chrome.storage.sync.get(SG_DEFAULTS);
    } catch (e) {
      sgError('storage.sync.get failed', e);
      break;
    }
    if (!s || typeof s !== 'object') {
      break;
    }
    sgSettings = s;
    sgSetLogLevel(s.logLevel);
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

async function sgReloadLists() {
  sgLists = await sgLoadLists();
  sgListIndex = sgIndexLists(sgLists);
}

async function sgInit() {
  sgEntry();
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
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

sgInit();
