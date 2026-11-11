/* Separador de Anexos — acceso con la misma cuenta del Cotizador SERVIMAT (Firebase servimat-e2f18).
   Entra el administrador y quien tenga «anexos: true» en su ficha de usuarios. Los datos de trabajadores
   no pasan por Firebase: quedan en el navegador de cada PC. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signOut, updateProfile } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC7poqbPM2VndQTmpf8-ENkc2zr6cZVET8',
  authDomain: 'servimat-e2f18.firebaseapp.com',
  projectId: 'servimat-e2f18',
  storageBucket: 'servimat-e2f18.firebasestorage.app',
  messagingSenderId: '211533522317',
  appId: '1:211533522317:web:a0d22b4fdfc31b07d409c4'
};
const ADMIN_EMAIL = 'danielmjqcontacto@quidelxpert.cl';
const OK_KEY = 'anexos-acceso-ok';

const $ = id => document.getElementById(id);
const fbApp = initializeApp(FIREBASE_CONFIG);  // misma app que el cotizador: misma cuenta que el cotizador
const auth = getAuth(fbApp);
auth.languageCode = 'es';
const db = getFirestore(fbApp);

let unsubProfile = null, unsubUsers = null, pendingName = '', entered = false;

const isAdmin = user => Boolean(user && user.emailVerified && (user.email || '').toLowerCase() === ADMIN_EMAIL);

function errText(e) {
  const c = (e && e.code) || '';
  const M = {
    'auth/invalid-credential': 'Correo o contraseña incorrectos.',
    'auth/wrong-password': 'Correo o contraseña incorrectos.',
    'auth/user-not-found': 'Correo o contraseña incorrectos.',
    'auth/invalid-email': 'El correo no es válido.',
    'auth/email-already-in-use': 'Ese correo ya tiene cuenta. Usa «Ingresar» o «Recuperar».',
    'auth/weak-password': 'La contraseña es muy débil. Usa al menos 8 caracteres.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
    'auth/unauthorized-domain': `Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains): ${location.hostname}`,
    'auth/user-disabled': 'Esta cuenta fue deshabilitada.',
    'permission-denied': 'Firebase no dio permiso para esta acción. Revisa las reglas de Firestore.',
    'unavailable': 'Sin conexión con Firebase. Reintenta en un momento.',
  };
  return M[c] || (e && e.message) || 'Ocurrió un error inesperado.';
}

function msg(text, good) {
  const m = $('gMsg');
  m.textContent = text || '';
  m.classList.toggle('good', Boolean(good));
}

function view(name) {
  $('gate').hidden = name === 'app';
  $('gLogin').hidden = name !== 'login';
  $('gPending').hidden = name !== 'pending';
  $('gLoading').hidden = name !== 'loading';
  $('app').hidden = name !== 'app';
}

function tab(t) {
  for (const k of ['login', 'registro', 'recuperar']) {
    $('gf-' + k).hidden = k !== t;
    $('gt-' + k).setAttribute('aria-selected', String(k === t));
  }
  msg('');
}

function enter(user, admin) {
  view('app');
  $('whoChip').hidden = false;
  $('whoMail').textContent = user.email;
  $('accesosBtn').hidden = !admin;
  try { localStorage.setItem(OK_KEY, user.uid); } catch (e) { /* opcional */ }
  if (!entered) { entered = true; if (window.__startApp) window.__startApp(); }
}

function pending(user, profile) {
  view('pending');
  const nombre = (profile && profile.nombre) || user.displayName || '';
  $('gPendText').textContent = (nombre ? `Hola ${nombre}. ` : '') +
    'Tu cuenta está registrada, pero todavía no tiene acceso al Separador de Anexos. Pide al administrador que te lo active; esta pantalla se actualizará sola.';
  $('gResend').hidden = user.emailVerified;
}

onAuthStateChanged(auth, async user => {
  if (unsubProfile) { unsubProfile(); unsubProfile = null; }
  if (!user) {
    try { localStorage.removeItem(OK_KEY); } catch (e) { /* opcional */ }
    if (entered) { location.reload(); return; }
    view('login');
    return;
  }
  view('loading');
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const nombre = pendingName || user.displayName || (user.email || '').split('@')[0];
      await setDoc(ref, { nombre, email: user.email, role: 'vendedor', activo: false, emailVerificado: user.emailVerified, creado: serverTimestamp(), ultimoAcceso: serverTimestamp() });
    }
    unsubProfile = onSnapshot(ref, s => {
      const p = s.data() || {};
      if (isAdmin(user) || p.anexos === true) enter(user, isAdmin(user));
      else if (!entered) pending(user, p);
      else location.reload();
    }, e => fail(user, e));
  } catch (e) { fail(user, e); }
});

/* Sin conexión: si esta misma cuenta ya entró en este PC, se deja usar lo guardado aquí. */
function fail(user, e) {
  console.error(e);
  let known = null;
  try { known = localStorage.getItem(OK_KEY); } catch (x) { /* opcional */ }
  if (known && known === user.uid && (!navigator.onLine || (e && e.code === 'unavailable'))) { enter(user, isAdmin(user)); return; }
  view('login');
  msg(errText(e));
}

$('gt-login').addEventListener('click', () => tab('login'));
$('gt-registro').addEventListener('click', () => tab('registro'));
$('gt-recuperar').addEventListener('click', () => tab('recuperar'));

$('gf-login').addEventListener('submit', async e => {
  e.preventDefault(); msg('');
  try { await signInWithEmailAndPassword(auth, $('gl-email').value.trim(), $('gl-pass').value); }
  catch (err) { msg(errText(err)); }
});
$('gf-registro').addEventListener('submit', async e => {
  e.preventDefault(); msg('');
  const nombre = $('gr-nombre').value.trim(), p1 = $('gr-pass').value, p2 = $('gr-pass2').value;
  if (p1 !== p2) { msg('Las contraseñas no coinciden.'); return; }
  pendingName = nombre;
  try {
    const cred = await createUserWithEmailAndPassword(auth, $('gr-email').value.trim(), p1);
    updateProfile(cred.user, { displayName: nombre }).catch(() => {});
    sendEmailVerification(cred.user).catch(() => {});
  } catch (err) { pendingName = ''; msg(errText(err)); }
});
$('gf-recuperar').addEventListener('submit', async e => {
  e.preventDefault(); msg('');
  try { await sendPasswordResetEmail(auth, $('gp-email').value.trim()); msg('Si el correo está registrado, te llegará un enlace para crear una contraseña nueva. Revisa también el spam.', true); }
  catch (err) { msg(errText(err)); }
});
$('gResend').addEventListener('click', async () => {
  try { await sendEmailVerification(auth.currentUser); msg('Te enviamos el correo de verificación otra vez.', true); }
  catch (err) { msg(errText(err)); }
});
$('gReload').addEventListener('click', async () => { try { await auth.currentUser.reload(); } catch (e) { /* opcional */ } location.reload(); });
$('gOut').addEventListener('click', () => signOut(auth));
$('logoutBtn').addEventListener('click', () => signOut(auth));

/* ---------- Accesos (solo administrador) ---------- */
function renderUsers(list) {
  const box = $('accRows');
  box.textContent = '';
  const me = (auth.currentUser && auth.currentUser.uid) || '';
  list.sort((a, b) => String(a.nombre || a.email).localeCompare(String(b.nombre || b.email), 'es'));
  for (const u of list) {
    const tr = document.createElement('tr');
    const admin = (u.email || '').toLowerCase() === ADMIN_EMAIL;
    const td = t => { const x = document.createElement('td'); x.textContent = t || ''; tr.append(x); return x; };
    td(u.nombre); td(u.email);
    td(u.activo === true ? (u.role === 'admin' ? 'Administrador' : 'Activo') : 'Sin activar');
    const c = td('');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'pick'; cb.dataset.uid = u.uid; cb.id = 'acc-' + u.uid;
    cb.checked = admin || u.anexos === true; cb.disabled = admin || u.uid === me;
    cb.setAttribute('aria-label', 'Acceso de ' + (u.nombre || u.email) + ' al separador');
    c.append(cb);
    box.append(tr);
  }
  if (!list.length) { const tr = document.createElement('tr'); const x = document.createElement('td'); x.colSpan = 4; x.textContent = 'No hay usuarios registrados.'; tr.append(x); box.append(tr); }
}

$('accesosBtn').addEventListener('click', () => {
  $('accMsg').textContent = '';
  $('accDlg').showModal();
  if (unsubUsers) return;
  unsubUsers = onSnapshot(collection(db, 'users'), snap => renderUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
    e => { $('accMsg').textContent = 'No pude leer los usuarios: ' + errText(e); });
});
$('accClose').addEventListener('click', () => $('accDlg').close());
$('accRows').addEventListener('change', async e => {
  const cb = e.target.closest('input[data-uid]');
  if (!cb) return;
  cb.disabled = true;
  try {
    await updateDoc(doc(db, 'users', cb.dataset.uid), { anexos: cb.checked });
    $('accMsg').textContent = cb.checked ? 'Acceso activado.' : 'Acceso quitado.';
  } catch (err) {
    cb.checked = !cb.checked;
    $('accMsg').textContent = 'No se guardó el cambio: ' + errText(err);
  } finally { cb.disabled = false; }
});
