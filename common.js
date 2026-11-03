/*
 * common.js - shared by background service worker, content script and options page.
 */
'use strict';

/* Each level includes the ones below it. Stored by name in settings.logLevel. */
const SG_LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, note: 3, trace: 4 });
const SG_LOG_LEVEL_DEFAULT = 'warn';

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
  logLevel: SG_LOG_LEVEL_DEFAULT  // one of SG_LOG_LEVELS
});

const SG_CACHE_PREFIX = 'ch:';
const SG_LISTS_KEY = 'sgLists';   // chrome.storage.local - no 8KB/item limit like sync
const SG_LIST_NAMES = Object.freeze(['trusted', 'blocked']);
const CONDITION_LADDER_END = false;

/* ===================== Time ===================== */
const SG_SECOND_MS = 1000;
const SG_HOUR_MS = 60 * 60 * SG_SECOND_MS;
const SG_DAY_MS = 24 * SG_HOUR_MS;
const SG_WEEK_MS = 7 * SG_DAY_MS;
const SG_ISO_DATE_LENGTH = 10;          // 'YYYY-MM-DD'

/* ===================== Limits ===================== */
const SG_MAX_KEY_VALUE_LENGTH = 200;
const SG_MAX_CACHE_KEY_LENGTH = 220;
const SG_MAX_TITLE_LENGTH = 200;
const SG_MIN_UPLOAD_PAGES = 1;
const SG_MAX_UPLOAD_PAGES = 20;

/* ===================== YouTube / API (background) ===================== */
const SG_API_BASE = 'https://www.googleapis.com/youtube/v3/';
const SG_API_PAGE_SIZE = 50;            // playlistItems maxResults; API maximum
const SG_API_TEST_HANDLE = '@YouTube';  // channel looked up by "Test key"
const SG_QUOTA_BACKOFF_MS = SG_HOUR_MS; // pause API use after quotaExceeded
const SG_MIN_RATE_WEEKS = 1;            // floor so very young channels don't get silly rates
const SG_YT_BASE_URL = 'https://www.youtube.com/';
const SG_YT_CHANNEL_URL = SG_YT_BASE_URL + 'channel/';

/* ===================== Content script ===================== */
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

const SG_BLOCK_CLASSES = ['sg-blocked-hide', 'sg-blocked-dim'];
const SG_SCAN_DEBOUNCE_MS = 300;
const SG_MENU_VIEWPORT_MARGIN_PX = 8;   // menu keeps this far from the window edges
const SG_MENU_BADGE_GAP_PX = 4;         // gap between badge and menu

const SG_COUNT_THOUSAND = 1e3;
const SG_COUNT_MILLION = 1e6;
const SG_COUNT_DECIMALS = 1;            // 1.5K, 2.3M ...
const SG_COUNT_NO_DECIMALS_FACTOR = 10; // ... but 15K, 23M
const SG_RATE_BADGE_DECIMALS = 1;
const SG_RATE_TIP_DECIMALS = 2;
const SG_WEEKS_TIP_DECIMALS = 1;

/* ===================== Options page ===================== */
const OPT_BOOL = ['enabled'];
const OPT_TEXT = ['apiKey', 'newChannelCutoff', 'rateSince'];
const OPT_DATES = ['newChannelCutoff', 'rateSince'];
const OPT_ENUM = { blockMode: ['hide', 'dim'], logLevel: Object.keys(SG_LOG_LEVELS) };
const OPT_NUM = {
  maxPerWeek: [0, 1000],
  minSubscribers: [0, 1e10],
  cacheDays: [0, 365],
  maxUploadPages: [SG_MIN_UPLOAD_PAGES, SG_MAX_UPLOAD_PAGES]
};
const OPT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const SG_EXPORT_FORMAT = 'YouTubeSlopGauge-lists';
const SG_IMPORT_FORMATS = Object.freeze([SG_EXPORT_FORMAT, 'slop-gauge-lists']); // second: exports made before the repo rename
const SG_EXPORT_VERSION = 1;
const SG_EXPORT_JSON_INDENT = 2;
const SG_EXPORT_URL_REVOKE_MS = 5 * SG_SECOND_MS;

/* ===================== User-facing text =====================
 * {0}, {1}, ... are filled in by sgFormat().
 */
const SG_TXT_UNKNOWN_ERROR = 'unknown error';
const SG_TXT_ERR_NO_KEY = 'No API key set - open the extension options';
const SG_TXT_ERR_QUOTA = 'YouTube API daily quota exhausted - paused';
const SG_TXT_ERR_NETWORK = 'Network error: {0}';
const SG_TXT_ERR_HTTP = 'HTTP {0}';
const SG_TXT_ERR_NOT_FOUND = 'Channel not found';
const SG_TXT_ERR_BAD_RATE_SINCE = 'Bad rateSince date';
const SG_TXT_ERR_WITH_REASON = '{0} ({1})';
const SG_TXT_ERR_EXTENSION_RELOADED = 'Extension was reloaded - refresh this page';
const SG_TXT_ERR_MESSAGING = 'Messaging failed: {0}';

const SG_TXT_UNKNOWN_VALUE = '?';
const SG_TXT_THOUSAND_SUFFIX = 'K';
const SG_TXT_MILLION_SUFFIX = 'M';
const SG_TXT_AT_LEAST = '≥';
const SG_TXT_BADGE_SEPARATOR = ' · ';
const SG_TXT_BADGE_PENDING = '…';
const SG_TXT_BADGE_RATE = '{0}{1}/wk';
const SG_TXT_BADGE_SUBS_HIDDEN = 'subs hidden';
const SG_TXT_BADGE_TRUSTED = '✓ trusted';
const SG_TXT_BADGE_BLOCKED = '⛔ blocked';

const SG_TXT_TIP_ERROR = 'Slop Gauge: {0}';
const SG_TXT_TIP_NO_DATA = 'no data';
const SG_TXT_TIP_LOADING = 'Slop Gauge: loading';
const SG_TXT_TIP_TITLE_HANDLE = '{0}  ({1})';
const SG_TXT_TIP_CREATED = 'Created {0}';
const SG_TXT_TIP_CREATED_FLAG = '   ⚠ on/after {0}';
const SG_TXT_TIP_UPLOADS = 'Uploads since {0}: {1}{2} in {3} wk = {1}{4}/wk';
const SG_TXT_TIP_UPLOADS_FLAG = '   ⚠ > {0}/wk';
const SG_TXT_TIP_SUBS_HIDDEN = 'Subscriber count hidden';
const SG_TXT_TIP_SUBS = 'Subscribers: {0}';
const SG_TXT_TIP_SUBS_FLAG = '   ⚠ < {0}';
const SG_TXT_TIP_VIDEOS = 'Total videos: {0}';
const SG_TXT_TIP_FETCHED = 'Fetched {0}';
const SG_TXT_TIP_CLICK_TO_LIST = 'Click badge to trust / block';
const SG_TXT_TIP_ON_TRUSTED = '{0} - on your trusted list';
const SG_TXT_TIP_ON_BLOCKED = '{0} - on your blocked list';
const SG_TXT_TIP_CLICK_TO_CHANGE = 'Click badge to change';

const SG_TXT_MENU_CHANNEL = 'Channel';
const SG_TXT_MENU_TRUST = '✓ Trust this channel';
const SG_TXT_MENU_BLOCK = '⛔ Block this channel';
const SG_TXT_MENU_REMOVE = 'Remove from {0} list';

const SG_TXT_OPT_LOAD_FAILED = 'Could not load settings: {0}';
const SG_TXT_OPT_BAD_DATE = '{0} must be a valid date';
const SG_TXT_OPT_BAD_ENUM = '{0} must be one of {1}';
const SG_TXT_OPT_ENUM_SEPARATOR = ', ';
const SG_TXT_OPT_BAD_RANGE = '{0} must be between {1} and {2}';
const SG_TXT_OPT_SAVE_FAILED = 'Save failed: {0}';
const SG_TXT_OPT_SAVED = 'Saved. Open YouTube tabs update automatically.';
const SG_TXT_OPT_FAILED = 'Failed: {0}';
const SG_TXT_OPT_NO_RESPONSE = 'no response';
const SG_TXT_OPT_KEY_WORKS = 'API key works.';
const SG_TXT_OPT_CACHE_CLEARED = 'Cleared {0} cached channel(s). Refresh YouTube tabs.';
const SG_TXT_OPT_LIST_COUNT = '({0})';
const SG_TXT_OPT_LIST_EMPTY = 'None yet';
const SG_TXT_OPT_LIST_HANDLE = '  {0}';
const SG_TXT_OPT_REMOVE = 'Remove';
const SG_TXT_OPT_REMOVED = 'Removed "{0}" from {1}.';
const SG_TXT_OPT_REMOVE_FAILED = 'Remove failed.';
const SG_TXT_OPT_EXPORT_FILE_NAME = 'YouTubeSlopGauge-lists-{0}.json';
const SG_TXT_OPT_EXPORTED = 'Exported.';
const SG_TXT_OPT_IMPORT_TOO_LARGE = 'Import file is too large.';
const SG_TXT_OPT_IMPORT_READ_FAILED = 'Could not read file: {0}';
const SG_TXT_OPT_IMPORT_BAD_JSON = 'Not valid JSON.';
const SG_TXT_OPT_IMPORT_WRONG_FORMAT = 'Not a Slop Gauge lists export.';
const SG_TXT_OPT_IMPORTED = 'Imported {0} channel(s).';
const SG_TXT_OPT_IMPORT_SAVE_FAILED = 'Import failed while saving.';

/* Replace {0}, {1}, ... in template with the matching extra argument. */
function sgFormat(template, ...values) {
  return String(template).replace(/\{(\d+)\}/g, (match, idx) => (idx < values.length ? String(values[idx]) : match));
}

let SG_logLevel = SG_LOG_LEVELS[SG_LOG_LEVEL_DEFAULT];

function sgSetLogLevel(levelName) {
  SG_logLevel = Object.hasOwn(SG_LOG_LEVELS, levelName)
    ? SG_LOG_LEVELS[levelName]
    : SG_LOG_LEVELS[SG_LOG_LEVEL_DEFAULT];
}

const SG_LOG_PREFIX = '[SlopGauge]';

/*
 * Name of the function that called the public logger `loggerFn`, read from a
 * V8 structured stack (Chrome only). Built-in frames (forEach, ...) and
 * anonymous arrows are skipped so a callback logs under its enclosing function,
 * as long as that function is still on the stack - not true for callbacks run
 * later from .then / setTimeout / event listeners.
 */
function sgCallerName(loggerFn) {
  let retVal = '(unknown)';
  const savedPrepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    const holder = {};
    Error.captureStackTrace(holder, loggerFn);
    for (const frame of holder.stack) {
      const name = frame.getFileName() && frame.getFunctionName();
      if (name) {
        retVal = name;
        break;
      }
    }
  } catch (e) {
    // never let logging break the caller
  } finally {
    Error.prepareStackTrace = savedPrepare;
  }
  return retVal;
}

// Checks the level before reading the stack, so suppressed calls stay cheap.
function sgEmit(level, loggerFn, consoleFn, args) {
  if (SG_logLevel >= level) {
    consoleFn(SG_LOG_PREFIX, sgCallerName(loggerFn), ...args);
  }
}

function sgError(...args) {
  sgEmit(SG_LOG_LEVELS.error, sgError, console.error, args);
}

function sgWarn(...args) {
  sgEmit(SG_LOG_LEVELS.warn, sgWarn, console.warn, args);
}

function sgNote(...args) {
  sgEmit(SG_LOG_LEVELS.note, sgNote, console.info, args);
}

function sgEntry(...args) {
  sgEmit(SG_LOG_LEVELS.trace, sgEntry, console.debug, ['> entry', ...args]);
}

function sgExit(...args) {
  sgEmit(SG_LOG_LEVELS.trace, sgExit, console.debug, ['< exit', ...args]);
}

/*
 * Build a cache key from a channel key {kind:'handle'|'id', value}.
 * Returns '' on invalid input.
 */
function sgCacheKey(key) {
  let retVal = '';
  do {
    if (!key || typeof key !== 'object') {
      sgWarn('key is not an object', key);
      break;
    }
    if (typeof key.value !== 'string' || key.value.length === 0 || key.value.length > SG_MAX_KEY_VALUE_LENGTH) {
      sgWarn('bad key value', key);
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
    sgWarn('unknown key kind', key.kind);
  }
  while (CONDITION_LADDER_END);
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
  const retVal = sgEmptyLists();
  sgEntry();
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
        if (typeof id !== 'string' || id.length === 0 || id.length > SG_MAX_CACHE_KEY_LENGTH) {
          continue;
        }
        if (!e || typeof e !== 'object') {
          continue;
        }
        const keys = Array.isArray(e.keys)
          ? e.keys.filter((k) => typeof k === 'string' && k.startsWith(SG_CACHE_PREFIX) && k.length <= SG_MAX_CACHE_KEY_LENGTH)
          : [];
        if (keys.length === 0) {
          continue;
        }
        // A channel can only be in one list; first list wins on corrupt data
        if (name === 'blocked' && retVal.trusted[id]) {
          continue;
        }
        retVal[name][id] = {
          title: String(e.title || '').slice(0, SG_MAX_TITLE_LENGTH),
          handle: String(e.handle || '').slice(0, SG_MAX_TITLE_LENGTH),
          keys: Array.from(new Set(keys)),
          addedAt: Number.isFinite(e.addedAt) ? e.addedAt : Date.now()
        };
      }
    }
  }
  while (CONDITION_LADDER_END);
  sgExit();
  return retVal;
}

async function sgLoadLists() {
  let retVal = sgEmptyLists();
  sgEntry();
  do {
    let got;
    try {
      got = await chrome.storage.local.get(SG_LISTS_KEY);
    } catch (e) {
      sgError('storage.local.get failed', e);
      break;
    }
    retVal = sgValidateLists(got ? got[SG_LISTS_KEY] : null);
  }
  while (CONDITION_LADDER_END);
  sgExit(Object.keys(retVal.trusted).length, Object.keys(retVal.blocked).length);
  return retVal;
}

async function sgSaveLists(lists) {
  let retVal = false;
  sgEntry();
  do {
    const clean = sgValidateLists(lists);
    try {
      await chrome.storage.local.set({ [SG_LISTS_KEY]: clean });
    } catch (e) {
      sgError('storage.local.set failed', e);
      break;
    }
    retVal = true;
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal);
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
  }
  while (CONDITION_LADDER_END);
  return retVal;
}

/*
 * Put a channel in a list, or remove it from all lists (listName === null).
 * entry is required when adding: { title, handle, keys }.
 */
async function sgSetListMembership(entryId, entry, listName) {
  let retVal = false;
  sgEntry(entryId, listName);
  do {
    if (typeof entryId !== 'string' || entryId === '') {
      sgWarn('bad entryId');
      break;
    }
    if (listName !== null && !SG_LIST_NAMES.includes(listName)) {
      sgWarn('bad list name', listName);
      break;
    }
    if (listName !== null && (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0)) {
      sgWarn('entry without keys');
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
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal);
  return retVal;
}
