/* Separador de Anexos — almacenamiento local.
   Guarda la base de trabajadores y las marcas Ok en IndexedDB, solo en este navegador.
   Imita la forma mínima que usa la página: collection(c).doc(id).set/delete y collection(c).onSnapshot. */
(function () {
  const DB_NAME = 'separador-anexos';
  let opening = null;
  const subs = new Map();      // colección -> Set(funciones)
  const pending = new Map();   // colección -> temporizador para agrupar avisos
  let channel = null;
  try { channel = new BroadcastChannel('separador-anexos'); } catch (e) { channel = null; }

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const docs = db.createObjectStore('docs', { keyPath: 'path' });
          docs.createIndex('coll', 'coll');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('El almacenamiento está bloqueado por otra pestaña.'));
      });
    }
    return opening;
  }

  async function readColl(coll) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const q = db.transaction('docs').objectStore('docs').index('coll').getAll(coll);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }

  async function emitNow(coll) {
    const set = subs.get(coll);
    if (!set || !set.size) return;
    const rows = await readColl(coll);
    const snap = {
      docs: rows.map(r => ({ id: r.id, data: () => r.data })),
      size: rows.length, empty: !rows.length,
      metadata: { fromCache: false, hasPendingWrites: false },
    };
    set.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }

  function emit(coll) {
    clearTimeout(pending.get(coll));
    pending.set(coll, setTimeout(() => { pending.delete(coll); emitNow(coll).catch(e => console.error(e)); }, 40));
  }

  async function write(op, coll, id, data) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('docs', 'readwrite');
      const st = tx.objectStore('docs');
      if (op === 'set') st.put({ path: coll + '/' + id, coll, id, data });
      else st.delete(coll + '/' + id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se pudo guardar en el navegador.'));
    });
    emit(coll);
    if (channel) channel.postMessage(coll);
  }

  if (channel) channel.onmessage = e => { if (typeof e.data === 'string') emit(e.data); };

  const api = {
    collection(coll) {
      return {
        doc(id) {
          return {
            set: data => write('set', coll, id, JSON.parse(JSON.stringify(data))),
            delete: () => write('delete', coll, id),
          };
        },
        onSnapshot(next, onError) {
          if (!subs.has(coll)) subs.set(coll, new Set());
          subs.get(coll).add(next);
          emitNow(coll).catch(e => { if (onError) onError(e); });
          return () => subs.get(coll).delete(next);
        },
      };
    },
  };

  window.LocalDB = {
    async open() {
      await open();
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }
      return api;
    },
  };
})();
