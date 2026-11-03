'use strict';

const OPT_BOOL = ['enabled', 'debug'];
const OPT_TEXT = ['apiKey', 'newChannelCutoff', 'rateSince'];
const OPT_ENUM = { blockMode: ['hide', 'dim'] };
const OPT_NUM = {
  maxPerWeek: [0, 1000],
  minSubscribers: [0, 1e10],
  cacheDays: [0, 365],
  maxUploadPages: [1, 20]
};
const OPT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function optStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

/* ------------------------------------------------------------------------- */
async function optLoad() {
  const fn = 'optLoad';
  sgEntry(fn);
  do {
    let s;
    try {
      s = await chrome.storage.sync.get(SG_DEFAULTS);
    } catch (e) {
      optStatus('Could not load settings: ' + e.message, 'err');
      break;
    }
    OPT_BOOL.forEach((k) => { document.getElementById(k).checked = !!s[k]; });
    OPT_TEXT.forEach((k) => { document.getElementById(k).value = String(s[k] ?? ''); });
    Object.keys(OPT_ENUM).forEach((k) => { document.getElementById(k).value = String(s[k]); });
    Object.keys(OPT_NUM).forEach((k) => { document.getElementById(k).value = String(s[k]); });
  } while (false);
  sgExit(fn);
}

async function optSave() {
  const fn = 'optSave';
  let retVal = false;
  sgEntry(fn);
  do {
    const out = {};
    OPT_BOOL.forEach((k) => { out[k] = document.getElementById(k).checked; });
    OPT_TEXT.forEach((k) => { out[k] = document.getElementById(k).value.trim(); });

    let bad = '';
    for (const k of ['newChannelCutoff', 'rateSince']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(out[k]) || !Number.isFinite(Date.parse(out[k]))) {
        bad = k + ' must be a valid date';
        break;
      }
    }
    if (bad) {
      optStatus(bad, 'err');
      break;
    }
    for (const [k, allowed] of Object.entries(OPT_ENUM)) {
      const v = document.getElementById(k).value;
      if (!allowed.includes(v)) {
        bad = `${k} must be one of ${allowed.join(', ')}`;
        break;
      }
      out[k] = v;
    }
    if (bad) {
      optStatus(bad, 'err');
      break;
    }
    for (const [k, [lo, hi]] of Object.entries(OPT_NUM)) {
      const v = Number(document.getElementById(k).value);
      if (!Number.isFinite(v) || v < lo || v > hi) {
        bad = `${k} must be between ${lo} and ${hi}`;
        break;
      }
      out[k] = v;
    }
    if (bad) {
      optStatus(bad, 'err');
      break;
    }

    try {
      await chrome.storage.sync.set(out);
    } catch (e) {
      optStatus('Save failed: ' + e.message, 'err');
      break;
    }
    optStatus('Saved. Open YouTube tabs update automatically.', 'ok');
    retVal = true;
  } while (false);
  sgExit(fn, retVal);
  return retVal;
}

async function optSend(type, okMsg) {
  const fn = 'optSend';
  sgEntry(fn, type);
  do {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: type });
    } catch (e) {
      optStatus('Failed: ' + e.message, 'err');
      break;
    }
    if (!r || !r.ok) {
      optStatus('Failed: ' + ((r && r.error) || 'no response'), 'err');
      break;
    }
    optStatus(okMsg(r), 'ok');
  } while (false);
  sgExit(fn);
}

/* ------------------------------------------------------------------------- */
/* Lists                                                                      */
/* ------------------------------------------------------------------------- */
function optChannelUrl(id, entry) {
  let retVal = '';
  do {
    if (/^UC[A-Za-z0-9_-]{22}$/.test(id)) {
      retVal = 'https://www.youtube.com/channel/' + id;
      break;
    }
    if (entry.handle && entry.handle.startsWith('@')) {
      retVal = 'https://www.youtube.com/' + encodeURIComponent(entry.handle).replace('%40', '@');
      break;
    }
  } while (false);
  return retVal;
}

function optRenderTable(tableId, countId, listName, list) {
  const fn = 'optRenderTable';
  sgEntry(fn, listName);
  do {
    const table = document.getElementById(tableId);
    const count = document.getElementById(countId);
    table.replaceChildren();
    const ids = Object.keys(list).sort((a, b) => {
      const ta = (list[a].title || list[a].handle || a).toLowerCase();
      const tb = (list[b].title || list[b].handle || b).toLowerCase();
      return ta.localeCompare(tb);
    });
    count.textContent = '(' + ids.length + ')';

    if (ids.length === 0) {
      const tr = table.insertRow();
      const td = tr.insertCell();
      td.className = 'empty';
      td.textContent = 'None yet';
      break;
    }

    for (const id of ids) {
      const e = list[id];
      const tr = table.insertRow();

      const tdName = tr.insertCell();
      const label = e.title || e.handle || id;
      const url = optChannelUrl(id, e);
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        tdName.appendChild(a);
      } else {
        tdName.textContent = label;
      }
      if (e.title && e.handle) {
        tdName.appendChild(document.createTextNode('  ' + e.handle));
      }

      const tdWhen = tr.insertCell();
      tdWhen.className = 'when';
      tdWhen.textContent = new Date(e.addedAt).toLocaleDateString();

      const tdAct = tr.insertCell();
      tdAct.className = 'act';
      const btn = document.createElement('button');
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const ok = await sgSetListMembership(id, null, null);
        optStatus(ok ? `Removed "${label}" from ${listName}.` : 'Remove failed.', ok ? 'ok' : 'err');
      });
      tdAct.appendChild(btn);
    }
  } while (false);
  sgExit(fn);
}

async function optRenderLists() {
  const lists = await sgLoadLists();
  optRenderTable('trustedTable', 'trustedCount', 'trusted', lists.trusted);
  optRenderTable('blockedTable', 'blockedCount', 'blocked', lists.blocked);
}

async function optExport() {
  const fn = 'optExport';
  sgEntry(fn);
  do {
    const lists = await sgLoadLists();
    const payload = { format: 'slop-gauge-lists', version: 1, exportedAt: new Date().toISOString(), lists: lists };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'slop-gauge-lists-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    optStatus('Exported.', 'ok');
  } while (false);
  sgExit(fn);
}

async function optImport(file) {
  const fn = 'optImport';
  sgEntry(fn);
  do {
    if (!file) {
      break;
    }
    if (file.size > OPT_IMPORT_MAX_BYTES) {
      optStatus('Import file is too large.', 'err');
      break;
    }
    let text = '';
    try {
      text = await file.text();
    } catch (e) {
      optStatus('Could not read file: ' + e.message, 'err');
      break;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      optStatus('Not valid JSON.', 'err');
      break;
    }
    if (!parsed || parsed.format !== 'slop-gauge-lists' || !parsed.lists) {
      optStatus('Not a Slop Gauge lists export.', 'err');
      break;
    }
    const incoming = sgValidateLists(parsed.lists);
    const current = await sgLoadLists();
    // Merge: imported entries win; an id moves out of the other list if needed
    let added = 0;
    for (const name of SG_LIST_NAMES) {
      for (const [id, e] of Object.entries(incoming[name])) {
        for (const other of SG_LIST_NAMES) {
          delete current[other][id];
        }
        current[name][id] = e;
        added++;
      }
    }
    const ok = await sgSaveLists(current);
    optStatus(ok ? `Imported ${added} channel(s).` : 'Import failed while saving.', ok ? 'ok' : 'err');
  } while (false);
  sgExit(fn);
}

/* ------------------------------------------------------------------------- */
document.getElementById('save').addEventListener('click', optSave);
document.getElementById('test').addEventListener('click', async () => {
  if (await optSave()) {
    optSend('testKey', () => 'API key works.');
  }
});
document.getElementById('clear').addEventListener('click', () => {
  optSend('clearCache', (r) => `Cleared ${r.removed} cached channel(s). Refresh YouTube tabs.`);
});
document.getElementById('export').addEventListener('click', optExport);
document.getElementById('import').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (ev) => {
  const input = ev.target;
  await optImport(input.files && input.files[0]);
  input.value = '';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SG_LISTS_KEY]) {
    optRenderLists();
  }
});

optLoad();
optRenderLists();
