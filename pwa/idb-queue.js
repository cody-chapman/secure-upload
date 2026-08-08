// Shared between app.js (page context) and service-worker.js (via importScripts).
// Deliberately uses bare globals (indexedDB, fetch) rather than `window.` so it
// works unmodified in both contexts.

const PQ_DB_NAME = 'photoUploadQueue';
const PQ_DB_VERSION = 1;
const PQ_STORE = 'queue';
const PQ_META_STORE = 'meta';

function pqOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PQ_DB_NAME, PQ_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PQ_STORE)) {
        db.createObjectStore(PQ_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(PQ_META_STORE)) {
        db.createObjectStore(PQ_META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function pqRun(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function pqAdd(record) {
  const db = await pqOpenDB();
  return pqRun(db, PQ_STORE, 'readwrite', (s) => s.add(record));
}

async function pqPut(record) {
  const db = await pqOpenDB();
  return pqRun(db, PQ_STORE, 'readwrite', (s) => s.put(record));
}

async function pqDelete(id) {
  const db = await pqOpenDB();
  return pqRun(db, PQ_STORE, 'readwrite', (s) => s.delete(id));
}

async function pqGetAll() {
  const db = await pqOpenDB();
  const all = await pqRun(db, PQ_STORE, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => a.id - b.id);
}

// Settings are mirrored here (in addition to localStorage) because service
// workers cannot read localStorage — this is the only place the SW can find
// the server URL / API key when a background sync fires with no page open.
async function pqSaveSettings(settings) {
  const db = await pqOpenDB();
  return pqRun(db, PQ_META_STORE, 'readwrite', (s) => s.put({ key: 'settings', value: settings }));
}

async function pqGetSettings() {
  const db = await pqOpenDB();
  const rec = await pqRun(db, PQ_META_STORE, 'readonly', (s) => s.get('settings'));
  return rec ? rec.value : null;
}

// Uploads every queued/failed photo, in capture order. `notify(record)` fires
// after every state change so a caller can refresh its UI. Stops the pass
// (without flagging items as failed) the moment a request can't reach the
// network at all, since that almost always means we just went offline.
async function pqFlush(notify) {
  const settings = await pqGetSettings();
  if (!settings || !settings.serverUrl || !settings.apiKey) return;

  const all = await pqGetAll();
  for (const record of all) {
    record.status = 'uploading';
    await pqPut(record);
    if (notify) notify(record);

    try {
      const formData = new FormData();
      formData.append('employeeId', record.employeeId);
      formData.append('photo', record.blob, record.fileName || 'photo.jpg');

      const res = await fetch(`${settings.serverUrl}/api/upload?key=${encodeURIComponent(settings.apiKey)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: formData,
      });

      if (res.ok) {
        await pqDelete(record.id);
        record.status = 'uploaded';
        if (notify) notify(record);
      } else {
        let errMsg = `Server rejected the upload (status ${res.status}).`;
        try {
          const body = await res.json();
          if (body.error) errMsg = body.error;
        } catch {}
        record.status = 'failed';
        record.lastError = errMsg;
        record.attempts = (record.attempts || 0) + 1;
        await pqPut(record);
        if (notify) notify(record);
      }
    } catch (err) {
      record.status = 'queued';
      record.lastError = 'Waiting for a network connection';
      await pqPut(record);
      if (notify) notify(record);
      break; // likely offline — no point trying the rest right now
    }
  }
}
