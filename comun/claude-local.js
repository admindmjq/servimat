/* claude-local.js — permite que un artefacto de Claude funcione como página web propia.
   Reemplaza claude.use('db' | 'user' | 'downloads') con el mismo contrato:
   - db: documentos JSON por ruta, consultas where/orderBy/limit y suscripciones en vivo,
     guardados en este navegador (IndexedDB), sincronizados entre pestañas.
   - user: la persona configurada como dueña en este equipo.
   - downloads: descarga directa del archivo.
   Cualquier otra capacidad (por ejemplo «sample», que consulta a Claude) responde null,
   igual que en Claude cuando no está disponible, y la página oculta esa función.
   Configuración opcional antes de cargar este archivo:
     window.CLAUDE_LOCAL = { app: 'comisiones', titulo: 'Simulador de Comisiones',
                             owner: { email: '...', name: '...' }, carpeta: 'Artefactos/...' } */
(function () {
  'use strict';
  const CFG = Object.assign({
    app: (location.pathname.split('/').filter(Boolean)[0] || 'app'),
    titulo: document.title || 'Herramienta',
    owner: { email: 'danielmjqcontacto@quidelxpert.cl', name: 'Daniel Jara' },
    carpeta: '',
  }, window.CLAUDE_LOCAL || {});
  const DB_NAME = 'claude-local-' + CFG.app;
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const fail = (code, message) => Promise.reject({ code, message });

  /* ---------- rutas ---------- */
  function segments(path, want) {
    if (typeof path !== 'string' || !path) throw new TypeError('Ruta vacía');
    const s = path.split('/');
    for (const x of s) {
      if (!SEG.test(x) || x === '.' || x === '..') throw new TypeError(`Segmento no válido «${x}» en ${path}`);
    }
    if (s.length > 16 || path.length > 1000) throw new TypeError('Ruta demasiado larga: ' + path);
    if (want === 'doc' && s.length % 2 !== 0) throw new TypeError(`Un documento necesita un número par de segmentos (${s.length}): ${path}`);
    if (want === 'col' && s.length % 2 !== 1) throw new TypeError(`Una colección necesita un número impar de segmentos (${s.length}): ${path}`);
    return s;
  }
  const parentOf = path => path.slice(0, path.lastIndexOf('/'));
  const lastOf = path => path.slice(path.lastIndexOf('/') + 1);
  const newId = () => { const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(20)); for (const b of r) s += a[b % a.length]; return s; };

  /* ---------- datos en memoria + IndexedDB ---------- */
  const store = new Map();      // ruta -> cuerpo congelado
  const snaps = new Map();      // ruta -> instantánea reutilizada mientras no cambie
  const leases = new Map();
  let idb = null;

  function freeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function openIdb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  const ready = (async () => {
    try {
      idb = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('docs');
        const req = tx.objectStore('docs').openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { store.set(c.key, freeze(c.value)); c.continue(); } else resolve(); };
        req.onerror = () => reject(req.error);
      });
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* opcional */ }
    } catch (e) {
      console.warn('Sin almacenamiento del navegador; los datos durarán solo esta visita.', e);
      idb = null;
    }
  })();

  function persist(path, body) {
    if (!idb) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction('docs', 'readwrite');
      const st = tx.objectStore('docs');
      if (body === null) st.delete(path); else st.put(body, path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  let channel = null;
  try { channel = new BroadcastChannel(DB_NAME); } catch (e) { channel = null; }
  if (channel) channel.onmessage = async e => {
    const { path } = e.data || {};
    if (!path || !idb) return;
    const body = await new Promise(res => { const q = idb.transaction('docs').objectStore('docs').get(path); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
    if (body === undefined) store.delete(path); else store.set(path, freeze(body));
    snaps.delete(path);
    schedule();
  };

  async function write(path, body) {
    await ready;
    if (body === null) store.delete(path); else store.set(path, freeze(body));
    snaps.delete(path);
    schedule();
    try { await persist(path, body); } catch (e) { return fail('unavailable', 'No se pudo guardar en el navegador: ' + (e && e.message)); }
    if (channel) channel.postMessage({ path });
  }

  function snapOf(path) {
    const body = store.get(path);
    const prev = snaps.get(path);
    if (prev && prev._body === body) return prev;
    const s = Object.freeze({ id: lastOf(path), exists: body !== undefined, data: () => body, metadata: META, _body: body });
    snaps.set(path, s);
    return s;
  }

  /* ---------- consultas ---------- */
  const typeRank = v => v === null || v === undefined ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : 4;
  function cmp(a, b) {
    const ra = typeRank(a), rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) return a - b;
    if (ra === 3) return a < b ? -1 : a > b ? 1 : 0;
    if (ra === 1) return (a ? 1 : 0) - (b ? 1 : 0);
    return 0;
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function test(v, op, x) {
    switch (op) {
      case '==': return eq(v, x);
      case '!=': return v !== undefined && !eq(v, x);
      case '<': return v !== undefined && typeRank(v) === typeRank(x) && cmp(v, x) < 0;
      case '<=': return v !== undefined && typeRank(v) === typeRank(x) && cmp(v, x) <= 0;
      case '>': return v !== undefined && typeRank(v) === typeRank(x) && cmp(v, x) > 0;
      case '>=': return v !== undefined && typeRank(v) === typeRank(x) && cmp(v, x) >= 0;
      case 'in': return Array.isArray(x) && x.some(y => eq(v, y));
      case 'not-in': return v !== undefined && Array.isArray(x) && !x.some(y => eq(v, y));
      case 'array-contains': return Array.isArray(v) && v.some(y => eq(y, x));
      default: throw new TypeError('Operador no soportado: ' + op);
    }
  }
  function runQuery(q) {
    const depth = q.col.split('/').length + 1;
    const prefix = q.col + '/';
    let rows = [];
    for (const path of store.keys()) {
      if (!path.startsWith(prefix) || path.split('/').length !== depth) continue;
      const body = store.get(path);
      if (q.filters.every(([f, op, x]) => test(body[f], op, x))) rows.push(path);
    }
    if (q.order) {
      const [f, dir] = q.order;
      rows.sort((a, b) => {
        const va = store.get(a)[f], vb = store.get(b)[f];
        if (va === undefined && vb !== undefined) return 1;
        if (vb === undefined && va !== undefined) return -1;
        return (dir === 'desc' ? -1 : 1) * cmp(va, vb) || (a < b ? -1 : 1);
      });
    } else rows.sort();
    if (q.lim) rows = rows.slice(0, q.lim);
    return rows.map(snapOf);
  }
  function querySnap(docs, prev) {
    const changes = [];
    const before = prev || [];
    const oldIdx = new Map(before.map((d, i) => [d.id, i]));
    const newIdx = new Map(docs.map((d, i) => [d.id, i]));
    for (const [id, i] of oldIdx) if (!newIdx.has(id)) changes.push({ type: 'removed', doc: before[i], oldIndex: i, newIndex: -1 });
    docs.forEach((d, i) => {
      if (!oldIdx.has(d.id)) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
      else if (before[oldIdx.get(d.id)] !== d || oldIdx.get(d.id) !== i) changes.push({ type: 'modified', doc: d, oldIndex: oldIdx.get(d.id), newIndex: i });
    });
    return Object.freeze({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: META });
  }

  /* ---------- suscripciones ---------- */
  const subs = new Set();
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; for (const s of [...subs]) deliver(s); });
  }
  function deliver(s) {
    if (!subs.has(s)) return;
    try {
      if (s.kind === 'doc') {
        const snap = snapOf(s.path);
        if (snap !== s.last) { s.last = snap; s.next(snap); }
      } else {
        const docs = runQuery(s.q);
        const same = s.last && s.last.length === docs.length && docs.every((d, i) => d === s.last[i]);
        if (!same) { const qs = querySnap(docs, s.last); s.last = docs; s.next(qs); }
      }
    } catch (e) { console.error(e); }
  }
  function subscribe(sub) {
    if (subs.size >= 64) { setTimeout(() => sub.error && sub.error({ code: 'resource_exhausted', message: 'Demasiadas suscripciones' })); return () => {}; }
    subs.add(sub);
    ready.then(() => deliver(sub));
    return () => subs.delete(sub);
  }

  /* ---------- referencias ---------- */
  function checkBody(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'El documento debe ser un objeto';
    const txt = JSON.stringify(data);
    if (txt.length > 262144) return 'El documento supera 256 KiB';
    return '';
  }
  function merge(base, add) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(add)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : v;
    }
    return out;
  }
  function docRef(path) {
    segments(path, 'doc');
    return {
      id: lastOf(path), path,
      async get() { await ready; return snapOf(path); },
      async set(data) { const bad = checkBody(data); if (bad) return fail('invalid_argument', bad); return write(path, clone(data)); },
      async update(data) {
        await ready;
        const bad = checkBody(data); if (bad) return fail('invalid_argument', bad);
        const cur = store.get(path);
        if (cur === undefined) return fail('invalid_argument', 'update() necesita que el documento exista: ' + path);
        return write(path, merge(clone(cur), clone(data)));
      },
      async delete() { return write(path, null); },
      async acquire(opt = {}) {
        await ready;
        const now = Date.now(), ttl = Math.min(600000, Math.max(1000, opt.ttlMs || 30000));
        const l = leases.get(path);
        if (l && l.until > now && l.holder !== opt.holder) return { acquired: false, expiresAt: new Date(l.until).toISOString() };
        leases.set(path, { holder: opt.holder, until: now + ttl });
        if (opt.data) await write(path, merge(clone(store.get(path) || {}), clone(opt.data)));
        return { acquired: true, version: 1, expiresAt: new Date(now + ttl).toISOString(), holder: opt.holder };
      },
      onSnapshot(next, error) { return subscribe({ kind: 'doc', path, next, error }); },
      collection(sub) { return colRef(path + '/' + sub); },
    };
  }
  function query(col, filters, order, lim) {
    return {
      where(f, op, x) { if (filters.length >= 10) throw new TypeError('Máximo 10 filtros'); test(undefined, op, op === 'in' || op === 'not-in' ? [] : x); return query(col, [...filters, [f, op, x]], order, lim); },
      orderBy(f, dir) { return query(col, filters, [f, dir === 'desc' ? 'desc' : 'asc'], lim); },
      limit(n) { return query(col, filters, order, Math.max(1, Math.min(1000, n | 0))); },
      async get() { await ready; return querySnap(runQuery({ col, filters, order, lim })); },
      onSnapshot(next, error) { return subscribe({ kind: 'query', q: { col, filters, order, lim }, next, error }); },
    };
  }
  function colRef(path) {
    segments(path, 'col');
    const q = query(path, [], null, 0);
    return Object.assign(q, {
      path,
      doc(id) { return docRef(path + '/' + (id === undefined ? newId() : id)); },
      async add(data) { const r = docRef(path + '/' + newId()); await r.set(data); return r; },
    });
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  /* ---------- usuario y descargas ---------- */
  const OWNER = { email: CFG.owner.email, name: CFG.owner.name };
  const ME = Object.freeze({ id: OWNER.email, name: OWNER.name, avatarUrl: '', color: '#23e5ff', email: OWNER.email, isOwner: true, canEdit: true });
  const PROFILE = Object.freeze({ id: OWNER.email, name: OWNER.name, avatarUrl: '', color: '#23e5ff', email: OWNER.email, isMe: true, guest: false });
  const user = Object.freeze({
    isOwner: async () => true, canEdit: async () => true, can: async () => true,
    me: async () => ME, id: async () => ME.id, name: async () => ME.name, avatarUrl: async () => null, email: async () => ME.email,
    profiles: async ids => { const out = {}; for (const id of [].concat(ids)) out[id] = id === ME.id ? PROFILE : Object.freeze({ id, name: '', avatarUrl: '', color: '#9097c4', email: null, isMe: false, guest: false }); return out; },
    search: async q => (!q || (ME.name + ' ' + ME.email).toLowerCase().includes(String(q).toLowerCase())) ? [PROFILE] : [],
  });
  const downloads = Object.freeze({
    async save({ filename, data }) {
      if (!filename || data === undefined || data === null) return fail('bad_request', 'Falta el nombre o el contenido');
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    },
  });

  const caps = { db, user, downloads };
  const claude = Object.freeze({ use: async name => (Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : null) });
  Object.defineProperty(window, 'claude', { value: claude, writable: false, configurable: false });

  /* ---------- panel «Datos»: respaldo e importación ---------- */
  function stamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  async function exportAll() {
    await ready;
    const docs = {};
    for (const [k, v] of [...store.entries()].sort()) docs[k] = v;
    const body = JSON.stringify({ tipo: 'claude-local-respaldo', version: 1, app: CFG.app, titulo: CFG.titulo, creado: new Date().toISOString(), docs });
    await downloads.save({ filename: `Respaldo ${CFG.titulo} ${stamp()}.json`, data: new Blob([body], { type: 'application/json' }) });
    return Object.keys(docs).length;
  }
  async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('el archivo no es un respaldo válido'); }
    if (!data || data.tipo !== 'claude-local-respaldo' || !data.docs || typeof data.docs !== 'object') throw new Error('el archivo no es un respaldo de una herramienta');
    if (data.app && data.app !== CFG.app) throw new Error(`este respaldo es de «${data.titulo || data.app}», no de esta herramienta`);
    let n = 0;
    for (const [path, body] of Object.entries(data.docs)) {
      try { segments(path, 'doc'); } catch (e) { continue; }
      if (checkBody(body)) continue;
      await write(path, clone(body));
      n++;
    }
    return n;
  }
  function buildPanel() {
    if (document.getElementById('cl-datos')) return;
    const css = document.createElement('style');
    css.textContent = `
#cl-datos-btn{position:fixed;left:max(12px,env(safe-area-inset-left,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;font:600 12px/1 system-ui,sans-serif;padding:7px 10px;border-radius:999px;border:1px solid rgba(35,229,255,.55);background:rgba(7,7,15,.88);color:#cfefff;cursor:pointer;box-shadow:0 0 12px rgba(35,229,255,.25)}
#cl-datos-btn:focus-visible,#cl-datos button:focus-visible{outline:2px solid #23e5ff;outline-offset:2px}
#cl-datos{position:fixed;left:max(12px,env(safe-area-inset-left,0px));bottom:calc(52px + env(safe-area-inset-bottom,0px));z-index:2147483001;width:min(360px,calc(100vw - 24px));padding:14px;border-radius:10px;border:1px solid #262a52;background:#10111f;color:#eceeff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);display:grid;gap:10px}
#cl-datos h2{margin:0;font-size:15px}
#cl-datos p{margin:0;color:#9097c4;font-size:13px}
#cl-datos .row{display:flex;flex-wrap:wrap;gap:6px}
#cl-datos button{font:600 13px system-ui,sans-serif;padding:7px 10px;border-radius:6px;border:1px solid #262a52;background:#0a0b17;color:#eceeff;cursor:pointer}
#cl-datos button.p{background:#23e5ff;color:#031015;border-color:#23e5ff}
#cl-datos .msg{color:#3dff9e;font-size:13px;min-height:1em}
#cl-datos .msg.bad{color:#ffd24a}`;
    document.head.appendChild(css);
    const btn = document.createElement('button');
    btn.id = 'cl-datos-btn'; btn.type = 'button'; btn.textContent = 'Datos';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'cl-datos');
    const box = document.createElement('section');
    box.id = 'cl-datos'; box.hidden = true; box.setAttribute('aria-label', 'Datos de esta herramienta');
    const carpeta = CFG.carpeta ? ` Guarda cada respaldo en tu carpeta <b>${CFG.carpeta.replace(/[<>&]/g, '')}</b> de OneDrive.` : '';
    box.innerHTML = `<h2>Datos de ${CFG.titulo.replace(/[<>&]/g, '')}</h2>
<p>Se guardan en este navegador, en este PC.${carpeta}</p>
<div class="row"><button type="button" class="p" data-a="out">Exportar respaldo</button><button type="button" data-a="in">Importar respaldo</button></div>
<p class="msg" role="status"></p>
<input type="file" accept=".json,application/json" hidden>`;
    const msg = box.querySelector('.msg'), input = box.querySelector('input');
    const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', Boolean(bad)); };
    /* Se escucha en la ventana y en fase de captura: así la página no puede quedarse con estos eventos. */
    window.addEventListener('click', async e => {
      if (e.target === btn) { e.stopPropagation(); box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); say(''); return; }
      const a = e.target.closest && e.target.closest('#cl-datos button[data-a]'); if (!a) return;
      e.stopPropagation();
      if (a.dataset.a === 'in') { input.click(); return; }
      try { const n = await exportAll(); say(`Respaldo listo: ${n} registros.`); } catch (err) { say('No se pudo exportar: ' + (err.message || err.code), true); }
    }, true);
    window.addEventListener('change', async e => {
      if (e.target !== input) return;
      e.stopPropagation();
      const f = input.files[0]; input.value = ''; if (!f) return;
      say('Importando…');
      try { const n = await importFile(f); say(`Importados ${n} registros. Recarga la página si algo no aparece.`); }
      catch (err) { say('No se pudo importar: ' + err.message + '.', true); }
    }, true);
    document.body.append(btn, box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel); else buildPanel();

  window.ClaudeLocal = Object.freeze({ ready, exportAll, importFile, config: CFG });
})();
