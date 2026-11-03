/*
 * background.js - MV3 service worker.
 * Owns the API key, talks to the YouTube Data API v3, caches results.
 */
'use strict';

importScripts('common.js');

const inflight = new Map();   // cacheKey -> Promise (dedupes concurrent lookups)
let quotaBlockedUntil = 0;

/* ------------------------------------------------------------------------- */
async function getSettings() {
  let retVal = { ...SG_DEFAULTS };
  sgEntry();
  do {
    let s = null;
    try {
      s = await chrome.storage.sync.get(SG_DEFAULTS);
    } catch (e) {
      sgError('storage.sync.get failed', e);
      break;
    }
    if (!s || typeof s !== 'object') {
      sgWarn('settings object missing');
      break;
    }
    retVal = s;
    sgSetLogLevel(retVal.logLevel);
  }
  while (CONDITION_LADDER_END);
  sgExit('(settings loaded)'); // never log the API key
  return retVal;
}

/* ------------------------------------------------------------------------- */
async function apiGet(endpoint, params, apiKey) {
  let retVal = { ok: false, data: null, error: SG_TXT_UNKNOWN_ERROR, reason: 'unknown' };
  sgEntry(endpoint);
  do {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      retVal.error = SG_TXT_ERR_NO_KEY;
      retVal.reason = 'noKey';
      break;
    }
    if (Date.now() < quotaBlockedUntil) {
      retVal.error = SG_TXT_ERR_QUOTA;
      retVal.reason = 'quotaExceeded';
      break;
    }
    if (!params || typeof params !== 'object') {
      retVal.error = 'Bad params';
      retVal.reason = 'badParams';
      break;
    }

    let url;
    try {
      url = new URL(SG_API_BASE + endpoint);
    } catch (e) {
      retVal.error = 'Bad endpoint';
      retVal.reason = 'badParams';
      break;
    }
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', apiKey.trim());

    let resp;
    try {
      resp = await fetch(url.toString(), { method: 'GET', credentials: 'omit' });
    } catch (e) {
      retVal.error = sgFormat(SG_TXT_ERR_NETWORK, e && e.message ? e.message : String(e));
      retVal.reason = 'network';
      break;
    }

    let json = null;
    try {
      json = await resp.json();
    } catch (e) {
      json = null;
    }

    if (!resp.ok) {
      const reason = (json && json.error && Array.isArray(json.error.errors) && json.error.errors[0]
        && json.error.errors[0].reason) || ('http' + resp.status);
      retVal.reason = reason;
      retVal.error = (json && json.error && json.error.message) || sgFormat(SG_TXT_ERR_HTTP, resp.status);
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') {
        quotaBlockedUntil = Date.now() + SG_QUOTA_BACKOFF_MS;
      }
      sgWarn(endpoint, resp.status, reason);
      break;
    }
    if (!json || typeof json !== 'object') {
      retVal.error = 'Malformed JSON from API';
      retVal.reason = 'badJson';
      break;
    }

    // all is well
    retVal = { ok: true, data: json, error: '', reason: '' };
  }
  while (CONDITION_LADDER_END);
  sgExit(endpoint, retVal.ok ? 'ok' : retVal.reason);
  return retVal;
}

/* ------------------------------------------------------------------------- */
async function fetchChannel(key, apiKey) {
  let retVal = { ok: false, channel: null, error: SG_TXT_UNKNOWN_ERROR, reason: 'unknown' };
  sgEntry(key);
  do {
    const params = { part: 'snippet,statistics,contentDetails' };
    if (key.kind === 'handle') {
      params.forHandle = key.value;
    } else if (key.kind === 'id') {
      params.id = key.value;
    } else {
      retVal.error = 'Bad key kind';
      retVal.reason = 'badParams';
      break;
    }

    const r = await apiGet('channels', params, apiKey);
    if (!r.ok) {
      retVal.error = r.error;
      retVal.reason = r.reason;
      break;
    }
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    if (items.length === 0) {
      retVal.error = SG_TXT_ERR_NOT_FOUND;
      retVal.reason = 'notFound';
      break;
    }
    const ch = items[0];
    if (!ch || !ch.snippet || !ch.statistics) {
      retVal.error = 'Channel record incomplete';
      retVal.reason = 'badJson';
      break;
    }

    // all is well
    retVal = { ok: true, channel: ch, error: '', reason: '' };
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal.ok ? 'ok' : retVal.reason);
  return retVal;
}

/*
 * Count uploads published at/after sinceMs by paging the channel's uploads playlist
 * (newest first). Stops at the first page containing an older video, or at maxPages.
 */
async function countUploadsSince(playlistId, sinceMs, apiKey, maxPages) {
  let retVal = { ok: false, count: 0, truncated: false, error: SG_TXT_UNKNOWN_ERROR, reason: 'unknown' };
  sgEntry(playlistId, maxPages);
  do {
    if (typeof playlistId !== 'string' || playlistId === '') {
      // No uploads playlist => no uploads
      retVal = { ok: true, count: 0, truncated: false, error: '', reason: '' };
      break;
    }
    if (!Number.isFinite(sinceMs)) {
      retVal.error = SG_TXT_ERR_BAD_RATE_SINCE;
      retVal.reason = 'badParams';
      break;
    }
    const pageCap = Math.max(SG_MIN_UPLOAD_PAGES, Math.min(SG_MAX_UPLOAD_PAGES, Math.floor(Number(maxPages) || SG_MIN_UPLOAD_PAGES)));

    let count = 0;
    let truncated = false;
    let pageToken = '';
    let pages = 0;
    let failed = null;

    while (true) {
      if (pages >= pageCap) {
        truncated = true;
        break;
      }
      const params = { part: 'contentDetails', playlistId: playlistId, maxResults: SG_API_PAGE_SIZE };
      if (pageToken) {
        params.pageToken = pageToken;
      }
      const r = await apiGet('playlistItems', params, apiKey);
      pages++;
      if (!r.ok) {
        if (r.reason === 'playlistNotFound') {
          // Channel with no public uploads
          break;
        }
        failed = r;
        break;
      }
      const items = Array.isArray(r.data.items) ? r.data.items : [];
      let reachedOlder = false;
      for (const it of items) {
        const t = Date.parse(it && it.contentDetails && it.contentDetails.videoPublishedAt);
        if (!Number.isFinite(t)) {
          continue; // private/deleted entries have no publish date
        }
        if (t >= sinceMs) {
          count++;
        } else {
          reachedOlder = true;
        }
      }
      if (reachedOlder) {
        break;
      }
      pageToken = (typeof r.data.nextPageToken === 'string') ? r.data.nextPageToken : '';
      if (!pageToken) {
        break;
      }
    }

    if (failed) {
      retVal.error = failed.error;
      retVal.reason = failed.reason;
      break;
    }

    // all is well
    retVal = { ok: true, count: count, truncated: truncated, error: '', reason: '' };
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal.ok ? `${retVal.count}${retVal.truncated ? '+' : ''}` : retVal.reason);
  return retVal;
}

/* ------------------------------------------------------------------------- */
async function readCache(ck, settings) {
  let retVal = null;
  sgEntry(ck);
  do {
    let got;
    try {
      got = await chrome.storage.local.get(ck);
    } catch (e) {
      sgError('storage.local.get failed', e);
      break;
    }
    const entry = got ? got[ck] : null;
    if (!entry || typeof entry !== 'object') {
      break;
    }
    const maxAge = Math.max(0, Number(settings.cacheDays) || 0) * SG_DAY_MS;
    if (!Number.isFinite(entry.fetchedAt) || Date.now() - entry.fetchedAt > maxAge) {
      break; // expired
    }
    if (entry.ok && entry.rateSince !== settings.rateSince) {
      break; // computed against a different window
    }
    retVal = entry;
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal ? 'hit' : 'miss');
  return retVal;
}

async function writeCache(keys, entry) {
  sgEntry(keys);
  do {
    const obj = {};
    for (const k of keys) {
      if (k) {
        obj[k] = entry;
      }
    }
    if (Object.keys(obj).length === 0) {
      break;
    }
    try {
      await chrome.storage.local.set(obj);
    } catch (e) {
      sgError('storage.local.set failed', e);
    }
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

/* ------------------------------------------------------------------------- */
async function buildChannelStats(key, ck) {
  let retVal = { ok: false, error: SG_TXT_UNKNOWN_ERROR, reason: 'unknown' };
  sgEntry(ck);
  do {
    const settings = await getSettings();

    const cached = await readCache(ck, settings);
    if (cached) {
      retVal = cached;
      break;
    }

    const chr = await fetchChannel(key, settings.apiKey);
    if (!chr.ok) {
      retVal = { ok: false, error: chr.error, reason: chr.reason };
      if (chr.reason === 'notFound') {
        retVal.fetchedAt = Date.now();
        await writeCache([ck], retVal);
      }
      break;
    }
    const ch = chr.channel;

    const sinceMs = Date.parse(settings.rateSince);
    const uploadsId = ch.contentDetails && ch.contentDetails.relatedPlaylists
      ? ch.contentDetails.relatedPlaylists.uploads : '';
    const up = await countUploadsSince(uploadsId, sinceMs, settings.apiKey, settings.maxUploadPages);
    if (!up.ok) {
      retVal = { ok: false, error: up.error, reason: up.reason };
      break;
    }

    const now = Date.now();
    const createdMs = Date.parse(ch.snippet.publishedAt);
    const startMs = Math.max(sinceMs, Number.isFinite(createdMs) ? createdMs : sinceMs);
    const weeks = Math.max((now - startMs) / SG_WEEK_MS, SG_MIN_RATE_WEEKS);
    const hidden = !!ch.statistics.hiddenSubscriberCount;
    const subs = hidden ? null : Number(ch.statistics.subscriberCount);

    // all is well
    retVal = {
      ok: true,
      id: ch.id,
      title: String(ch.snippet.title || ''),
      handle: String(ch.snippet.customUrl || ''),
      publishedAt: String(ch.snippet.publishedAt || ''),
      subscribers: Number.isFinite(subs) ? subs : null,
      hiddenSubs: hidden,
      videoCount: Number(ch.statistics.videoCount) || 0,
      uploadsSince: up.count,
      uploadsTruncated: up.truncated,
      rateSince: settings.rateSince,
      weeks: weeks,
      perWeek: up.count / weeks,
      fetchedAt: now
    };
    // Store under both the requested key and the canonical channel-id key
    await writeCache([ck, sgCacheKey({ kind: 'id', value: ch.id })], retVal);
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal.ok ? 'ok' : retVal.reason);
  return retVal;
}

function getChannelStats(key) {
  let retVal = null;
  sgEntry(key);
  do {
    const ck = sgCacheKey(key);
    if (!ck) {
      retVal = Promise.resolve({ ok: false, error: 'Invalid channel key', reason: 'badParams' });
      break;
    }
    if (inflight.has(ck)) {
      retVal = inflight.get(ck);
      break;
    }
    const p = buildChannelStats(key, ck).finally(() => inflight.delete(ck));
    inflight.set(ck, p);
    retVal = p;
  }
  while (CONDITION_LADDER_END);
  sgExit();
  return retVal;
}

/* ------------------------------------------------------------------------- */
async function clearCache(expiredOnly) {
  let retVal = { ok: false, removed: 0 };
  sgEntry(expiredOnly);
  do {
    let all;
    try {
      all = await chrome.storage.local.get(null);
    } catch (e) {
      sgError('storage.local.get failed', e);
      break;
    }
    const settings = await getSettings();
    const maxAge = Math.max(0, Number(settings.cacheDays) || 0) * SG_DAY_MS;
    const now = Date.now();
    const doomed = Object.keys(all || {}).filter((k) => {
      if (!k.startsWith(SG_CACHE_PREFIX)) {
        return false;
      }
      if (!expiredOnly) {
        return true;
      }
      const e = all[k];
      return !e || !Number.isFinite(e.fetchedAt) || now - e.fetchedAt > maxAge;
    });
    if (doomed.length > 0) {
      try {
        await chrome.storage.local.remove(doomed);
      } catch (e) {
        sgError('storage.local.remove failed', e);
        break;
      }
    }
    retVal = { ok: true, removed: doomed.length };
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal);
  return retVal;
}

async function testKey() {
  let retVal = { ok: false, error: SG_TXT_UNKNOWN_ERROR };
  sgEntry();
  do {
    const settings = await getSettings();
    quotaBlockedUntil = 0; // explicit user test: try regardless
    const r = await apiGet('channels', { part: 'id', forHandle: SG_API_TEST_HANDLE }, settings.apiKey);
    if (!r.ok) {
      retVal.error = sgFormat(SG_TXT_ERR_WITH_REASON, r.error, r.reason);
      break;
    }
    retVal = { ok: true, error: '' };
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal);
  return retVal;
}

/* ------------------------------------------------------------------------- */
function onMessage(msg, sender, sendResponse) {
  let retVal = false; // true => we will respond asynchronously
  do {
    if (!sender || sender.id !== chrome.runtime.id) {
      sgWarn('message from foreign sender ignored');
      break;
    }
    if (!msg || typeof msg.type !== 'string') {
      sgWarn('malformed message');
      break;
    }

    let p = null;
    if (msg.type === 'getChannelStats') {
      p = getChannelStats(msg.key);
    } else if (msg.type === 'clearCache') {
      p = clearCache(false);
    } else if (msg.type === 'testKey') {
      p = testKey();
    } else {
      sgWarn('unknown message type', msg.type);
      break;
    }

    p.then(sendResponse).catch(function onMessageHandlerFailed(e) {
      sgError('handler threw', e);
      sendResponse({ ok: false, error: String(e), reason: 'exception' });
    });
    retVal = true;
  }
  while (CONDITION_LADDER_END);
  return retVal;
}

chrome.runtime.onMessage.addListener(onMessage);
chrome.runtime.onStartup.addListener(() => { clearCache(true); });
chrome.runtime.onInstalled.addListener((details) => {
  clearCache(true);
  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
