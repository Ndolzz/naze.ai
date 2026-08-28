/* =========================================================================
 * NAZE AI — Memory Service (Local Memory Storage)
 * -------------------------------------------------------------------------
 * Modul mandiri untuk menyimpan "memory" (catatan/preferensi/fakta) milik
 * pengguna secara lokal di perangkat, menggunakan IndexedDB.
 *
 * - Tidak memanggil Gemini/Claude/API AI apa pun.
 * - Tidak menyentuh sistem chat, UI, atau provider yang sudah ada.
 * - Diekspos lewat window.NazeMemory agar tidak bentrok dengan variabel
 *   global lain di index.html (mis. stGet/stSet/uid dipakai untuk chat).
 *
 * Skema record memory:
 *   { id, content, category, importance, createdAt, updatedAt }
 *
 * API publik (semua async, mengembalikan Promise):
 *   NazeMemory.saveMemory({ content, category, importance })
 *   NazeMemory.getMemories({ category, sortBy, order })
 *   NazeMemory.updateMemory(id, { content, category, importance })
 *   NazeMemory.deleteMemory(id)
 *   NazeMemory.clearMemories()
 * ========================================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'naze-memory-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'memories';

  /** Buka (atau buat) database IndexedDB khusus memory. */
  function openMemoryDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB tidak tersedia di lingkungan ini.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('importance', 'importance', { unique: false });
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error('Gagal membuka memory-db.'));
    });
  }

  /** Jalankan satu operasi (satu IDBRequest) pada object store memory. */
  function runRequest(mode, makeRequest) {
    return openMemoryDB().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(STORE_NAME);
      let req;
      try {
        req = makeRequest(store);
      } catch (err) {
        reject(err);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Operasi memory-db gagal.'));
    }));
  }

  function genId() {
    return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Simpan memory baru.
   * @param {{content:string, category?:string, importance?:number}} input
   * @returns {Promise<object>} record memory yang tersimpan
   */
  async function saveMemory(input) {
    const { content, category = 'general', importance = 3 } = input || {};
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('content wajib diisi untuk menyimpan memory.');
    }
    const ts = nowIso();
    const memory = {
      id: genId(),
      content: content.trim(),
      category: category || 'general',
      importance: Number.isFinite(importance) ? importance : 3,
      createdAt: ts,
      updatedAt: ts
    };
    await runRequest('readwrite', (store) => store.add(memory));
    return memory;
  }

  /**
   * Ambil semua memory, opsional difilter & diurutkan.
   * @param {{category?:string, sortBy?:'createdAt'|'updatedAt'|'importance', order?:'asc'|'desc'}} [opts]
   * @returns {Promise<object[]>}
   */
  async function getMemories(opts) {
    const { category, sortBy = 'createdAt', order = 'desc' } = opts || {};
    let all = await runRequest('readonly', (store) => store.getAll());
    if (category) {
      all = all.filter((m) => m.category === category);
    }
    all.sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      if (av === bv) return 0;
      return av > bv ? 1 : -1;
    });
    if (order === 'desc') all.reverse();
    return all;
  }

  /**
   * Perbarui memory berdasarkan id (partial update).
   * @param {string} id
   * @param {{content?:string, category?:string, importance?:number}} updates
   * @returns {Promise<object>} record memory setelah diperbarui
   */
  async function updateMemory(id, updates) {
    if (!id) throw new Error('id wajib diisi untuk memperbarui memory.');
    const existing = await runRequest('readonly', (store) => store.get(id));
    if (!existing) throw new Error('Memory dengan id "' + id + '" tidak ditemukan.');

    const patch = updates || {};
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso()
    };
    await runRequest('readwrite', (store) => store.put(merged));
    return merged;
  }

  /**
   * Hapus satu memory berdasarkan id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function deleteMemory(id) {
    if (!id) throw new Error('id wajib diisi untuk menghapus memory.');
    await runRequest('readwrite', (store) => store.delete(id));
    return true;
  }

  /**
   * Hapus seluruh memory yang tersimpan.
   * @returns {Promise<boolean>}
   */
  async function clearMemories() {
    await runRequest('readwrite', (store) => store.clear());
    return true;
  }

  global.NazeMemory = {
    saveMemory,
    getMemories,
    updateMemory,
    deleteMemory,
    clearMemories
  };
})(typeof window !== 'undefined' ? window : globalThis);
