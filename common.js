/*
 * common.js - shared by background service worker, content script and options page.
 */
'use strict';

const SG_DEFAULTS = Object.freeze({
  enabled: true,
  apiKey: '',
  newChannelCutoff: '2025-01-01', // channel created on/after this date => flag
  rateSince: '2026-01-01',        // count uploads from this date onwards
  maxPerWeek: 2,                  // more uploads/week than this => flag
  minSubscribers: 10000,          // fewer subscribers than this => flag
  cacheDays: 7,                   // how long channel stats are cached
  maxUploadPages: 4,              // x50 uploads scanned per channel (caps API quota use)
  blockMode: 'hide',              // 'hide' = remove blocked tiles, 'dim' = grey them out
  debug: false
});

const SG_CACHE_PREFIX = 'ch:';
const SG_LISTS_KEY = 'sgLists';   // chrome.storage.local - no 8KB/item limit like sync
const SG_LIST_NAMES = Object.freeze(['trusted', 'blocked']);
const SG_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let SG_debug = false;

function sgSetDebug(on) {
  SG_debug = !!on;
}

function sgLog(fn, ...args) {
  if (SG_debug) {
    console.debug('[SlopGauge]', fn, ...args);
  }
}

function sgEntry(fn, ...args) {
  sgLog(fn, '> entry', ...args);
}

function sgExit(fn, ...args) {
  sgLog(fn, '< exit', ...args);
}

function sgWarn(fn, ...args) {
  console.warn('[SlopGauge]', fn, ...args);
}

/*
 * Build a cache key from a channel key {kind:'handle'|'id', value}.
 * Returns '' on invalid input.
 */
function sgCacheKey(key) {
  const fn = 'sgCacheKey';
  let retVal = '';
  do {
    if (!key || typeof key !== 'object') {
      sgWarn(fn, 'key is not an object', key);
      break;
    }
    if (typeof key.value !== 'string' || key.value.length === 0 || key.value.length > 200) {
      sgWarn(fn, 'bad key value', key);
      break;
    }
    if (key.kind === 'handle') {
      // Handles are case-insensitive
      retVal = SG_CACHE_PREFIX + 'h:' + key.value.toLowerCase();
      break;
    }
    if (key.kind === 'id') {
      retVal = SG_CACHE_PREFIX + 'i:' + key.value;
      break;
    }
    sgWarn(fn, 'unknown key kind', key.kind);
  } while (false);
  return retVal;
}

/* ===================== Trust / block lists =====================
 * Stored shape:
 *   { trusted: { <entryId>: Entry }, blocked: { <entryId>: Entry } }
 *   Entry = { title, handle, keys: [cacheKey...], addedAt }
 * entryId is the channel id (UC...) when known, otherwise a handle cache key.
 * keys holds every cache key the channel can be recognised by (handle(s) and id),
 * so a tile can be matched without an API call.
 */

function sgEmptyLists() {
  return { trusted: {}, blocked: {} };
}

function sgValidateLists(raw) {
  const fn = 'sgValidateLists';
  const retVal = sgEmptyLists();
  sgEntry(fn);
  do {
    if (!raw || typeof raw !== 'object') {
      break;
    }
    for (const name of SG_LIST_NAMES) {
      const src = raw[name];
      if (!src || typeof src !== 'object') {
        continue;
      }
      for (const [id, e] of Object.entries(src)) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 220) {
          continue;
        }
        if (!e || typeof e !== 'object') {
          continue;
        }
        const keys = Array.isArray(e.keys)
          ? e.keys.filter((k) => typeof k === 'string' && k.startsWith(SG_CACHE_PREFIX) && k.length <= 220)
          : [];
        if (keys.length === 0) {
          continue;
        }
        // A channel can only be in one list; first list wins on corrupt data
        if (name === 'blocked' && retVal.trusted[id]) {
          continue;
        }
        retVal[name][id] = {
          title: String(e.title || '').slice(0, 200),
          handle: String(e.handle || '').slice(0, 200),
          keys: Array.from(new Set(keys)),
          addedAt: Number.isFinite(e.addedAt) ? e.addedAt : Date.now()
        };
      }
    }
  } while (false);
  sgExit(fn);
  return retVal;
}

async function sgLoadLists() {
  const fn = 'sgLoadLists';
  let retVal = sgEmptyLists();
  sgEntry(fn);
  do {
    let got;
    try {
      got = await chrome.storage.local.get(SG_LISTS_KEY);
    } catch (e) {
      sgWarn(fn, 'storage.local.get failed', e);
      break;
    }
    retVal = sgValidateLists(got ? got[SG_LISTS_KEY] : null);
  } while (false);
  sgExit(fn, Object.keys(retVal.trusted).length, Object.keys(retVal.blocked).length);
  return retVal;
}

async function sgSaveLists(lists) {
  const fn = 'sgSaveLists';
  let retVal = false;
  sgEntry(fn);
  do {
    const clean = sgValidateLists(lists);
    try {
      await chrome.storage.local.set({ [SG_LISTS_KEY]: clean });
    } catch (e) {
      sgWarn(fn, 'storage.local.set failed', e);
      break;
    }
    retVal = true;
  } while (false);
  sgExit(fn, retVal);
  return retVal;
}

/* Map cacheKey -> { list: 'trusted'|'blocked', id } */
function sgIndexLists(lists) {
  const retVal = new Map();
  do {
    if (!lists || typeof lists !== 'object') {
      break;
    }
    for (const name of SG_LIST_NAMES) {
      for (const [id, e] of Object.entries(lists[name] || {})) {
        for (const k of e.keys) {
          retVal.set(k, { list: name, id: id });
        }
      }
    }
  } while (false);
  return retVal;
}

/*
 * Put a channel in a list, or remove it from all lists (listName === null).
 * entry is required when adding: { title, handle, keys }.
 */
async function sgSetListMembership(entryId, entry, listName) {
  const fn = 'sgSetListMembership';
  let retVal = false;
  sgEntry(fn, entryId, listName);
  do {
    if (typeof entryId !== 'string' || entryId === '') {
      sgWarn(fn, 'bad entryId');
      break;
    }
    if (listName !== null && !SG_LIST_NAMES.includes(listName)) {
      sgWarn(fn, 'bad list name', listName);
      break;
    }
    if (listName !== null && (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0)) {
      sgWarn(fn, 'entry without keys');
      break;
    }
    const lists = await sgLoadLists();
    for (const name of SG_LIST_NAMES) {
      delete lists[name][entryId];
    }
    if (listName !== null) {
      lists[listName][entryId] = {
        title: String(entry.title || ''),
        handle: String(entry.handle || ''),
        keys: entry.keys.slice(),
        addedAt: Date.now()
      };
    }
    retVal = await sgSaveLists(lists);
  } while (false);
  sgExit(fn, retVal);
  return retVal;
}
