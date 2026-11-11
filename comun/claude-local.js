/* claude-local.js — permite que un artefacto de Claude funcione como página web propia.
   Reemplaza claude.use('db' | 'user' | 'downloads') con el mismo contrato:
   - db: documentos JSON por ruta, consultas where/orderBy/limit y suscripciones en vivo,
     guardados en este navegador (IndexedDB), sincronizados entre pestañas.
   - user: la persona configurada como dueña en este equipo.
   - downloads: descarga directa del archivo.
   Cualquier otra capacidad (por ejemplo «sample», que consulta a Claude) responde null,
   igual que en Claude cuando no está disponible, y la página oculta esa función.
   Con «carpeta» configurada, además sincroniza con OneDrive (Artefactos/<herramienta>/datos.json).
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

  /* meta: cuándo cambió cada documento (mt), borrados recientes (tomb) y estado de OneDrive */
  let meta = { mt: {}, tomb: {}, etag: null, dirty: false, last: 0 };
  let writeSeq = 0;

  function openIdb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  const idbGet = (st, key) => new Promise(res => { try { const q = idb.transaction(st).objectStore(st).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch (e) { res(undefined); } });
  const ready = (async () => {
    try {
      idb = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('docs');
        const req = tx.objectStore('docs').openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { store.set(c.key, freeze(c.value)); c.continue(); } else resolve(); };
        req.onerror = () => reject(req.error);
      });
      const m = await idbGet('meta', 'sync');
      if (m && typeof m === 'object') meta = Object.assign(meta, m);
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
  function saveMeta() {
    if (!idb) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = idb.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(clone(meta), 'sync');
        tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
      } catch (e) { resolve(); }
    });
  }

  let channel = null;
  try { channel = new BroadcastChannel(DB_NAME); } catch (e) { channel = null; }
  if (channel) channel.onmessage = async e => {
    const { path, t, del } = e.data || {};
    if (!path || !idb) return;
    const body = await idbGet('docs', path);
    if (body === undefined) store.delete(path); else store.set(path, freeze(body));
    if (t) { if (del) { delete meta.mt[path]; meta.tomb[path] = t; } else { meta.mt[path] = t; delete meta.tomb[path]; } }
    snaps.delete(path);
    schedule();
  };

  /* Escritura sin marcar cambios: la usa la sincronización al traer datos de OneDrive. */
  async function rawWrite(path, body, t, del) {
    if (body === null) store.delete(path); else store.set(path, freeze(body));
    snaps.delete(path);
    schedule();
    try { await persist(path, body); } catch (e) { return fail('unavailable', 'No se pudo guardar en el navegador: ' + (e && e.message)); }
    if (channel) channel.postMessage({ path, t, del });
  }
  /* Escritura de la página: queda marcada para subirla a OneDrive. */
  async function write(path, body) {
    await ready;
    const t = Date.now();
    if (body === null) { delete meta.mt[path]; meta.tomb[path] = t; } else { meta.mt[path] = t; delete meta.tomb[path]; }
    meta.dirty = true; writeSeq++;
    const r = await rawWrite(path, body, t, body === null);
    saveMeta();
    if (typeof onLocalChange === 'function') onLocalChange();
    return r;
  }
  let onLocalChange = null;

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

  /* ---------- OneDrive: Artefactos/<herramienta>/datos.json ----------
     Inicio de sesión con la app «Herramientas QuidelXpert» de Microsoft Entra (código + PKCE, sin secretos).
     La sesión se comparte entre todas las herramientas de este sitio. Cada cambio se guarda primero en el
     navegador y luego se sube; al abrir, y cada minuto, se traen los cambios hechos en otro PC.
     Cuando un documento cambió en los dos lados gana el cambio más reciente. */
  const MS = {
    client: 'b43ae4f1-145f-4fa4-b66d-03580ea73a16',
    tenant: 'c8c02677-16b4-4866-8a15-421e560b8150',
    scope: 'openid profile offline_access User.Read Files.ReadWrite.All',
    redirect: location.origin + '/comun/redirect.html',
  };
  const LOGIN = `https://login.microsoftonline.com/${MS.tenant}/oauth2/v2.0`;
  const TK = 'cl-ms-token';
  const OD_ON = Boolean(CFG.carpeta) && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  const FILE_PATH = (CFG.carpeta || '') + '/datos.json';
  const ITEM = '/me/drive/root:/' + FILE_PATH.split('/').filter(Boolean).map(encodeURIComponent).join('/');

  const odState = { state: 'off', text: '', account: null };
  const odListeners = new Set();
  function odSet(state, text) { odState.state = state; odState.text = text || ''; odListeners.forEach(f => { try { f(odState); } catch (e) { console.error(e); } }); }

  function loadTok() { try { return JSON.parse(localStorage.getItem(TK)) || null; } catch (e) { return null; } }
  function saveTok(t) { try { if (t) localStorage.setItem(TK, JSON.stringify(t)); else localStorage.removeItem(TK); } catch (e) { /* opcional */ } }
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function pkce() {
    const v = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const c = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    return { v, c };
  }
  function authUrl(state, challenge, silent, hint) {
    const p = new URLSearchParams({ client_id: MS.client, response_type: 'code', redirect_uri: MS.redirect, scope: MS.scope, state, code_challenge: challenge, code_challenge_method: 'S256', response_mode: 'query', prompt: silent ? 'none' : 'select_account' });
    if (hint) p.set('login_hint', hint);
    return LOGIN + '/authorize?' + p;
  }
  /* La página de retorno avisa por BroadcastChannel (y localStorage de respaldo): funciona aunque Microsoft corte el vínculo con la ventana. */
  function waitAuth(state, ms) {
    return new Promise((resolve, reject) => {
      let bc = null, timer = 0;
      const finish = href => {
        let u; try { u = new URL(href); } catch (e) { return; }
        if (u.searchParams.get('state') !== state) return;
        cleanup();
        const err = u.searchParams.get('error');
        if (err) reject({ code: err, message: u.searchParams.get('error_description') || err });
        else resolve(u.searchParams.get('code'));
      };
      const onStorage = e => { if (e.key === 'cl-ms-auth') { try { finish(JSON.parse(e.newValue).url); } catch (x) { /* ignorar */ } } };
      const cleanup = () => { clearTimeout(timer); if (bc) bc.close(); window.removeEventListener('storage', onStorage); };
      try { bc = new BroadcastChannel('cl-ms-auth'); bc.onmessage = e => e.data && finish(e.data.url); } catch (e) { bc = null; }
      window.addEventListener('storage', onStorage);
      timer = setTimeout(() => { cleanup(); reject({ code: 'timeout', message: 'No llegó la respuesta de Microsoft.' }); }, ms);
    });
  }
  async function tokenReq(params) {
    const r = await fetch(LOGIN + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.assign({ client_id: MS.client, scope: MS.scope }, params)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.error || 'token_error', message: j.error_description || ('HTTP ' + r.status) };
    return j;
  }
  function keepTok(j, prev) {
    const t = { access: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000, refresh: j.refresh_token || (prev && prev.refresh) || '', account: (prev && prev.account) || null };
    saveTok(t);
    return t;
  }
  async function codeToTok(code, verifier, prev) { return keepTok(await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: MS.redirect, code_verifier: verifier }), prev); }

  async function silentLogin(prev) {
    const st = newId(), { v, c } = await pkce();
    const f = document.createElement('iframe');
    f.hidden = true; f.setAttribute('aria-hidden', 'true'); f.title = 'Microsoft';
    f.src = authUrl(st, c, true, prev && prev.account && prev.account.email);
    document.body.appendChild(f);
    try { return await codeToTok(await waitAuth(st, 12000), v, prev); } finally { f.remove(); }
  }
  let refreshing = null;
  async function getToken() {
    let t = loadTok();
    if (!t) throw { code: 'interaction_required', message: 'Sin sesión de Microsoft' };
    if (t.access && t.exp > Date.now()) return t.access;
    if (!refreshing) refreshing = (async () => {
      if (t.refresh) { try { return await keepTok(await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh }), t); } catch (e) { console.warn('Microsoft: renovación', e); } }
      try { return await silentLogin(t); } catch (e) { throw { code: 'interaction_required', message: 'La sesión de Microsoft venció' }; }
    })().finally(() => { refreshing = null; });
    t = await refreshing;
    return t.access;
  }
  async function graph(path, opt = {}, again = true) {
    const tok = await getToken();
    const r = await fetch('https://graph.microsoft.com/v1.0' + path, Object.assign({}, opt, { headers: Object.assign({}, opt.headers || {}, { Authorization: 'Bearer ' + tok }) }));
    if (r.status === 401 && again) { const t = loadTok(); if (t) { t.exp = 0; saveTok(t); } return graph(path, opt, false); }
    return r;
  }
  async function httpErr(r) {
    let m = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j && j.error) m = j.error.message || j.error.code || m; } catch (e) { /* sin cuerpo */ }
    return { code: r.status === 403 ? 'permission_denied' : r.status === 429 ? 'rate_limited' : 'http_' + r.status, message: m };
  }

  /* Conectar: se abre la ventana en el mismo clic (si no, el navegador la bloquea). */
  async function odConnect() {
    const w = window.open('about:blank', 'cl-ms-login', 'width=520,height=680');
    if (!w) { odSet('error', 'El navegador bloqueó la ventana de Microsoft. Permite las ventanas emergentes de este sitio y vuelve a intentarlo.'); return; }
    odSet('sync', 'Esperando el inicio de sesión de Microsoft…');
    try {
      const st = newId(), { v, c } = await pkce();
      w.location.href = authUrl(st, c, false);
      const prev = loadTok();
      const t = await codeToTok(await waitAuth(st, 5 * 60000), v, prev);
      try { w.close(); } catch (e) { /* ya cerrada */ }
      const r = await graph('/me?$select=displayName,mail,userPrincipalName');
      if (r.ok) { const me = await r.json(); t.account = { name: me.displayName || '', email: me.mail || me.userPrincipalName || '' }; saveTok(Object.assign(loadTok() || t, { account: t.account })); }
      odState.account = t.account;
      await odSync();
      odStartPolling();
    } catch (e) {
      try { w.close(); } catch (x) { /* ya cerrada */ }
      odSet(loadTok() ? 'error' : 'off', 'No se conectó: ' + (e.message || e.code || e) + '.');
    }
  }
  function odDisconnect() {
    saveTok(null); odState.account = null; clearInterval(pollTimer); pollTimer = 0;
    odSet('off', 'Desconectado de OneDrive en todas las herramientas de este navegador. Los datos siguen aquí.');
  }

  function fileBody() {
    const docs = {}, mt = {}, tomb = {};
    const old = Date.now() - 120 * 86400000;
    for (const [k, v] of [...store.entries()].sort()) { docs[k] = v; if (meta.mt[k]) mt[k] = meta.mt[k]; }
    for (const [k, t] of Object.entries(meta.tomb)) if (t > old && !store.has(k)) tomb[k] = t;
    return { tipo: 'claude-local-respaldo', version: 1, app: CFG.app, titulo: CFG.titulo, creado: new Date().toISOString(), docs, sync: { mt, tomb } };
  }
  /* Une lo de OneDrive con lo local, documento por documento; en empate gana OneDrive. */
  function mergeRemote(rd) {
    const rdocs = (rd && rd.docs && typeof rd.docs === 'object') ? rd.docs : {};
    const rmt = (rd && rd.sync && rd.sync.mt) || {}, rtomb = (rd && rd.sync && rd.sync.tomb) || {};
    const paths = new Set([...store.keys(), ...Object.keys(meta.tomb), ...Object.keys(rdocs), ...Object.keys(rtomb)]);
    const changes = []; let localWins = false;
    for (const p of paths) {
      try { segments(p, 'doc'); } catch (e) { continue; }
      const has = store.has(p), rhas = Object.prototype.hasOwnProperty.call(rdocs, p);
      const lt = has ? (meta.mt[p] || 0) : (meta.tomb[p] !== undefined ? meta.tomb[p] : -1);
      const rt = rhas ? (Number(rmt[p]) || 0) : (rtomb[p] !== undefined ? Number(rtomb[p]) : -1);
      const lb = has ? store.get(p) : null, rb = rhas ? rdocs[p] : null;
      if (rb !== null && checkBody(rb)) { if (has) localWins = true; continue; }
      if (JSON.stringify(lb) === JSON.stringify(rb)) {
        const t = Math.max(lt, rt);
        if (has && t > 0) meta.mt[p] = t;
        if (!has && t > 0) meta.tomb[p] = t;
        continue;
      }
      if (rt >= lt) {
        changes.push([p, rb === null ? null : clone(rb), rt, rb === null]);
        if (rb === null) { delete meta.mt[p]; if (rt > 0) meta.tomb[p] = rt; } else { if (rt > 0) meta.mt[p] = rt; else delete meta.mt[p]; delete meta.tomb[p]; }
      } else localWins = true;
    }
    return { changes, localWins };
  }
  async function pull() {
    const r = await graph(ITEM);
    if (r.status === 404) return { exists: false };
    if (!r.ok) throw await httpErr(r);
    const it = await r.json();
    if (it.eTag && it.eTag === meta.etag) return { exists: true, same: true };
    const dl = it['@microsoft.graph.downloadUrl'];
    const c = dl ? await fetch(dl) : await graph(ITEM + ':/content');
    if (!c.ok) throw await httpErr(c);
    let data;
    try { data = JSON.parse(await c.text()); } catch (e) { throw { code: 'bad_file', message: `${FILE_PATH} en OneDrive no es un respaldo válido` }; }
    if (!data || data.tipo !== 'claude-local-respaldo') throw { code: 'bad_file', message: `${FILE_PATH} en OneDrive no es un respaldo de una herramienta` };
    if (data.app && data.app !== CFG.app) throw { code: 'bad_file', message: `${FILE_PATH} en OneDrive es de «${data.titulo || data.app}»` };
    return { exists: true, etag: it.eTag, data };
  }
  async function push() {
    const seq = writeSeq;
    const h = { 'Content-Type': 'application/json' };
    if (meta.etag) h['If-Match'] = meta.etag;
    const url = ITEM + ':/content' + (meta.etag ? '' : '?@microsoft.graph.conflictBehavior=fail');
    const r = await graph(url, { method: 'PUT', headers: h, body: JSON.stringify(fileBody()) });
    if (r.status === 412 || r.status === 409) return 'conflict';
    if (!r.ok) throw await httpErr(r);
    const it = await r.json();
    meta.etag = it.eTag || null;
    meta.dirty = writeSeq !== seq;
    return meta.dirty ? 'again' : 'ok';
  }
  let syncing = null, again = false;
  function odSync() {
    if (!OD_ON || !loadTok()) return Promise.resolve();
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      try {
        let rounds = 0;
        do {
          again = false;
          odSet('sync', 'Sincronizando con OneDrive…');
          const p = await pull();
          if (p.data) {
            const seq = writeSeq;
            const { changes, localWins } = mergeRemote(p.data);
            for (const [path, body, t, del] of changes) await rawWrite(path, body, t, del);
            meta.etag = p.etag || null;
            meta.dirty = localWins || writeSeq !== seq;
          } else if (!p.exists) {
            meta.etag = null;
            meta.dirty = store.size > 0 || Object.keys(meta.tomb).length > 0;
          }
          if (meta.dirty) { const res = await push(); if (res !== 'ok') again = true; }
          await saveMeta();
        } while (again && ++rounds < 5);
        meta.last = Date.now(); await saveMeta();
        const hh = new Date(meta.last).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
        odSet('ok', `Guardado en OneDrive (${FILE_PATH}) · ${hh}`);
      } catch (e) {
        console.warn('OneDrive', e);
        if (e && e.code === 'interaction_required') { clearInterval(pollTimer); pollTimer = 0; odSet('reauth', 'La sesión de Microsoft venció. Presiona «Conectar OneDrive»; mientras tanto todo se guarda aquí y se subirá después.'); }
        else if (e && e.code === 'permission_denied') odSet('error', 'Microsoft no dio permiso para guardar en OneDrive. Revisa los permisos de la app (Files.ReadWrite.All).');
        else odSet('error', 'No se pudo sincronizar: ' + ((e && (e.message || e.code)) || e) + '. Se reintentará.');
      } finally { syncing = null; }
    })();
    return syncing;
  }
  let pushTimer = 0, pollTimer = 0;
  onLocalChange = () => {
    if (!OD_ON || !loadTok() || odState.state === 'reauth') return;
    if (odState.state !== 'sync') odSet('pend', 'Cambios por subir a OneDrive…');
    clearTimeout(pushTimer); pushTimer = setTimeout(odSync, 3000);
  };
  function odStartPolling() {
    if (pollTimer || !OD_ON) return;
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine !== false) odSync(); }, 60000);
  }
  if (OD_ON) {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && loadTok() && odState.state !== 'reauth') odSync(); });
    window.addEventListener('online', () => { if (loadTok() && odState.state !== 'reauth') odSync(); });
    ready.then(() => {
      const t = loadTok();
      if (!t) { odSet('off', ''); return; }
      odState.account = t.account || null;
      odSync(); odStartPolling();
    });
  }

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
#cl-datos .msg.bad{color:#ffd24a}
#cl-datos .od{display:grid;gap:8px;padding:10px;border:1px solid #262a52;border-radius:8px;background:#0a0b17}
#cl-datos .od p.s{color:#cfd3f5}
#cl-datos .od[data-s=ok] p.s{color:#3dff9e}
#cl-datos .od[data-s=reauth] p.s,#cl-datos .od[data-s=error] p.s{color:#ffd24a}
#cl-datos-btn .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px;background:#5a5f8c}
#cl-datos-btn[data-s=ok] .dot{background:#3dff9e}
#cl-datos-btn[data-s=sync] .dot,#cl-datos-btn[data-s=pend] .dot{background:#23e5ff}
#cl-datos-btn[data-s=reauth] .dot,#cl-datos-btn[data-s=error] .dot{background:#ffd24a}`;
    document.head.appendChild(css);
    const esc = s => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const btn = document.createElement('button');
    btn.id = 'cl-datos-btn'; btn.type = 'button'; btn.innerHTML = '<span class="dot" aria-hidden="true"></span>Datos';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'cl-datos');
    const box = document.createElement('section');
    box.id = 'cl-datos'; box.hidden = true; box.setAttribute('aria-label', 'Datos de esta herramienta');
    const od = OD_ON ? `<div class="od" data-s="off"><p class="s" role="status"></p><p class="acc"></p>
<div class="row"><button type="button" class="p" data-a="od-con">Conectar OneDrive</button><button type="button" data-a="od-sync">Sincronizar ahora</button><button type="button" data-a="od-off">Desconectar</button></div></div>` : '';
    box.innerHTML = `<h2>Datos de ${esc(CFG.titulo)}</h2>
<p>Todo se guarda al instante en este navegador.${OD_ON ? ` Con OneDrive conectado, además queda en <b>${esc(FILE_PATH)}</b> y lo ves desde cualquier PC.` : ''}</p>
${od}
<div class="row"><button type="button" data-a="out">Exportar respaldo</button><button type="button" data-a="in">Importar respaldo</button></div>
<p class="msg" role="status"></p>
<input type="file" accept=".json,application/json" hidden>`;
    const msg = box.querySelector('.msg'), input = box.querySelector('input');
    const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', Boolean(bad)); };
    const odBox = box.querySelector('.od');
    const paint = s => {
      btn.dataset.s = OD_ON ? s.state : 'off';
      if (!odBox) return;
      odBox.dataset.s = s.state;
      const on = Boolean(loadTok());
      odBox.querySelector('p.s').textContent = s.text || (on ? 'Conectado a OneDrive.' : 'OneDrive sin conectar: los datos quedan solo en este PC.');
      const acc = s.account || (loadTok() || {}).account;
      odBox.querySelector('p.acc').textContent = on && acc && acc.email ? 'Cuenta: ' + acc.email : '';
      odBox.querySelector('[data-a=od-con]').hidden = on && s.state !== 'reauth';
      odBox.querySelector('[data-a=od-con]').textContent = s.state === 'reauth' ? 'Reconectar OneDrive' : 'Conectar OneDrive';
      odBox.querySelector('[data-a=od-sync]').hidden = !on || s.state === 'reauth';
      odBox.querySelector('[data-a=od-off]').hidden = !on;
    };
    odListeners.add(paint); paint(odState);
    /* Se escucha en la ventana y en fase de captura: así la página no puede quedarse con estos eventos. */
    window.addEventListener('click', async e => {
      if (e.target === btn || (e.target.closest && e.target.closest('#cl-datos-btn'))) { e.stopPropagation(); box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); say(''); paint(odState); return; }
      const a = e.target.closest && e.target.closest('#cl-datos button[data-a]'); if (!a) return;
      e.stopPropagation();
      if (a.dataset.a === 'od-con') { odConnect(); return; }
      if (a.dataset.a === 'od-sync') { odSync(); return; }
      if (a.dataset.a === 'od-off') { odDisconnect(); return; }
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

  window.ClaudeLocal = Object.freeze({ ready, exportAll, importFile, config: CFG,
    onedrive: Object.freeze({ sync: odSync, connect: odConnect, disconnect: odDisconnect, state: () => Object.assign({}, odState), archivo: FILE_PATH }) });
})();
