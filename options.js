'use strict';

function optStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

/* ------------------------------------------------------------------------- */
async function optLoad() {
  sgEntry();
  do {
    let s;
    try {
      s = await chrome.storage.sync.get(SG_DEFAULTS);
    } catch (e) {
      optStatus(sgFormat(SG_TXT_OPT_LOAD_FAILED, e.message), 'err');
      break;
    }
    OPT_BOOL.forEach((k) => { document.getElementById(k).checked = !!s[k]; });
    OPT_TEXT.forEach((k) => { document.getElementById(k).value = String(s[k] ?? ''); });
    Object.keys(OPT_ENUM).forEach((k) => { document.getElementById(k).value = String(s[k]); });
    Object.keys(OPT_NUM).forEach((k) => { document.getElementById(k).value = String(s[k]); });
    sgSetLogLevel(s.logLevel);
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

async function optSave() {
  let retVal = false;
  sgEntry();
  do {
    const out = {};
    OPT_BOOL.forEach((k) => { out[k] = document.getElementById(k).checked; });
    OPT_TEXT.forEach((k) => { out[k] = document.getElementById(k).value.trim(); });

    let bad = '';
    for (const k of OPT_DATES) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(out[k]) || !Number.isFinite(Date.parse(out[k]))) {
        bad = sgFormat(SG_TXT_OPT_BAD_DATE, k);
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
        bad = sgFormat(SG_TXT_OPT_BAD_ENUM, k, allowed.join(SG_TXT_OPT_ENUM_SEPARATOR));
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
        bad = sgFormat(SG_TXT_OPT_BAD_RANGE, k, lo, hi);
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
      optStatus(sgFormat(SG_TXT_OPT_SAVE_FAILED, e.message), 'err');
      break;
    }
    sgSetLogLevel(out.logLevel);
    optStatus(SG_TXT_OPT_SAVED, 'ok');
    retVal = true;
  }
  while (CONDITION_LADDER_END);
  sgExit(retVal);
  return retVal;
}

async function optSend(type, okMsg) {
  sgEntry(type);
  do {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: type });
    } catch (e) {
      optStatus(sgFormat(SG_TXT_OPT_FAILED, e.message), 'err');
      break;
    }
    if (!r || !r.ok) {
      optStatus(sgFormat(SG_TXT_OPT_FAILED, (r && r.error) || SG_TXT_OPT_NO_RESPONSE), 'err');
      break;
    }
    optStatus(okMsg(r), 'ok');
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

/* ------------------------------------------------------------------------- */
/* Lists                                                                      */
/* ------------------------------------------------------------------------- */
function optChannelUrl(id, entry) {
  let retVal = '';
  do {
    if (/^UC[A-Za-z0-9_-]{22}$/.test(id)) {
      retVal = SG_YT_CHANNEL_URL + id;
      break;
    }
    if (entry.handle && entry.handle.startsWith('@')) {
      retVal = SG_YT_BASE_URL + encodeURIComponent(entry.handle).replace('%40', '@');
      break;
    }
  }
  while (CONDITION_LADDER_END);
  return retVal;
}

function optRenderTable(tableId, countId, listName, list) {
  sgEntry(listName);
  do {
    const table = document.getElementById(tableId);
    const count = document.getElementById(countId);
    table.replaceChildren();
    const ids = Object.keys(list).sort((a, b) => {
      const ta = (list[a].title || list[a].handle || a).toLowerCase();
      const tb = (list[b].title || list[b].handle || b).toLowerCase();
      return ta.localeCompare(tb);
    });
    count.textContent = sgFormat(SG_TXT_OPT_LIST_COUNT, ids.length);

    if (ids.length === 0) {
      const tr = table.insertRow();
      const td = tr.insertCell();
      td.className = 'empty';
      td.textContent = SG_TXT_OPT_LIST_EMPTY;
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
        tdName.appendChild(document.createTextNode(sgFormat(SG_TXT_OPT_LIST_HANDLE, e.handle)));
      }

      const tdWhen = tr.insertCell();
      tdWhen.className = 'when';
      tdWhen.textContent = new Date(e.addedAt).toLocaleDateString();

      const tdAct = tr.insertCell();
      tdAct.className = 'act';
      const btn = document.createElement('button');
      btn.textContent = SG_TXT_OPT_REMOVE;
      btn.addEventListener('click', async () => {
        const ok = await sgSetListMembership(id, null, null);
        optStatus(ok ? sgFormat(SG_TXT_OPT_REMOVED, label, listName) : SG_TXT_OPT_REMOVE_FAILED, ok ? 'ok' : 'err');
      });
      tdAct.appendChild(btn);
    }
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

async function optRenderLists() {
  const lists = await sgLoadLists();
  optRenderTable('trustedTable', 'trustedCount', 'trusted', lists.trusted);
  optRenderTable('blockedTable', 'blockedCount', 'blocked', lists.blocked);
}

async function optExport() {
  sgEntry();
  do {
    const lists = await sgLoadLists();
    const payload = { format: SG_EXPORT_FORMAT, version: SG_EXPORT_VERSION, exportedAt: new Date().toISOString(), lists: lists };
    const blob = new Blob([JSON.stringify(payload, null, SG_EXPORT_JSON_INDENT)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sgFormat(SG_TXT_OPT_EXPORT_FILE_NAME, new Date().toISOString().slice(0, SG_ISO_DATE_LENGTH));
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), SG_EXPORT_URL_REVOKE_MS);
    optStatus(SG_TXT_OPT_EXPORTED, 'ok');
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

async function optImport(file) {
  sgEntry();
  do {
    if (!file) {
      break;
    }
    if (file.size > OPT_IMPORT_MAX_BYTES) {
      optStatus(SG_TXT_OPT_IMPORT_TOO_LARGE, 'err');
      break;
    }
    let text = '';
    try {
      text = await file.text();
    } catch (e) {
      optStatus(sgFormat(SG_TXT_OPT_IMPORT_READ_FAILED, e.message), 'err');
      break;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      optStatus(SG_TXT_OPT_IMPORT_BAD_JSON, 'err');
      break;
    }
    if (!parsed || !SG_IMPORT_FORMATS.includes(parsed.format) || !parsed.lists) {
      optStatus(SG_TXT_OPT_IMPORT_WRONG_FORMAT, 'err');
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
    optStatus(ok ? sgFormat(SG_TXT_OPT_IMPORTED, added) : SG_TXT_OPT_IMPORT_SAVE_FAILED, ok ? 'ok' : 'err');
  }
  while (CONDITION_LADDER_END);
  sgExit();
}

/* ------------------------------------------------------------------------- */
document.getElementById('save').addEventListener('click', optSave);
document.getElementById('test').addEventListener('click', async () => {
  if (await optSave()) {
    optSend('testKey', () => SG_TXT_OPT_KEY_WORKS);
  }
});
document.getElementById('clear').addEventListener('click', () => {
  optSend('clearCache', (r) => sgFormat(SG_TXT_OPT_CACHE_CLEARED, r.removed));
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
