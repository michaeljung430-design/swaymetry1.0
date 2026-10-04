// Raw per-frame trial data (every landmark, every frame, every phone sample)
// is too large for localStorage, so it lives in IndexedDB, keyed by
// trial_id. This is intentionally separate from assessment-current /
// assessment-history in localStorage, which hold only the aggregated,
// already-calculated metrics.
(function (global) {
  const DB_NAME = 'motion-lab-raw';
  const DB_VERSION = 2;
  const STORE = 'trials';
  const ASSESSMENTS = 'assessments';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable in this context.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'trial_id' });
        if (!req.result.objectStoreNames.contains(ASSESSMENTS)) req.result.createObjectStore(ASSESSMENTS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveRawTrial(trialId, data) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ trial_id: trialId, saved_at: new Date().toISOString(), ...data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadRawTrial(trialId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(trialId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function listRawTrialIds() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRawTrial(trialId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(trialId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveAssessmentFolder(folder) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ASSESSMENTS, 'readwrite');
      tx.objectStore(ASSESSMENTS).put(folder);
      tx.oncomplete = () => resolve(folder);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function listAssessmentFolders() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ASSESSMENTS, 'readonly');
      const req = tx.objectStore(ASSESSMENTS).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.saved_at.localeCompare(a.saved_at)));
      req.onerror = () => reject(req.error);
    });
  }

  global.RawStore = { saveRawTrial, loadRawTrial, listRawTrialIds, deleteRawTrial, saveAssessmentFolder, listAssessmentFolders };
})(typeof window !== 'undefined' ? window : globalThis);
