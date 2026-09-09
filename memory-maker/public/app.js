'use strict';

/* =========================================================================
   The Memory Maker — frontend
   Plain JS single-page app, no build step: fetch() against the JSON API,
   template-literal rendering, event delegation after each render. Kept in
   one file on purpose — this is a small app, and a build step would be
   pure overhead for it.
   ========================================================================= */

const AVATAR_FALLBACK = '#c2477c';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_LABELS_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const REMINDER_PRESETS = [
  { hours: 24, label: '1 day before' },
  { hours: 48, label: '2 days before' },
  { hours: 72, label: '3 days before' },
  { hours: 168, label: '1 week before' }
];

const state = {
  token: localStorage.getItem('mm_token') || null,
  user: null,
  families: [],
  groups: [],
  currentFamilyId: localStorage.getItem('mm_family_id') || null,
  config: { smsEnabled: false, recipeGenerationEnabled: false },
  tab: 'today',
  foodTab: 'dinner',
  requestsTab: 'callouts',
  selectedDate: todayStr(),
  weekStart: mondayOf(new Date()),
  cache: {}
};

// ---- date helpers ----
function todayStr() { return new Date().toISOString().slice(0, 10); }
function pad2(n) { return String(n).padStart(2, '0'); }
function mondayOf(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateForDay(weekStart, day) { return addDays(weekStart, DAYS.indexOf(day)); }
function fmtDate(dateStr, opts) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', opts || { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- icons ----
// Inline SVG for primary nav / key actions — emoji glyphs render inconsistently across
// platforms (a wrong glyph has been observed for 🍳), so anything that's core UI (not
// decorative flavour text) is drawn instead.
const ICON_PATHS = {
  camera: '<path d="M4 8.2a1.5 1.5 0 0 1 1.5-1.5H8l1.6-2.2h4.8L16 6.7h2.5A1.5 1.5 0 0 1 20 8.2v9.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.6" r="3.4"/>',
  images: '<rect x="3" y="4.5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M3.5 17.5 9 12l3.5 3.5L17 11l3.5 4"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chevronLeft: '<polyline points="14,5 8,12 14,19"/>',
  chevronRight: '<polyline points="10,5 16,12 10,19"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.8A1 1 0 0 1 10.5 3.8h3a1 1 0 0 1 1 1V7"/><path d="M6.5 7l.9 12a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12"/>',
  check: '<polyline points="5,13 10,18 19,7"/>',
  pot: '<path d="M4 11h16"/><path d="M5 11v5.5A3.5 3.5 0 0 0 8.5 20h7a3.5 3.5 0 0 0 3.5-3.5V11"/><path d="M9 11V7.5a3 3 0 0 1 6 0V11"/><path d="M2.5 9.5c0-1 1-1.8 2-1.3M21.5 9.5c0-1-1-1.8-2-1.3"/>',
  book: '<path d="M4 5.2A2.2 2.2 0 0 1 6.2 3H19v16.8H6.2A2.2 2.2 0 0 0 4 22V5.2Z"/><path d="M19 19.8H6.2A2.2 2.2 0 0 0 4 22"/>',
  cart: '<circle cx="9.5" cy="20" r="1.4"/><circle cx="17.5" cy="20" r="1.4"/><path d="M3 4h2.2l2.1 11a1.8 1.8 0 0 0 1.8 1.5h7.4a1.8 1.8 0 0 0 1.8-1.5L20 8H6.3"/>',
  utensils: '<path d="M7 3v6.5a1.8 1.8 0 0 0 1.8 1.8H8a1.8 1.8 0 0 0 1.8-1.8V3"/><path d="M8.4 11.3V21"/><path d="M15.5 3c-1.4 0-2.5 1.7-2.5 3.8 0 1.7.8 3.2 2 3.7V21"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  link: '<path d="M18.5 13.5 21 11a5 5 0 0 0-7-7l-2.5 2.5"/><path d="M5.5 10.5 3 13a5 5 0 0 0 7 7l2.5-2.5"/><line x1="8.5" y1="15.5" x2="15.5" y2="8.5"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="3"/>',
  poll: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
};
function icon(name, size, cls) {
  size = size || 18;
  return `<svg class="i ${cls || ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
function loadingHtml(msg) { return `<div class="loading-row"><div class="spinner"></div><span>${esc(msg || 'Loading…')}</span></div>`; }

// ---- voice dictation ----
// Browser-native speech-to-text (Web Speech API) — no server round trip, so
// it only works where the browser ships it (Chrome/Edge/Safari/Android;
// not Firefox). Feature-detected: micButtonHtml() renders nothing where
// unsupported, so there's no dead button on browsers that can't use it.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
function micButtonHtml(id, label) {
  if (!SpeechRecognitionCtor) return '';
  return `<button type="button" class="btn btn-icon-sm btn-mic" id="${id}" aria-label="${esc(label || 'Dictate by voice')}">${icon('mic', 15)}</button>`;
}
// Wires a mic button (from micButtonHtml) to start/stop dictation into
// inputEl, appending onto whatever's already typed rather than overwriting it.
function attachDictation(buttonId, inputEl) {
  if (!SpeechRecognitionCtor) return;
  const btn = document.getElementById(buttonId);
  if (!btn || !inputEl) return;
  let recognition = null;
  let listening = false;
  btn.onclick = () => {
    if (listening) { recognition && recognition.stop(); return; }
    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-GB';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { listening = true; btn.classList.add('listening'); };
    recognition.onerror = () => { listening = false; btn.classList.remove('listening'); };
    recognition.onend = () => { listening = false; btn.classList.remove('listening'); };
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (!transcript) return;
      const existing = inputEl.value.trim();
      inputEl.value = existing ? existing + ' ' + transcript : transcript;
      inputEl.focus();
    };
    try { recognition.start(); } catch (err) { listening = false; btn.classList.remove('listening'); }
  };
}

// ---- API ----
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers);
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
  return data;
}

// Downloads a PDF from /api/summary/export — a plain <a href> can't carry
// the bearer token, so this fetches it as a blob and triggers the save via
// a throwaway object URL instead.
async function downloadSummary(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch('/api/summary/export?' + qs, { headers: { Authorization: 'Bearer ' + state.token } });
  if (!res.ok) {
    let msg = 'Could not generate the summary';
    try { msg = (await res.json()).error || msg; } catch (e) { /* no JSON body */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const match = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : 'memory-maker-summary.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function openSummaryPicker(scope, label, params) {
  openModal(`
    <div class="modal-head"><h3>Download summary</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <p class="muted">${esc(label)}</p>
    <div class="field">
      <label for="summary-period">Period</label>
      <select id="summary-period">
        <option value="week">This week</option>
        <option value="month">This month</option>
      </select>
    </div>
    <button class="btn btn-primary btn-block" id="summary-download-btn">${icon('download', 15)} Download PDF</button>
    <p class="error-text hidden" id="summary-error"></p>
  `);
  document.getElementById('summary-download-btn').onclick = async () => {
    const btn = document.getElementById('summary-download-btn');
    const period = document.getElementById('summary-period').value;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      await downloadSummary(Object.assign({ scope, period }, params));
      closeModal();
      toast('Summary downloaded');
    } catch (err) {
      document.getElementById('summary-error').textContent = err.message;
      document.getElementById('summary-error').classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = `${icon('download', 15)} Download PDF`;
    }
  };
}

// ---- toast ----
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- modal ----
function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal-sheet">${html}</div></div>`;
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// ---- avatar ----
function avatarHtml(user, size) {
  const cls = size === 'lg' ? 'avatar avatar-lg' : 'avatar';
  const initial = (user.name || '?').trim()[0] || '?';
  return `<div class="${cls}" style="background:${esc(user.color || AVATAR_FALLBACK)}" title="${esc(user.name)}">${esc(initial.toUpperCase())}</div>`;
}

/* =========================================================================
   Boot
   ========================================================================= */

async function boot() {
  const path = window.location.pathname;
  const dinnerMatch = path.match(/^\/dinner\/([a-f0-9]+)$/);
  const rateMatch = path.match(/^\/rate\/([a-f0-9]+)$/);
  const joinMatch = path.match(/^\/join\/(family|group)\/([A-Za-z0-9]+)$/);
  const calloutMatch = path.match(/^\/callout\/([a-f0-9]+)$/);
  const pollMatch = path.match(/^\/poll\/([a-f0-9]+)$/);
  if (dinnerMatch) return bootPublicDinner(dinnerMatch[1]);
  if (rateMatch) return bootPublicRating(rateMatch[1]);
  if (calloutMatch) return bootPublicCallout(calloutMatch[1]);
  if (pollMatch) return bootPublicPoll(pollMatch[1]);
  if (joinMatch) { state.pendingJoin = { kind: joinMatch[1], code: joinMatch[2] }; window.history.replaceState({}, '', '/'); }

  if (!state.token) {
    if (state.pendingJoin) return showJoinPreview();
    return showAuthScreen();
  }

  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
  } catch (e) {
    localStorage.removeItem('mm_token');
    state.token = null;
    if (state.pendingJoin) return showJoinPreview();
    return showAuthScreen();
  }

  try { state.config = await api('/api/config'); } catch (e) { /* defaults are fine */ }
  await loadFamiliesAndGroups();

  if (state.pendingJoin) {
    await completePendingJoin();
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('googleConnected')) {
    toast('Google Calendar connected!');
    window.history.replaceState({}, '', '/');
  } else if (params.get('googleError')) {
    toast(params.get('googleError'));
    window.history.replaceState({}, '', '/');
  }

  showApp();
}

// A join link (/join/family/:code or /join/group/:code) landed here — the
// backend serves the app shell for those paths, we read the code
// client-side. If the visitor isn't logged in yet, show them who they're
// joining before asking them to sign up/log in; either way, join happens
// automatically once we have a session.
async function showJoinPreview() {
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('public-screen').classList.add('hidden');
  const screen = document.getElementById('auth-screen');
  screen.classList.remove('hidden');
  const { kind, code } = state.pendingJoin;
  try {
    const preview = await fetch(`/api/${kind === 'family' ? 'families' : 'groups'}/join-preview/${code}`).then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    });
    const banner = document.createElement('div');
    banner.className = 'card';
    banner.style.marginBottom = '14px';
    banner.innerHTML = `<div class="row">
      ${preview.photoUrl ? `<img src="${esc(preview.photoUrl)}" class="photo-avatar" alt="">` : `<div class="avatar avatar-lg" style="background:${AVATAR_FALLBACK}">${icon(kind === 'family' ? 'users' : 'user', 20)}</div>`}
      <div><strong>You're invited!</strong><p class="muted">Sign up or log in to join "${esc(preview.name)}" (${preview.memberCount} member${preview.memberCount === 1 ? '' : 's'})</p></div>
    </div>`;
    screen.querySelector('.card').before(banner);
  } catch (e) {
    toast("That invite link isn't valid");
    state.pendingJoin = null;
  }
}

async function completePendingJoin() {
  const { kind, code } = state.pendingJoin;
  state.pendingJoin = null;
  try {
    await api(`/api/${kind === 'family' ? 'families' : 'groups'}/join`, { method: 'POST', body: { joinCode: code } });
    await loadFamiliesAndGroups();
    toast(`Joined! Welcome to the ${kind}.`);
  } catch (err) {
    toast(err.message);
  }
}

function showAuthScreen() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('public-screen').classList.add('hidden');
}

async function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('public-screen').classList.add('hidden');
  document.getElementById('app-root').classList.remove('hidden');
  renderHeader();
  bindTabbar();
  switchTab(state.tab);
  startNotificationPolling();
}

async function loadFamiliesAndGroups() {
  const [f, g] = await Promise.all([api('/api/families'), api('/api/groups')]);
  state.families = f.families;
  state.groups = g.groups;
  if (!state.currentFamilyId || !state.families.some((fam) => fam.id === state.currentFamilyId)) {
    state.currentFamilyId = state.families[0] ? state.families[0].id : null;
  }
  if (state.currentFamilyId) localStorage.setItem('mm_family_id', state.currentFamilyId);
}

function currentFamily() { return state.families.find((f) => f.id === state.currentFamilyId) || null; }

/* =========================================================================
   Header / auth / profile / family switching
   ========================================================================= */

function renderHeader() {
  const sw = document.getElementById('family-switcher');
  if (!state.families.length) {
    sw.innerHTML = `<option>No family yet</option>`;
  } else {
    sw.innerHTML = state.families.map((f) => `<option value="${f.id}" ${f.id === state.currentFamilyId ? 'selected' : ''}>${esc(f.name)}</option>`).join('') +
      `<option value="__manage">+ Manage families…</option>`;
  }
  sw.onchange = () => {
    if (sw.value === '__manage') { renderHeader(); openFamilyManager(); return; }
    state.currentFamilyId = sw.value;
    localStorage.setItem('mm_family_id', sw.value);
    refreshCurrentView();
  };
  const profileBtn = document.getElementById('profile-btn');
  profileBtn.style.background = state.user.color || AVATAR_FALLBACK;
  profileBtn.textContent = (state.user.name || '?').trim()[0].toUpperCase();
  profileBtn.onclick = openProfileModal;
  document.getElementById('notif-bell-btn').onclick = openNotificationsPanel;
}

/* =========================================================================
   Notifications — a bell with an unread badge, polled independently of
   whatever tab is open (unlike chat polling, which only runs while that
   tab is visible — you should still hear about a new notification from
   the Today tab).
   ========================================================================= */

let notifPollTimer = null;

function startNotificationPolling() {
  refreshUnreadCount();
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(refreshUnreadCount, 20000);
}

async function refreshUnreadCount() {
  try {
    const { count } = await api('/api/notifications/unread-count');
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch (e) { /* non-critical */ }
}

async function openNotificationsPanel() {
  openModal(`
    <div class="modal-head"><h3>Notifications</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <div id="notif-list">${loadingHtml()}</div>
  `);
  const { notifications } = await api('/api/notifications');
  const list = document.getElementById('notif-list');
  if (!notifications.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">${icon('bell', 22)}</div><h3>All quiet</h3><p>Nothing yet — you'll see it here when someone needs you.</p></div>`;
    return;
  }
  const hasUnread = notifications.some((n) => !n.readAt);
  list.innerHTML =
    (hasUnread ? `<button class="btn btn-sm" id="notif-mark-all" style="margin-bottom:10px">Mark all as read</button>` : '') +
    `<div class="stack" style="gap:0">${notifications.map(notifItemHtml).join('')}</div>`;
  if (hasUnread) {
    document.getElementById('notif-mark-all').onclick = async () => {
      await api('/api/notifications/read-all', { method: 'POST' });
      refreshUnreadCount();
      openNotificationsPanel();
    };
  }
  document.querySelectorAll('.notif-item').forEach((el) => {
    el.onclick = async () => {
      if (!el.classList.contains('read')) {
        await api(`/api/notifications/${el.dataset.id}/read`, { method: 'POST' });
        refreshUnreadCount();
      }
      closeModal();
      if (el.dataset.link && ['today', 'calendar', 'memories', 'todos', 'chat', 'requests', 'food'].includes(el.dataset.link)) {
        switchTab(el.dataset.link);
      }
    };
  });
}

function notifItemHtml(n) {
  return `<div class="notif-item ${n.readAt ? 'read' : ''}" data-id="${n.id}" data-link="${esc(n.link || '')}">
    <span class="dot"></span>
    <div class="body"><strong>${esc(n.title)}</strong>${n.body ? `<p class="muted">${esc(n.body)}</p>` : ''}</div>
    <time>${relativeTime(n.createdAt)}</time>
  </div>`;
}

function bindAuthScreen() {
  const tabLogin = document.getElementById('auth-tab-login');
  const tabSignup = document.getElementById('auth-tab-signup');
  const nameField = document.getElementById('auth-name-field');
  const phoneField = document.getElementById('auth-phone-field');
  const submitBtn = document.getElementById('auth-submit');
  let mode = 'login';

  function setMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabSignup.classList.toggle('active', m === 'signup');
    nameField.classList.toggle('hidden', m !== 'signup');
    phoneField.classList.toggle('hidden', m !== 'signup');
    submitBtn.textContent = m === 'login' ? 'Log in' : 'Create account';
    document.getElementById('auth-error').classList.add('hidden');
  }
  tabLogin.onclick = () => setMode('login');
  tabSignup.onclick = () => setMode('signup');

  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    try {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      let result;
      if (mode === 'login') {
        result = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      } else {
        const name = document.getElementById('auth-name').value.trim();
        const phone = document.getElementById('auth-phone').value.trim();
        result = await api('/api/auth/signup', { method: 'POST', body: { name, email, password, phone: phone || undefined } });
      }
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem('mm_token', result.token);
      try { state.config = await api('/api/config'); } catch (e2) { /* fine */ }
      await loadFamiliesAndGroups();
      if (state.pendingJoin) {
        await completePendingJoin();
        showApp();
      } else if (!state.families.length) {
        showApp();
        openFamilyManager('Welcome! Create or join a family to get started.');
      } else {
        showApp();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
    }
  };
  setMode('login');
}

function openProfileModal() {
  const u = state.user;
  openModal(`
    <div class="modal-head"><h3>Your profile</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <div class="stack">
      <div class="row">${avatarHtml(u, 'lg')}<div style="flex:1"><strong>${esc(u.name)}</strong><p class="muted">${esc(u.email)}</p></div></div>
      <div class="field">
        <label for="profile-phone">Mobile number (for SMS reminders)</label>
        <input type="tel" id="profile-phone" value="${esc(u.phone || '')}" placeholder="07... or +447...">
      </div>
      <label class="hstack"><input type="checkbox" id="profile-sms" ${u.smsOptIn ? 'checked' : ''} style="width:auto"> Send me SMS reminders</label>
      ${!state.config.smsEnabled ? '<p class="muted">SMS isn\'t configured on this server yet — this will take effect once it is.</p>' : ''}
      <button class="btn btn-primary btn-block" id="profile-save">Save</button>
      <p class="error-text hidden" id="profile-error"></p>
      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Google Calendar</div>
      <div id="google-calendar-status">${loadingHtml('Checking…')}</div>
      <div class="divider"></div>
      <button class="btn btn-block" onclick="openFamilyManager()">Manage families &amp; friend groups</button>
      ${state.currentFamilyId ? `<button class="btn btn-block" id="profile-download-summary">${icon('download', 15)} Download my summary</button>` : ''}
      <button class="btn btn-bad btn-block" id="profile-logout">Log out</button>
    </div>
  `);
  loadGoogleCalendarStatus();
  if (state.currentFamilyId) {
    document.getElementById('profile-download-summary').onclick = () => {
      openSummaryPicker('user', 'Your personal summary', { familyId: state.currentFamilyId, userId: u.id });
    };
  }
  document.getElementById('profile-save').onclick = async () => {
    try {
      const phone = document.getElementById('profile-phone').value.trim();
      const smsOptIn = document.getElementById('profile-sms').checked;
      const { user } = await api('/api/auth/me', { method: 'PATCH', body: { phone: phone || null, smsOptIn } });
      state.user = user;
      closeModal();
      renderHeader();
      toast('Profile updated');
    } catch (err) {
      const el = document.getElementById('profile-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  };
  document.getElementById('profile-logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    localStorage.removeItem('mm_token');
    localStorage.removeItem('mm_family_id');
    window.location.reload();
  };
}

async function loadGoogleCalendarStatus() {
  const el = document.getElementById('google-calendar-status');
  if (!el) return;
  try {
    const status = await api('/api/integrations/google/status');
    if (!status.enabled) {
      el.innerHTML = `<p class="muted">Not set up on this server yet — an admin needs to add Google API credentials.</p>`;
      return;
    }
    if (status.connected) {
      el.innerHTML = `
        <p class="muted">Connected as <strong>${esc(status.calendarEmail || 'your Google account')}</strong>${status.lastSyncedAt ? ` · last synced ${relativeTime(status.lastSyncedAt)} ago` : ''}. Your Google events show up on your calendar for conflict-checking.</p>
        <div class="hstack">
          <button class="btn btn-sm" id="google-sync-btn">${icon('refresh', 13)} Sync now</button>
          <button class="btn btn-sm btn-bad" id="google-disconnect-btn">Disconnect</button>
        </div>`;
      document.getElementById('google-sync-btn').onclick = async () => {
        try { await api('/api/integrations/google/sync', { method: 'POST' }); toast('Synced!'); loadGoogleCalendarStatus(); } catch (err) { toast(err.message); }
      };
      document.getElementById('google-disconnect-btn').onclick = async () => {
        if (!confirm('Disconnect Google Calendar? Imported events will be removed.')) return;
        try { await api('/api/integrations/google', { method: 'DELETE' }); toast('Disconnected'); loadGoogleCalendarStatus(); refreshCurrentView(); } catch (err) { toast(err.message); }
      };
    } else {
      el.innerHTML = `
        <p class="muted">Connect your Google Calendar so those events count toward conflict-checking too — read-only, nothing here is ever written back to Google.</p>
        <button class="btn btn-block" id="google-connect-btn">${icon('link', 14)} Connect Google Calendar</button>`;
      document.getElementById('google-connect-btn').onclick = () => {
        window.location.href = '/api/integrations/google/connect?token=' + encodeURIComponent(state.token);
      };
    }
  } catch (err) {
    el.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function entityApiBase(kind) { return kind === 'family' ? '/api/families' : '/api/groups'; }

function openFamilyManager(introMessage) {
  openModal(`
    <div class="modal-head"><h3>Families &amp; friend groups</h3><button onclick="closeModal()">${icon('x')}</button></div>
    ${introMessage ? `<p class="muted">${esc(introMessage)}</p>` : ''}
    <div class="section-title">Your families</div>
    <div class="stack" id="fam-list">${state.families.map((f) => entityRow('family', f)).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="hstack" style="margin-top:8px">
      <input id="join-fam-code" placeholder="Have a join code for a family?" aria-label="Family join code" style="flex:1">
      <button class="btn" id="join-fam-btn">Join</button>
    </div>

    <div class="section-title">Your friend groups</div>
    <div class="stack" id="grp-list">${state.groups.map((g) => entityRow('group', g)).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="hstack" style="margin-top:8px">
      <input id="join-grp-code" placeholder="Have a join code for a friend group?" aria-label="Friend group join code" style="flex:1">
      <button class="btn" id="join-grp-btn">Join</button>
    </div>

    <button class="btn btn-primary btn-block" id="open-create-choice" style="margin-top:16px">${icon('plus', 16)} Create a family or friend group</button>
  `);

  document.getElementById('open-create-choice').onclick = () => openCreateEntityChoice();
  document.getElementById('join-fam-btn').onclick = () => joinByCode('family', 'join-fam-code');
  document.getElementById('join-grp-btn').onclick = () => joinByCode('group', 'join-grp-code');

  document.querySelectorAll('.entity-photo-edit').forEach((btn) => {
    btn.onclick = () => { pendingPhotoTarget = { kind: btn.dataset.kind, id: btn.dataset.id }; document.getElementById('entity-photo-input').click(); };
  });
  document.querySelectorAll('.entity-rename').forEach((btn) => {
    btn.onclick = async () => {
      const current = btn.dataset.name;
      const name = window.prompt('Rename to:', current);
      if (!name || !name.trim() || name.trim() === current) return;
      try {
        await api(`${entityApiBase(btn.dataset.kind)}/${btn.dataset.id}`, { method: 'PATCH', body: { name: name.trim() } });
        await loadFamiliesAndGroups();
        renderHeader();
        openFamilyManager();
        toast('Renamed');
      } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.entity-invite').forEach((btn) => {
    btn.onclick = () => openInviteForm(btn.dataset.kind, btn.dataset.id, btn.dataset.name);
  });
  document.querySelectorAll('.entity-members-toggle').forEach((btn) => {
    btn.onclick = () => toggleEntityMembers(btn.dataset.kind, btn.dataset.id);
  });
  document.querySelectorAll('.entity-summary').forEach((btn) => {
    btn.onclick = () => {
      const { kind, id, name } = btn.dataset;
      const params = kind === 'family' ? { familyId: id } : { groupId: id };
      openSummaryPicker(kind, name, params);
    };
  });
}

function entityRow(kind, entity) {
  const photo = entity.photoUrl
    ? `<img src="${esc(entity.photoUrl)}" class="photo-avatar" alt="">`
    : `<div class="avatar avatar-lg" style="background:${AVATAR_FALLBACK}">${icon(kind === 'family' ? 'users' : 'user', 20)}</div>`;
  return `<div class="card card-tight">
    <div class="row">
      <button class="btn-plain entity-photo-edit" data-kind="${kind}" data-id="${entity.id}" aria-label="Change photo" style="padding:0">${photo}</button>
      <div style="flex:1">
        <div class="hstack" style="gap:6px">
          <strong>${esc(entity.name)}</strong>
          <button class="btn-plain entity-rename" data-kind="${kind}" data-id="${entity.id}" data-name="${esc(entity.name)}" aria-label="Rename">${icon('pencil', 13)}</button>
        </div>
        <p class="muted">Join code: <b>${esc(entity.joinCode)}</b></p>
      </div>
    </div>
    <div class="hstack" style="margin-top:8px">
      <button class="btn btn-sm entity-invite" data-kind="${kind}" data-id="${entity.id}" data-name="${esc(entity.name)}">${icon('link', 13)} Invite by text</button>
      <button class="btn btn-sm entity-members-toggle" data-kind="${kind}" data-id="${entity.id}">${icon('users', 13)} Members</button>
      <button class="btn btn-sm entity-summary" data-kind="${kind}" data-id="${entity.id}" data-name="${esc(entity.name)}">${icon('download', 13)} Summary</button>
    </div>
    <div id="members-${entity.id}" class="hidden" style="margin-top:8px"></div>
  </div>`;
}

async function joinByCode(kind, inputId) {
  const joinCode = document.getElementById(inputId).value.trim();
  if (!joinCode) return;
  try {
    await api(`${entityApiBase(kind)}/join`, { method: 'POST', body: { joinCode } });
    await loadFamiliesAndGroups();
    renderHeader();
    openFamilyManager();
    toast(kind === 'family' ? 'Joined family' : 'Joined friend group');
  } catch (err) { toast(err.message); }
}

async function toggleEntityMembers(kind, id) {
  const el = document.getElementById(`members-${id}`);
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = loadingHtml();
  try {
    const { members } = await api(`${entityApiBase(kind)}/${id}`);
    el.innerHTML = `<div class="divider"></div>` + members.map((m) => `
      <div class="member-row">
        ${avatarHtml(m)}
        <span class="name">${esc(m.name)}${m.id === state.user.id ? ' (you)' : ''}</span>
        ${m.role === 'owner' ? '<span class="role-tag">Owner</span>' : ''}
        ${kind === 'family' ? `<button class="btn btn-icon-sm member-summary" data-user="${m.id}" data-name="${esc(m.name)}" aria-label="Download ${esc(m.name)}'s summary">${icon('download', 14)}</button>` : ''}
        ${m.id !== state.user.id ? `<button class="btn btn-icon-sm dm-start" data-user="${m.id}" aria-label="Message ${esc(m.name)}">${icon('chat', 15)}</button>` : ''}
      </div>`).join('');
    el.querySelectorAll('.dm-start').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const { conversation } = await api('/api/conversations/direct', { method: 'POST', body: { userId: btn.dataset.user } });
          closeModal();
          goToChatDetail(conversation);
        } catch (err) { toast(err.message); }
      };
    });
    el.querySelectorAll('.member-summary').forEach((btn) => {
      btn.onclick = () => openSummaryPicker('user', btn.dataset.name, { familyId: id, userId: btn.dataset.user });
    });
  } catch (err) { el.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
}

function openInviteForm(kind, id, name) {
  openModal(`
    <div class="modal-head"><h3>Invite to ${esc(name)}</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <p class="muted">We'll text them a link to join — no account needed to open it, just to join.</p>
    <div class="field"><label for="invite-phone">Their mobile number</label><input id="invite-phone" type="tel" placeholder="07... or +447..."></div>
    ${!state.config.smsEnabled ? '<p class="muted">SMS isn\'t configured on this server yet, so this won\'t actually send — but the join code above works regardless.</p>' : ''}
    <button class="btn btn-primary btn-block" id="send-invite-btn">Send invite</button>
    <p class="error-text hidden" id="invite-error"></p>
  `);
  document.getElementById('send-invite-btn').onclick = async () => {
    const phone = document.getElementById('invite-phone').value.trim();
    if (!phone) return;
    try {
      await api(`${entityApiBase(kind)}/${id}/invite`, { method: 'POST', body: { phone } });
      closeModal();
      toast('Invite sent!');
    } catch (err) {
      document.getElementById('invite-error').textContent = err.message;
      document.getElementById('invite-error').classList.remove('hidden');
    }
  };
}

function openCreateEntityChoice() {
  openModal(`
    <div class="modal-head"><h3>What would you like to create?</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <div class="choice-row">
      <div class="choice-card" id="choice-family">${icon('users', 26)}<div><strong>Family</strong></div><p class="muted" style="font-size:14px;margin:2px 0 0">Your household's shared calendar, memories, meals &amp; to-dos</p></div>
      <div class="choice-card" id="choice-group">${icon('user', 26)}<div><strong>Friend group</strong></div><p class="muted" style="font-size:14px;margin:2px 0 0">A separate calendar &amp; chat for a friendship circle</p></div>
    </div>
  `);
  document.getElementById('choice-family').onclick = () => openCreateEntityForm('family');
  document.getElementById('choice-group').onclick = () => openCreateEntityForm('group');
}

let selectedCreatePhotoFile = null;

function openCreateEntityForm(kind) {
  selectedCreatePhotoFile = null;
  openModal(`
    <div class="modal-head"><h3>New ${kind === 'family' ? 'family' : 'friend group'}</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="create-entity-form" class="stack">
      <div class="entity-photo-picker">
        <div class="preview" id="create-photo-preview">${icon(kind === 'family' ? 'users' : 'user', 22)}</div>
        <button type="button" class="btn btn-sm" id="create-photo-pick">${icon('camera', 14)} Add a photo (optional)</button>
      </div>
      <div class="field"><label for="create-entity-name">${kind === 'family' ? 'Family' : 'Group'} name</label>
        <input id="create-entity-name" required placeholder="${kind === 'family' ? 'e.g. The Tomlinsons' : 'e.g. Book Club'}"></div>
      <button type="submit" class="btn btn-primary btn-block">Create</button>
      <p class="error-text hidden" id="create-entity-error"></p>
    </form>
  `);
  document.getElementById('create-photo-pick').onclick = () => {
    pendingPhotoTarget = { kind, id: null };
    document.getElementById('entity-photo-input').click();
  };
  document.getElementById('create-entity-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('create-entity-name').value.trim();
    if (!name) return;
    try {
      const result = await api(entityApiBase(kind), { method: 'POST', body: { name } });
      const entity = kind === 'family' ? result.family : result.group;
      if (selectedCreatePhotoFile) {
        const fd = new FormData();
        fd.append('file', selectedCreatePhotoFile);
        await api(`${entityApiBase(kind)}/${entity.id}/photo`, { method: 'POST', body: fd });
      }
      await loadFamiliesAndGroups();
      renderHeader();
      openFamilyManager();
      toast(`${kind === 'family' ? 'Family' : 'Friend group'} created`);
    } catch (err) {
      document.getElementById('create-entity-error').textContent = err.message;
      document.getElementById('create-entity-error').classList.remove('hidden');
    }
  };
}

// Shared by "add a photo while creating" (uploads once the entity exists)
// and "change photo on an existing family/group" (uploads immediately).
let pendingPhotoTarget = null;
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('entity-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !pendingPhotoTarget) return;
    if (!pendingPhotoTarget.id) {
      selectedCreatePhotoFile = file;
      const preview = document.getElementById('create-photo-preview');
      if (preview) preview.innerHTML = `<img src="${URL.createObjectURL(file)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      return;
    }
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api(`${entityApiBase(pendingPhotoTarget.kind)}/${pendingPhotoTarget.id}/photo`, { method: 'POST', body: fd });
      await loadFamiliesAndGroups();
      renderHeader();
      openFamilyManager();
      toast('Photo updated');
    } catch (err) { toast(err.message); }
  });
});

/* =========================================================================
   Tabs
   ========================================================================= */

function bindTabbar() {
  document.querySelectorAll('#tabbar button').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabbar button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  refreshCurrentView();
}
function refreshCurrentView() {
  const root = document.getElementById('view-root');
  if (state.tab !== 'chat') stopChatPolling();
  if (!currentFamily() && state.tab !== 'today' && state.tab !== 'chat') {
    root.innerHTML = noFamilyState();
    return;
  }
  switch (state.tab) {
    case 'today': return renderToday();
    case 'calendar': return renderCalendarTab();
    case 'memories': return renderMemoriesTab();
    case 'todos': return renderTodosTab();
    case 'chat': return renderChatTab();
    case 'requests': return renderRequestsTab();
    case 'food': return renderFoodTab();
  }
}
function noFamilyState() {
  return `<div class="empty-state card"><div class="big">${icon('images', 22)}</div><h3>Create or join a family first</h3>
    <p>Everything in The Memory Maker — calendars, memories, meals — is shared with a family.</p>
    <button class="btn btn-primary" onclick="openFamilyManager()">Set up a family</button></div>`;
}

/* =========================================================================
   Camera / media capture — shared by Today + Calendar day view
   ========================================================================= */

let pendingCaptureDate = null;
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('camera-input').addEventListener('change', handleCapturedFile);
  document.getElementById('file-input').addEventListener('change', handleCapturedFile);
});
function openCameraFor(date) { pendingCaptureDate = date; document.getElementById('camera-input').click(); }
function openGalleryFor(date) { pendingCaptureDate = date; document.getElementById('file-input').click(); }

async function handleCapturedFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pendingCaptureDate) return;
  const date = pendingCaptureDate;
  toast('Uploading…');
  try {
    const memory = await ensureMemoryForDate(date);
    const fd = new FormData();
    fd.append('file', file);
    await api(`/api/memories/${memory.id}/media`, { method: 'POST', body: fd });
    toast('Added to your memories! 🎉');
    delete state.cache['memories-' + date];
    refreshCurrentView();
  } catch (err) {
    toast(err.message);
  }
}
async function ensureMemoryForDate(date) {
  const familyId = state.currentFamilyId;
  const { memories } = await api(`/api/memories?familyId=${familyId}&date=${date}`);
  if (memories.length) return memories[0];
  const { memory } = await api('/api/memories', { method: 'POST', body: { familyId, date } });
  return memory;
}

/* =========================================================================
   Today
   ========================================================================= */

async function renderToday() {
  const root = document.getElementById('view-root');
  if (!currentFamily()) { root.innerHTML = noFamilyState(); return; }
  root.innerHTML = `<div class="empty-state">${loadingHtml()}</div>`;
  const date = todayStr();
  const familyId = state.currentFamilyId;
  const [calRes, memRes, todoRes] = await Promise.all([
    api(`/api/calendar?from=${date}&to=${date}`),
    api(`/api/memories?familyId=${familyId}&date=${date}`),
    api(`/api/todos?familyId=${familyId}&assignedTo=${state.user.id}&status=pending`)
  ]);
  const events = calRes.events;
  const memories = memRes.memories;
  const allMedia = memories.flatMap((m) => m.media);
  const endOfToday = date + 'T23:59:59.999Z';
  const todosToday = todoRes.todos.filter((t) => t.dueAt && t.dueAt <= endOfToday);

  root.innerHTML = `
    <div class="card" style="text-align:center">
      <p class="muted" style="margin-bottom:2px">${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h2 style="margin-bottom:14px">Today with ${esc(currentFamily().name)}</h2>
      <button class="btn-camera" id="today-camera" aria-label="Capture today's memory">${icon('camera', 28)}</button>
      <p class="muted" style="margin-top:10px">Capture today's memory</p>
      <button class="btn btn-sm" id="today-gallery" style="margin-top:2px">${icon('images', 14)} Choose from gallery</button>
    </div>

    <div class="section-title">Today's plans</div>
    ${events.length ? `<div class="card stack">${events.map(eventRowHtml).join('')}</div>` : `<p class="muted">Nothing on the calendar today.</p>`}

    <div class="section-title">Your to-dos</div>
    ${todosToday.length ? `<div class="card">${todosToday.map(todoItemHtml).join('')}</div>` : `<p class="muted">Nothing due today or overdue — nice.</p>`}

    <div class="section-title">Today's memories</div>
    ${allMedia.length
      ? `<div class="card"><div class="media-grid">${allMedia.map(mediaTileHtml).join('')}</div></div>`
      : `<p class="muted">No photos or videos yet — tap the camera above to start.</p>`}
  `;
  document.getElementById('today-camera').onclick = () => openCameraFor(date);
  document.getElementById('today-gallery').onclick = () => openGalleryFor(date);
  document.querySelectorAll('.todo-check').forEach((el) => {
    el.onclick = async () => {
      try { await api(`/api/todos/${el.dataset.id}`, { method: 'PATCH', body: { status: 'complete' } }); renderToday(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.todo-fail').forEach((el) => {
    el.onclick = async () => {
      try { await api(`/api/todos/${el.dataset.id}`, { method: 'PATCH', body: { status: 'failed' } }); renderToday(); } catch (err) { toast(err.message); }
    };
  });
}

function mediaTileHtml(m) {
  if (m.type === 'video') return `<div class="tile video"><video src="${esc(m.url)}" muted aria-label="Family video"></video></div>`;
  return `<div class="tile"><img src="${esc(m.url)}" loading="lazy" alt="Family photo"></div>`;
}
function eventRowHtml(ev) {
  const time = ev.allDay ? 'All day' : `${fmtTime(ev.startsAt)}–${fmtTime(ev.endsAt)}`;
  const occ = ev.occasionType && ev.occasionType !== 'event' ? occasionEmoji(ev.occasionType) + ' ' : '';
  return `<div class="row">
    <div><strong>${occ}${esc(ev.title)}</strong><p class="muted">${time}${ev.location ? ' · ' + esc(ev.location) : ''}</p></div>
    <div class="avatar-stack">${(ev.attendees || []).slice(0, 4).map((a) => avatarHtml(a)).join('')}</div>
  </div>`;
}
function occasionEmoji(type) {
  return { birthday: '🎂', anniversary: '💍', other: '⭐' }[type] || '';
}

/* =========================================================================
   Calendar
   ========================================================================= */

let calendarMonthCursor = new Date();

function renderCalendarTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = `<div id="calendar-container"></div>`;
  renderCalendarMonth();
}

async function renderCalendarMonth() {
  const container = document.getElementById('calendar-container');
  const year = calendarMonthCursor.getFullYear();
  const month = calendarMonthCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first grid
  const gridStart = new Date(year, month, 1 - startOffset);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const from = cells[0].toISOString().slice(0, 10);
  const to = cells[41].toISOString().slice(0, 10);

  container.innerHTML = `<div class="card"><p class="muted">Loading calendar…</p></div>`;
  const { events } = await api(`/api/calendar?from=${from}&to=${to}`);
  const eventsByDate = {};
  for (const ev of events) {
    const d = ev.startsAt.slice(0, 10);
    (eventsByDate[d] = eventsByDate[d] || []).push(ev);
  }
  const today = todayStr();

  container.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-icon-sm" id="cal-prev" aria-label="Previous month">${icon('chevronLeft', 16)}</button>
        <strong>${firstOfMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</strong>
        <button class="btn btn-icon-sm" id="cal-next" aria-label="Next month">${icon('chevronRight', 16)}</button>
      </div>
      <div class="month-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}
        ${cells.map((d) => {
          const dateStr = d.toISOString().slice(0, 10);
          const isOther = d.getMonth() !== month;
          const has = (eventsByDate[dateStr] || []).length;
          return `<div class="day ${isOther ? 'other-month' : ''} ${dateStr === today ? 'today' : ''} ${dateStr === state.selectedDate ? 'selected' : ''}" data-date="${dateStr}">
            <span>${d.getDate()}</span>
            ${has ? `<div class="dots">${Array.from({ length: Math.min(has, 3) }).map(() => '<span></span>').join('')}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="cal-add-event">${icon('plus', 16)} Add event</button>
    <div id="day-detail"></div>
  `;
  document.getElementById('cal-prev').onclick = () => { calendarMonthCursor = new Date(year, month - 1, 1); renderCalendarMonth(); };
  document.getElementById('cal-next').onclick = () => { calendarMonthCursor = new Date(year, month + 1, 1); renderCalendarMonth(); };
  document.getElementById('cal-add-event').onclick = () => openEventForm({ date: state.selectedDate });
  container.querySelectorAll('.day').forEach((el) => {
    el.onclick = () => { state.selectedDate = el.dataset.date; renderCalendarMonth(); };
  });
  renderDayDetail(eventsByDate[state.selectedDate] || []);
}

async function renderDayDetail(events) {
  const el = document.getElementById('day-detail');
  const date = state.selectedDate;
  const { memories } = await api(`/api/memories?familyId=${state.currentFamilyId}&date=${date}`);
  const allMedia = memories.flatMap((m) => m.media);

  el.innerHTML = `
    <div class="section-title">${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    <div class="card stack">
      ${events.length ? events.map((ev) => {
        const mine = (ev.attendees || []).find((a) => a.id === state.user.id);
        const canChat = mine && mine.status === 'accepted';
        return `
        <div class="row" style="align-items:flex-start">
          <div>
            <strong>${occasionEmoji(ev.occasionType)} ${esc(ev.title)}</strong>
            <p class="muted">${ev.allDay ? 'All day' : fmtTime(ev.startsAt) + '–' + fmtTime(ev.endsAt)}${ev.location ? ' · ' + esc(ev.location) : ''}</p>
            <div class="avatar-stack">${(ev.attendees || []).map((a) => avatarHtml(a)).join('')}</div>
          </div>
          <div class="hstack">
            ${canChat ? `<button class="btn btn-icon-sm event-chat-btn" data-id="${ev.id}" data-title="${esc(ev.title)}" aria-label="Chat about ${esc(ev.title)}">${icon('chat', 14)}</button>` : ''}
            <button class="btn btn-sm btn-bad" onclick="deleteEvent('${ev.id}')" aria-label="Delete ${esc(ev.title)}">${icon('trash', 14)}</button>
          </div>
        </div>`;
      }).join('<div class="divider"></div>')
        : `<p class="muted">Nothing booked yet.</p>`}
    </div>

    <div class="section-title">Memories from this day</div>
    <div class="card">
      <div class="hstack" style="margin-bottom:${allMedia.length ? '10px' : '0'}">
        <button class="btn btn-sm btn-primary" id="day-camera">${icon('camera', 14)} Add photo/video</button>
        <button class="btn btn-sm" id="day-gallery">${icon('images', 14)} Choose from gallery</button>
      </div>
      ${allMedia.length ? `<div class="media-grid">${allMedia.map(mediaTileHtml).join('')}</div>` : `<p class="muted">No memories saved for this day yet.</p>`}
    </div>
  `;
  document.getElementById('day-camera').onclick = () => openCameraFor(date);
  document.getElementById('day-gallery').onclick = () => openGalleryFor(date);
  document.querySelectorAll('.event-chat-btn').forEach((btn) => {
    btn.onclick = () => openEventConversation(btn.dataset.id, btn.dataset.title);
  });
}

async function openEventConversation(eventId, title) {
  try {
    const { conversationId } = await api(`/api/events/${eventId}/conversation`, { method: 'POST' });
    goToChatDetail({ id: conversationId, type: 'event', title });
  } catch (err) { toast(err.message); }
}

// Jumps straight to a chat thread from elsewhere in the app (an event, a
// member's DM button) without going through the conversation-list render —
// switchTab('chat') would kick off its own async fetch that could resolve
// after openChatDetail runs and clobber the detail view it just painted.
function goToChatDetail(conv) {
  state.tab = 'chat';
  document.querySelectorAll('#tabbar button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === 'chat'));
  openChatDetail(conv);
}

async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return;
  try {
    await api(`/api/events/${id}`, { method: 'DELETE' });
    toast('Event deleted');
    renderCalendarMonth();
  } catch (err) { toast(err.message); }
}

async function openEventForm(opts) {
  const familyId = state.currentFamilyId;
  const { members } = await api(`/api/families/${familyId}`);
  const date = (opts && opts.date) || todayStr();

  openModal(`
    <div class="modal-head"><h3>Add event</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="event-form" class="stack">
      <div class="field"><label for="ev-title">Title</label><input id="ev-title" required placeholder="e.g. Dentist appointment"></div>
      <div class="hstack">
        <div class="field" style="flex:1"><label for="ev-date">Date</label><input id="ev-date" type="date" value="${date}" required></div>
        <label class="hstack" style="margin-top:20px"><input type="checkbox" id="ev-allday" style="width:auto"> All day</label>
      </div>
      <div class="hstack" id="ev-time-row">
        <div class="field" style="flex:1"><label for="ev-start">Start</label><input id="ev-start" type="time" value="09:00"></div>
        <div class="field" style="flex:1"><label for="ev-end">End</label><input id="ev-end" type="time" value="10:00"></div>
      </div>
      <div class="field"><label for="ev-location">Location</label><input id="ev-location" placeholder="Optional"></div>
      <div class="field">
        <label for="ev-occasion">Type</label>
        <select id="ev-occasion">
          <option value="event">Regular event</option>
          <option value="birthday">🎂 Birthday</option>
          <option value="anniversary">💍 Anniversary</option>
          <option value="other">⭐ Special occasion</option>
        </select>
      </div>
      <label class="hstack"><input type="checkbox" id="ev-yearly" style="width:auto"> Repeats every year</label>

      <div class="field">
        <label>Who's invited</label>
        <div class="hstack">${members.map((m) => `<label class="chip"><input type="checkbox" class="ev-attendee" value="${m.id}" checked style="width:auto"> ${esc(m.name)}</label>`).join('')}</div>
      </div>

      <div class="field">
        <label>Remind attendees by SMS</label>
        <div class="hstack">${REMINDER_PRESETS.map((p) => `<label class="chip off"><input type="checkbox" class="ev-reminder" value="${p.hours}" style="width:auto"> ${p.label}</label>`).join('')}</div>
        ${!state.config.smsEnabled ? '<p class="muted">SMS isn\'t configured on this server yet — reminders will be saved but not sent.</p>' : ''}
      </div>

      <div id="conflict-warning"></div>
      <button type="submit" class="btn btn-primary btn-block">Save event</button>
      <p class="error-text hidden" id="event-error"></p>
    </form>
  `);

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cb = chip.querySelector('input');
      setTimeout(() => chip.classList.toggle('off', !cb.checked), 0);
    });
  });
  document.getElementById('ev-allday').onchange = (e) => {
    document.getElementById('ev-time-row').style.display = e.target.checked ? 'none' : 'flex';
  };

  document.getElementById('event-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('event-error');
    errEl.classList.add('hidden');
    const d = document.getElementById('ev-date').value;
    const allDay = document.getElementById('ev-allday').checked;
    const startsAt = allDay ? new Date(d + 'T00:00:00').toISOString() : new Date(d + 'T' + document.getElementById('ev-start').value).toISOString();
    const endsAt = allDay ? new Date(d + 'T23:59:59').toISOString() : new Date(d + 'T' + document.getElementById('ev-end').value).toISOString();
    const attendeeUserIds = Array.from(document.querySelectorAll('.ev-attendee:checked')).map((el) => el.value);
    const reminderOffsetsHours = Array.from(document.querySelectorAll('.ev-reminder:checked')).map((el) => Number(el.value));
    const body = {
      familyId, title: document.getElementById('ev-title').value.trim(), startsAt, endsAt, allDay,
      location: document.getElementById('ev-location').value.trim() || undefined,
      occasionType: document.getElementById('ev-occasion').value,
      recurrence: document.getElementById('ev-yearly').checked ? 'yearly' : 'none',
      attendeeUserIds, reminderOffsetsHours
    };
    try {
      const result = await api('/api/events', { method: 'POST', body });
      closeModal();
      state.selectedDate = d;
      renderCalendarMonth();
      const conflictCount = Object.keys(result.conflicts || {}).length;
      toast(conflictCount ? `Saved — but heads up, ${conflictCount} attendee(s) have a clash at that time.` : 'Event saved');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  };

  // Live conflict check as the organizer fills in time + attendees.
  async function checkConflictsLive() {
    const d = document.getElementById('ev-date').value;
    const allDay = document.getElementById('ev-allday').checked;
    if (!d) return;
    const startsAt = allDay ? new Date(d + 'T00:00:00').toISOString() : new Date(d + 'T' + document.getElementById('ev-start').value).toISOString();
    const endsAt = allDay ? new Date(d + 'T23:59:59').toISOString() : new Date(d + 'T' + document.getElementById('ev-end').value).toISOString();
    const userIds = Array.from(document.querySelectorAll('.ev-attendee:checked')).map((el) => el.value);
    if (!userIds.length) return;
    try {
      const { conflicts } = await api('/api/calendar/check-conflicts', { method: 'POST', body: { userIds, startsAt, endsAt } });
      const names = Object.keys(conflicts).map((uid) => (members.find((m) => m.id === uid) || {}).name).filter(Boolean);
      document.getElementById('conflict-warning').innerHTML = names.length
        ? `<p class="badge badge-warn">⚠ ${esc(names.join(', '))} already ${names.length > 1 ? 'have' : 'has'} something booked then</p>` : '';
    } catch (e) { /* non-critical */ }
  }
  ['ev-date', 'ev-start', 'ev-end', 'ev-allday'].forEach((id) => document.getElementById(id).addEventListener('change', checkConflictsLive));
  document.querySelectorAll('.ev-attendee').forEach((cb) => cb.addEventListener('change', checkConflictsLive));
}

/* =========================================================================
   Memories tab (browse all albums)
   ========================================================================= */

async function renderMemoriesTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = `<div class="empty-state">${loadingHtml()}</div>`;
  const { memories } = await api(`/api/memories?familyId=${state.currentFamilyId}&from=2000-01-01&to=2100-01-01`);
  if (!memories.length) {
    root.innerHTML = `<div class="empty-state card"><div class="big">${icon('images', 22)}</div><h3>No memories yet</h3><p>Tap today's date and use the camera to start your family's album.</p></div>`;
    return;
  }
  root.innerHTML = memories.map((m) => `
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <div><strong>${esc(m.title || fmtDate(m.date))}</strong><p class="muted">${fmtDate(m.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
        <div class="avatar-stack">${m.attendees.map((a) => avatarHtml(a)).join('')}</div>
      </div>
      ${m.media.length ? `<div class="media-grid">${m.media.map(mediaTileHtml).join('')}</div>` : `<p class="muted">No photos yet.</p>`}
      <div class="hstack" style="margin-top:10px">
        <button class="btn btn-sm" onclick="openCameraFor('${m.date}')">${icon('camera', 14)} Add more</button>
      </div>
    </div>
  `).join('');
}

/* =========================================================================
   To-dos
   ========================================================================= */

async function renderTodosTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = `<div class="empty-state">${loadingHtml()}</div>`;
  const familyId = state.currentFamilyId;
  const [{ members }, { todos }] = await Promise.all([api(`/api/families/${familyId}`), api(`/api/todos?familyId=${familyId}`)]);
  const byUser = {};
  for (const m of members) byUser[m.id] = { user: m, todos: [] };
  for (const t of todos) { if (byUser[t.assignedTo]) byUser[t.assignedTo].todos.push(t); }

  root.innerHTML = `
    <button class="btn btn-primary btn-block" id="add-todo-btn" style="margin-bottom:14px">${icon('plus', 16)} New to-do</button>
    ${Object.values(byUser).map((group) => `
      <div class="card">
        <div class="row" style="margin-bottom:6px">${avatarHtml(group.user)}<strong style="flex:1;margin-left:8px">${esc(group.user.name)}</strong></div>
        ${group.todos.length ? group.todos.map((t) => todoItemHtml(t)).join('') : `<p class="muted">Nothing assigned.</p>`}
      </div>
    `).join('')}
  `;
  document.getElementById('add-todo-btn').onclick = () => openTodoForm(members);

  document.querySelectorAll('.todo-check').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.id;
      const next = el.dataset.status === 'pending' ? 'complete' : 'pending';
      try { await api(`/api/todos/${id}`, { method: 'PATCH', body: { status: next } }); renderTodosTab(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.todo-fail').forEach((el) => {
    el.onclick = async () => {
      try { await api(`/api/todos/${el.dataset.id}`, { method: 'PATCH', body: { status: 'failed' } }); renderTodosTab(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.todo-highfive').forEach((el) => {
    el.onclick = async () => {
      try { await api(`/api/todos/${el.dataset.id}/high-five`, { method: 'POST' }); toast('🙌 High-fived!'); renderTodosTab(); } catch (err) { toast(err.message); }
    };
  });
}

function todoItemHtml(t) {
  const mine = t.assignedTo === state.user.id;
  const canHighFive = t.status === 'complete' && !mine && !(t.highFives || []).some((h) => h.fromUserId === state.user.id);
  return `<div class="todo-item ${t.status}">
    <div class="check todo-check" data-id="${t.id}" data-status="${t.status}" role="button" aria-label="${t.status === 'pending' ? 'Mark complete' : 'Mark pending'}">${t.status === 'complete' ? icon('check') : t.status === 'failed' ? icon('x') : ''}</div>
    <div style="flex:1">
      <div class="title">${esc(t.title)}</div>
      ${t.notes ? `<div class="meta">${esc(t.notes)}</div>` : ''}
      <div class="meta">${t.dueAt ? 'Due ' + fmtDateTime(t.dueAt) : ''}</div>
      ${(t.highFives || []).length ? `<div class="meta">🙌 ${t.highFives.map((h) => esc(h.fromUserName)).join(', ')}</div>` : ''}
    </div>
    <div class="hstack">
      ${t.status === 'pending' ? `<button class="btn btn-sm btn-bad todo-fail" data-id="${t.id}">Failed</button>` : ''}
      ${canHighFive ? `<button class="btn btn-sm todo-highfive" data-id="${t.id}">🙌</button>` : ''}
    </div>
  </div>`;
}

function openTodoForm(members) {
  openModal(`
    <div class="modal-head"><h3>New to-do</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="todo-form" class="stack">
      <div class="field"><label for="todo-title">Task</label>
        <div class="input-with-mic">
          <input id="todo-title" required placeholder="e.g. Pack swimming kit">
          ${micButtonHtml('todo-title-mic', 'Dictate task')}
        </div>
      </div>
      <div class="field"><label for="todo-notes">Notes</label><textarea id="todo-notes" placeholder="Optional"></textarea></div>
      <div class="field"><label for="todo-assignee">Assign to</label>
        <select id="todo-assignee">${members.map((m) => `<option value="${m.id}" ${m.id === state.user.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label for="todo-due">Due</label><input id="todo-due" type="datetime-local"></div>
      <div class="field">
        <label for="todo-reminder-hours">Remind</label>
        <select id="todo-reminder-hours">
          <option value="">No reminder</option>
          <option value="1">1 hour before</option>
          <option value="24">1 day before</option>
          <option value="72">3 days before</option>
        </select>
      </div>
      <div class="field"><label for="todo-reminder-channel">Reminder channel</label>
        <select id="todo-reminder-channel"><option value="app">In-app only</option><option value="sms">SMS only</option><option value="both">In-app + SMS</option></select>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Add to-do</button>
      <p class="error-text hidden" id="todo-error"></p>
    </form>
  `);
  attachDictation('todo-title-mic', document.getElementById('todo-title'));
  document.getElementById('todo-form').onsubmit = async (e) => {
    e.preventDefault();
    const due = document.getElementById('todo-due').value;
    const hours = document.getElementById('todo-reminder-hours').value;
    try {
      await api('/api/todos', {
        method: 'POST',
        body: {
          familyId: state.currentFamilyId,
          assignedTo: document.getElementById('todo-assignee').value,
          title: document.getElementById('todo-title').value.trim(),
          notes: document.getElementById('todo-notes').value.trim() || undefined,
          dueAt: due ? new Date(due).toISOString() : undefined,
          reminderOffsetHours: hours ? Number(hours) : undefined,
          reminderChannel: document.getElementById('todo-reminder-channel').value
        }
      });
      closeModal();
      renderTodosTab();
      toast('To-do added');
    } catch (err) {
      document.getElementById('todo-error').textContent = err.message;
      document.getElementById('todo-error').classList.remove('hidden');
    }
  };
}

/* =========================================================================
   Chat — family/group group chats, event chats, and 1:1 direct messages.
   Polling-based (no websockets): the open thread refetches every few
   seconds for anything newer than the last message it has.
   ========================================================================= */

let chatPollTimer = null;
let currentChatConversation = null;
let pendingChatConversationId = null;

function stopChatPolling() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  currentChatConversation = null;
}

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.round(hours / 24);
  if (days < 7) return days + 'd';
  return fmtDate(iso.slice(0, 10), { day: 'numeric', month: 'short' });
}

async function renderChatTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = loadingHtml();
  let conversations;
  try {
    ({ conversations } = await api('/api/conversations'));
  } catch (err) {
    root.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    return;
  }
  if (!conversations.length) {
    root.innerHTML = `<div class="empty-state card"><div class="big">${icon('chat', 22)}</div><h3>No chats yet</h3>
      <p>Every family and friend group gets an automatic group chat — switch to one from the header, or message someone directly from their family's member list.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="card stack" id="chat-list"></div>`;
  document.getElementById('chat-list').innerHTML = conversations.map(chatListItemHtml).join('<div class="divider" style="margin:2px 0"></div>');
  document.querySelectorAll('.chat-list-item').forEach((el) => {
    el.onclick = () => {
      const conv = conversations.find((c) => c.id === el.dataset.id);
      openChatDetail(conv);
    };
  });
}

function chatTypeLabel(type) {
  return { family: 'Family', group: 'Friend group', event: 'Event', direct: 'Direct' }[type] || '';
}

function chatListItemHtml(c) {
  const photo = c.type === 'direct'
    ? `<div class="avatar avatar-lg" style="background:${esc(c.otherUserColor || AVATAR_FALLBACK)}">${esc((c.title || '?')[0].toUpperCase())}</div>`
    : c.photoUrl
      ? `<img src="${esc(c.photoUrl)}" class="photo-avatar" alt="">`
      : `<div class="avatar avatar-lg" style="background:${AVATAR_FALLBACK}">${icon(c.type === 'event' ? 'chat' : 'users', 18)}</div>`;
  const preview = c.lastMessage
    ? `${c.lastMessage.senderId === state.user.id ? 'You: ' : ''}${c.lastMessage.hasMedia && !c.lastMessage.body ? '📷 Photo' : esc(c.lastMessage.body || '')}`
    : 'Say hello 👋';
  return `<div class="chat-list-item" data-id="${c.id}">
    ${photo}
    <div class="body">
      <div class="title-row"><strong>${esc(c.title)}</strong>${c.lastMessage ? `<time>${relativeTime(c.lastMessage.createdAt)}</time>` : ''}</div>
      <p class="preview">${preview}</p>
    </div>
  </div>`;
}

async function openChatDetail(conv) {
  stopChatPolling();
  currentChatConversation = conv;
  const root = document.getElementById('view-root');
  root.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="btn btn-icon-sm" id="chat-back" aria-label="Back to chats">${icon('chevronLeft', 16)}</button>
      <strong style="flex:1;text-align:center">${esc(conv.title)} <span class="chat-type-badge">${chatTypeLabel(conv.type)}</span></strong>
      <span style="width:32px"></span>
    </div>
    <div id="chat-detail" class="card" style="padding:10px">
      <div id="chat-messages">${loadingHtml()}</div>
      <div id="chat-input-bar">
        <button class="btn btn-icon-sm" id="chat-attach" aria-label="Attach a photo or video">${icon('camera', 16)}</button>
        <input type="text" id="chat-text" placeholder="Message…" aria-label="Message">
        ${micButtonHtml('chat-mic', 'Dictate reply')}
        <button class="btn btn-icon-sm btn-primary" id="chat-send" aria-label="Send">${icon('send', 15)}</button>
      </div>
    </div>
  `;
  document.getElementById('chat-back').onclick = () => { stopChatPolling(); renderChatTab(); };
  document.getElementById('chat-attach').onclick = () => { pendingChatConversationId = conv.id; document.getElementById('chat-file-input').click(); };
  document.getElementById('chat-send').onclick = () => sendChatMessage(conv.id);
  document.getElementById('chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(conv.id); }
  });
  attachDictation('chat-mic', document.getElementById('chat-text'));

  await loadChatMessages(conv.id, true);
  chatPollTimer = setInterval(() => loadChatMessages(conv.id, false), 4000);
}

let chatMessages = [];

async function loadChatMessages(conversationId, initial) {
  try {
    const after = initial ? '' : `?after=${encodeURIComponent(chatMessages.length ? chatMessages[chatMessages.length - 1].createdAt : '')}`;
    const { messages } = await api(`/api/conversations/${conversationId}/messages${after}`);
    if (initial) chatMessages = messages;
    else if (messages.length) chatMessages = chatMessages.concat(messages);
    else return;
    renderChatMessages();
  } catch (err) {
    if (initial) document.getElementById('chat-messages').innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const showSenderNames = currentChatConversation && currentChatConversation.type !== 'direct';
  el.innerHTML = chatMessages.length ? chatMessages.map((m) => {
    const mine = m.senderId === state.user.id;
    return `<div class="bubble-row ${mine ? 'mine' : ''}">
      ${showSenderNames && !mine ? `<span class="sender">${esc(m.senderName)}</span>` : ''}
      <div class="bubble">
        ${(m.media || []).map((med) => med.type === 'video' ? `<video src="${esc(med.url)}" controls></video>` : `<img src="${esc(med.url)}" alt="">`).join('')}
        ${m.body ? `<p>${esc(m.body)}</p>` : ''}
        <time>${fmtTime(m.createdAt)}</time>
      </div>
    </div>`;
  }).join('') : `<p class="muted" style="text-align:center;padding:20px 0">No messages yet — say hello 👋</p>`;
  if (wasNearBottom) el.scrollTop = el.scrollHeight;
}

async function sendChatMessage(conversationId, file) {
  const input = document.getElementById('chat-text');
  const body = input ? input.value.trim() : '';
  if (!body && !file) return;
  if (input) { input.value = ''; input.disabled = true; }
  try {
    const fd = new FormData();
    if (body) fd.append('body', body);
    if (file) fd.append('file', file);
    const { message } = await api(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: fd });
    chatMessages.push(message);
    renderChatMessages();
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  } catch (err) {
    toast(err.message);
  } finally {
    if (input) input.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chat-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && pendingChatConversationId) sendChatMessage(pendingChatConversationId, file);
  });
});

/* =========================================================================
   Requests — "call to action" (claimable asks) and general-purpose polls
   ========================================================================= */

function renderRequestsTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = `
    <div class="hstack" style="margin-bottom:14px">
      <button class="chip ${state.requestsTab === 'callouts' ? '' : 'off'}" id="req-tab-callouts">${icon('flag')} Call to action</button>
      <button class="chip ${state.requestsTab === 'polls' ? '' : 'off'}" id="req-tab-polls">${icon('poll')} Polls</button>
    </div>
    <div id="requests-content"></div>
  `;
  document.getElementById('req-tab-callouts').onclick = () => { state.requestsTab = 'callouts'; renderRequestsTab(); };
  document.getElementById('req-tab-polls').onclick = () => { state.requestsTab = 'polls'; renderRequestsTab(); };
  if (state.requestsTab === 'callouts') renderCallouts();
  else renderPolls();
}

const CALLOUT_STATUS_LABEL = { open: 'Open', accepted: 'Accepted', done: 'Done', cancelled: 'Cancelled' };

async function renderCallouts() {
  const el = document.getElementById('requests-content');
  el.innerHTML = loadingHtml();
  const familyId = state.currentFamilyId;
  const { callouts } = await api(`/api/callouts?familyId=${familyId}`);
  el.innerHTML = `
    <button class="btn btn-primary btn-block" id="new-callout-btn" style="margin-bottom:14px">${icon('plus', 16)} Post a call to action</button>
    ${callouts.length ? callouts.map(calloutCardHtml).join('') : `<div class="empty-state card"><div class="big">${icon('flag', 22)}</div><h3>No requests yet</h3><p>Need someone to grab something, or help with a job? Post it here — whoever's free can accept.</p></div>`}
  `;
  document.getElementById('new-callout-btn').onclick = () => openCalloutForm();
  document.querySelectorAll('.callout-accept').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/callouts/${btn.dataset.id}/accept`, { method: 'POST' }); toast('Accepted!'); renderCallouts(); }
      catch (err) { toast(err.message); renderCallouts(); }
    };
  });
  document.querySelectorAll('.callout-done').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/callouts/${btn.dataset.id}`, { method: 'PATCH', body: { status: 'done' } }); toast('Nice one!'); renderCallouts(); }
      catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.callout-release').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/callouts/${btn.dataset.id}`, { method: 'PATCH', body: { status: 'open' } }); toast('Released back to the group'); renderCallouts(); }
      catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.callout-cancel').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/callouts/${btn.dataset.id}`, { method: 'PATCH', body: { status: 'cancelled' } }); renderCallouts(); }
      catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.callout-delete').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this?')) return;
      try { await api(`/api/callouts/${btn.dataset.id}`, { method: 'DELETE' }); renderCallouts(); }
      catch (err) { toast(err.message); }
    };
  });
}

function calloutCardHtml(c) {
  const mine = c.createdBy === state.user.id;
  const acceptedByMe = c.acceptedBy === state.user.id;
  const badgeClass = c.status === 'open' ? 'badge-warn' : c.status === 'done' ? 'badge-good' : c.status === 'cancelled' ? '' : 'badge-good';
  let actions = '';
  if (c.status === 'open') {
    actions = `<button class="btn btn-primary btn-sm callout-accept" data-id="${c.id}">${icon('check', 13)} I'll do it</button>` +
      (mine ? `<button class="btn btn-sm btn-bad callout-cancel" data-id="${c.id}">Cancel</button>` : '');
  } else if (c.status === 'accepted' && acceptedByMe) {
    actions = `<button class="btn btn-good btn-sm callout-done" data-id="${c.id}">${icon('check', 13)} Mark done</button>` +
      `<button class="btn btn-sm callout-release" data-id="${c.id}">Can't do it</button>`;
  }
  if (mine && c.status !== 'accepted') {
    actions += `<button class="btn btn-icon-sm callout-delete" data-id="${c.id}" aria-label="Delete">${icon('trash', 13)}</button>`;
  }
  return `<div class="card">
    <div class="row" style="align-items:flex-start">
      <div>
        <strong>${esc(c.title)}</strong>
        <p class="muted">Asked by ${esc(c.createdByName)}${c.notes ? ' · ' + esc(c.notes) : ''}</p>
        ${c.acceptedByName ? `<p class="muted"><span class="badge ${badgeClass}">${CALLOUT_STATUS_LABEL[c.status]}</span> — ${esc(c.acceptedByName)}${acceptedByMe ? ' (you)' : ''}</p>` : `<span class="badge ${badgeClass}">${CALLOUT_STATUS_LABEL[c.status]}</span>`}
      </div>
    </div>
    <div class="hstack" style="margin-top:10px">${actions}</div>
  </div>`;
}

function openCalloutForm() {
  openModal(`
    <div class="modal-head"><h3>Post a call to action</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="callout-form" class="stack">
      <div class="field"><label for="co-title">What do you need?</label><input id="co-title" required placeholder="e.g. Grab bread on the way home"></div>
      <div class="field"><label for="co-notes">Notes</label><input id="co-notes" placeholder="Optional"></div>
      <label class="hstack"><input type="checkbox" id="co-notify" checked style="width:auto"> Text the family so they see it right away</label>
      ${!state.config.smsEnabled ? '<p class="muted">SMS isn\'t configured on this server yet — it\'ll still show up in the app.</p>' : ''}
      <button type="submit" class="btn btn-primary btn-block">Post it</button>
      <p class="error-text hidden" id="callout-error"></p>
    </form>
  `);
  document.getElementById('callout-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/callouts', {
        method: 'POST',
        body: {
          familyId: state.currentFamilyId,
          title: document.getElementById('co-title').value.trim(),
          notes: document.getElementById('co-notes').value.trim() || undefined,
          notify: document.getElementById('co-notify').checked
        }
      });
      closeModal();
      renderCallouts();
      toast('Posted!');
    } catch (err) {
      document.getElementById('callout-error').textContent = err.message;
      document.getElementById('callout-error').classList.remove('hidden');
    }
  };
}

async function renderPolls() {
  const el = document.getElementById('requests-content');
  el.innerHTML = loadingHtml();
  const familyId = state.currentFamilyId;
  const { polls } = await api(`/api/polls?familyId=${familyId}`);
  el.innerHTML = `
    <button class="btn btn-primary btn-block" id="new-poll-btn" style="margin-bottom:14px">${icon('plus', 16)} Create a poll</button>
    ${polls.length ? polls.map(pollCardHtml).join('') : `<div class="empty-state card"><div class="big">${icon('poll', 22)}</div><h3>No polls yet</h3><p>Ask the group to vote on something — a night out, a destination, anything with a few options.</p></div>`}
  `;
  document.getElementById('new-poll-btn').onclick = () => openPollForm();
  document.querySelectorAll('.poll-option-row').forEach((row) => {
    row.onclick = async () => {
      try { await api(`/api/polls/${row.dataset.poll}/vote`, { method: 'POST', body: { optionId: row.dataset.option } }); renderPolls(); }
      catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.poll-delete').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this poll?')) return;
      try { await api(`/api/polls/${btn.dataset.id}`, { method: 'DELETE' }); renderPolls(); }
      catch (err) { toast(err.message); }
    };
  });
}

function pollCardHtml(p) {
  const mine = p.createdBy === state.user.id;
  const maxVotes = Math.max(1, ...p.options.map((o) => o.voters.length));
  return `<div class="card">
    <div class="row" style="align-items:flex-start;margin-bottom:8px">
      <div><strong>${esc(p.question)}</strong><p class="muted">Asked by ${esc(p.createdByName)} · ${p.totalVotes} vote${p.totalVotes === 1 ? '' : 's'}</p></div>
      ${mine ? `<button class="btn btn-icon-sm poll-delete" data-id="${p.id}" aria-label="Delete poll">${icon('trash', 13)}</button>` : ''}
    </div>
    <div class="stack" style="gap:6px">
      ${p.options.map((o) => {
        const pct = Math.round((o.voters.length / maxVotes) * 100);
        const mine2 = p.myVote === o.id;
        return `<div class="poll-option-row ${mine2 ? 'on' : ''}" data-poll="${p.id}" data-option="${o.id}" style="position:relative;overflow:hidden">
          <div style="position:absolute;inset:0;background:var(--brand-soft);width:${pct}%;z-index:0"></div>
          <span style="position:relative;z-index:1">${esc(o.label)}</span>
          <span style="position:relative;z-index:1" class="hstack">
            <span class="avatar-stack">${o.voters.slice(0, 4).map((v) => avatarHtml(v)).join('')}</span>
            <strong>${o.voters.length}</strong>
          </span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function openPollForm() {
  let optionCount = 2;
  openModal(`
    <div class="modal-head"><h3>Create a poll</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="poll-form" class="stack">
      <div class="field"><label for="poll-question">Question</label><input id="poll-question" required placeholder="e.g. Spain or Portugal for the summer trip?"></div>
      <div class="field"><label>Options</label>
        <div class="stack" id="poll-options" style="gap:6px">
          <input class="poll-option-input" placeholder="Option 1" required>
          <input class="poll-option-input" placeholder="Option 2" required>
        </div>
        <button type="button" class="btn btn-sm" id="poll-add-option" style="margin-top:8px">${icon('plus', 13)} Add option</button>
      </div>
      <label class="hstack"><input type="checkbox" id="poll-notify" checked style="width:auto"> Text the family so they see it right away</label>
      ${!state.config.smsEnabled ? '<p class="muted">SMS isn\'t configured on this server yet — it\'ll still show up in the app.</p>' : ''}
      <button type="submit" class="btn btn-primary btn-block">Create poll</button>
      <p class="error-text hidden" id="poll-error"></p>
    </form>
  `);
  document.getElementById('poll-add-option').onclick = () => {
    if (optionCount >= 6) return;
    optionCount++;
    const input = document.createElement('input');
    input.className = 'poll-option-input';
    input.placeholder = `Option ${optionCount}`;
    document.getElementById('poll-options').appendChild(input);
  };
  document.getElementById('poll-form').onsubmit = async (e) => {
    e.preventDefault();
    const options = Array.from(document.querySelectorAll('.poll-option-input')).map((i) => i.value.trim()).filter(Boolean);
    try {
      await api('/api/polls', {
        method: 'POST',
        body: { familyId: state.currentFamilyId, question: document.getElementById('poll-question').value.trim(), options, notify: document.getElementById('poll-notify').checked }
      });
      closeModal();
      renderPolls();
      toast('Poll created');
    } catch (err) {
      document.getElementById('poll-error').textContent = err.message;
      document.getElementById('poll-error').classList.remove('hidden');
    }
  };
}

/* =========================================================================
   Food: Dinner plan / Recipes / Shopping list
   ========================================================================= */

function renderFoodTab() {
  const root = document.getElementById('view-root');
  root.innerHTML = `
    <div class="hstack" style="margin-bottom:14px">
      <button class="chip ${state.foodTab === 'dinner' ? '' : 'off'}" id="food-tab-dinner">${icon('utensils')} Dinner plan</button>
      <button class="chip ${state.foodTab === 'recipes' ? '' : 'off'}" id="food-tab-recipes">${icon('book')} Recipes</button>
      <button class="chip ${state.foodTab === 'shopping' ? '' : 'off'}" id="food-tab-shopping">${icon('cart')} Shopping list</button>
    </div>
    <div id="food-content"></div>
  `;
  document.getElementById('food-tab-dinner').onclick = () => { state.foodTab = 'dinner'; renderFoodTab(); };
  document.getElementById('food-tab-recipes').onclick = () => { state.foodTab = 'recipes'; renderFoodTab(); };
  document.getElementById('food-tab-shopping').onclick = () => { state.foodTab = 'shopping'; renderFoodTab(); };
  if (state.foodTab === 'dinner') renderDinnerPlan();
  else if (state.foodTab === 'recipes') renderRecipes();
  else renderShoppingList();
}

function weekPickerHtml() {
  return `<div class="row card-tight card">
    <button class="btn btn-icon-sm" id="week-prev" aria-label="Previous week">${icon('chevronLeft', 16)}</button>
    <strong>Week of ${fmtDate(state.weekStart, { day: 'numeric', month: 'long' })}</strong>
    <button class="btn btn-icon-sm" id="week-next" aria-label="Next week">${icon('chevronRight', 16)}</button>
  </div>`;
}
function bindWeekPicker(onChange) {
  document.getElementById('week-prev').onclick = () => { state.weekStart = addDays(state.weekStart, -7); onChange(); };
  document.getElementById('week-next').onclick = () => { state.weekStart = addDays(state.weekStart, 7); onChange(); };
}

async function renderDinnerPlan() {
  const el = document.getElementById('food-content');
  el.innerHTML = weekPickerHtml() + loadingHtml();
  bindWeekPicker(renderDinnerPlan);

  const familyId = state.currentFamilyId;
  const weekStart = state.weekStart;
  const { polls } = await api(`/api/dinner-polls?familyId=${familyId}&weekStart=${weekStart}`);
  const poll = polls[0];
  const { days: mealDays } = await api(`/api/weekly-meal-days?familyId=${familyId}&weekStart=${weekStart}`);
  const mealByDay = {};
  for (const d of mealDays) mealByDay[d.day] = d;

  let planHtml = '';
  let myRow = '';
  if (poll) {
    const plan = (await api(`/api/dinner-polls/${poll.id}/plan`)).plan;
    planHtml = `<div class="week-table">${plan.map((p) => `
      <div class="col">
        <div class="day-label">${DAY_LABELS[p.day]}</div>
        <div>${p.inFor.map((u) => avatarHtml(u)).join('') || '<span class="muted">—</span>'}</div>
        <div class="muted" style="font-size:13px;margin-top:4px">${mealByDay[p.day] ? esc(mealByDay[p.day].recipeTitle || '') : ''}</div>
        <button class="btn btn-icon-sm" style="margin-top:4px" data-assign-day="${p.day}" aria-label="Assign a recipe to ${DAY_LABELS_FULL[p.day]}">${icon('pot', 15)}</button>
      </div>`).join('')}</div>`;

    const me = poll.recipients.find((r) => r.userId === state.user.id);
    if (me) {
      myRow = `
        <div class="section-title">Your nights in</div>
        <div class="card">
          <p class="muted">Tap the nights you're in for dinner this week.</p>
          <div class="day-toggle-list">
            ${DAYS.map((d) => `<div class="day-toggle-row ${me.days[d] ? 'on' : ''}" data-day="${d}"><span>${DAY_LABELS_FULL[d]}</span><span>${me.days[d] ? icon('check', 15) : ''}</span></div>`).join('')}
          </div>
        </div>`;
    }
  }

  el.innerHTML = weekPickerHtml() + `
    ${poll ? '' : `<button class="btn btn-primary btn-block" style="margin:12px 0" id="ask-week-btn">Ask everyone who's in this week</button>`}
    ${planHtml ? `<div class="section-title">This week's plan</div><div class="card">${planHtml}</div>` : ''}
    ${myRow}
  `;
  bindWeekPicker(renderDinnerPlan);

  if (!poll) {
    document.getElementById('ask-week-btn').onclick = async () => {
      try {
        await api('/api/dinner-polls', { method: 'POST', body: { familyId, weekStart } });
        toast(state.config.smsEnabled ? 'Sent! Everyone will get a text.' : 'Poll created (set up SMS to text everyone automatically).');
        renderDinnerPlan();
      } catch (err) { toast(err.message); }
    };
    return;
  }

  document.querySelectorAll('.day-toggle-row').forEach((row) => {
    row.onclick = async () => {
      const me = poll.recipients.find((r) => r.userId === state.user.id);
      if (!me) return;
      const days = DAYS.filter((d) => (d === row.dataset.day ? !me.days[d] : me.days[d]));
      try {
        await api(`/api/dinner-response/${me.token}`, { method: 'POST', body: { days } });
        renderDinnerPlan();
      } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('[data-assign-day]').forEach((btn) => {
    btn.onclick = () => openAssignRecipeModal(btn.dataset.assignDay, mealByDay[btn.dataset.assignDay]);
  });
}

async function openAssignRecipeModal(day) {
  const { recipes } = await api(`/api/recipes?familyId=${state.currentFamilyId}`);
  openModal(`
    <div class="modal-head"><h3>${DAY_LABELS_FULL[day]}'s meal</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <div class="stack">
      ${recipes.length ? recipes.map((r) => `<button class="btn btn-block" data-recipe="${r.id}">${esc(r.title)}</button>`).join('') : `<p class="muted">No saved recipes yet — add one from the Recipes tab first.</p>`}
      <button class="btn btn-bad btn-block" data-recipe="">Clear this day</button>
    </div>
  `);
  document.querySelectorAll('[data-recipe]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api('/api/weekly-meal-days', { method: 'PUT', body: { familyId: state.currentFamilyId, weekStart: state.weekStart, day, recipeId: btn.dataset.recipe || null } });
        closeModal();
        renderDinnerPlan();
      } catch (err) { toast(err.message); }
    };
  });
}

async function renderRecipes() {
  const el = document.getElementById('food-content');
  el.innerHTML = loadingHtml();
  const { recipes } = await api(`/api/recipes?familyId=${state.currentFamilyId}`);
  el.innerHTML = `
    <div class="hstack" style="margin-bottom:12px">
      <button class="btn btn-primary" id="gen-recipe-btn">✨ Generate with AI</button>
      <button class="btn" id="add-recipe-btn">${icon('plus', 16)} Add manually / link</button>
    </div>
    ${recipes.length ? recipes.map(recipeCardHtml).join('') : `<p class="muted">No recipes saved yet.</p>`}
  `;
  document.getElementById('gen-recipe-btn').onclick = openGenerateRecipeModal;
  document.getElementById('add-recipe-btn').onclick = () => openRecipeForm();
  document.querySelectorAll('.recipe-like').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/recipes/${btn.dataset.id}`, { method: 'PATCH', body: { liked: btn.dataset.liked !== 'true' } }); renderRecipes(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.recipe-delete').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this recipe?')) return;
      try { await api(`/api/recipes/${btn.dataset.id}`, { method: 'DELETE' }); renderRecipes(); } catch (err) { toast(err.message); }
    };
  });
}

function recipeCardHtml(r) {
  return `<div class="card">
    <div class="row">
      <div><strong>${esc(r.title)}</strong><p class="muted">${r.servings ? r.servings + ' servings · ' : ''}${r.sourceType === 'ai' ? '✨ AI generated' : r.sourceType === 'link' ? '🔗 saved link' : 'Your recipe'}</p></div>
      <button class="btn btn-sm recipe-like" data-id="${r.id}" data-liked="${r.liked}">${r.liked ? '❤️' : '🤍'}</button>
    </div>
    ${r.sourceUrl ? `<p><a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${esc(r.sourceUrl)}</a></p>` : ''}
    ${r.ingredients.length ? `<p class="muted">${r.ingredients.map((i) => esc(i.item)).join(', ')}</p>` : ''}
    <div class="hstack" style="margin-top:8px"><button class="btn btn-sm btn-bad recipe-delete" data-id="${r.id}" aria-label="Delete ${esc(r.title)}">${icon('trash', 14)} Delete</button></div>
  </div>`;
}

function openGenerateRecipeModal() {
  if (!state.config.recipeGenerationEnabled) {
    openModal(`<div class="modal-head"><h3>AI recipes</h3><button onclick="closeModal()">${icon('x')}</button></div><p class="muted">AI recipe generation isn't configured on this server yet (needs an ANTHROPIC_API_KEY).</p>`);
    return;
  }
  openModal(`
    <div class="modal-head"><h3>Generate a recipe</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <div class="field"><label for="gen-prompt">Describe what you want to cook</label><textarea id="gen-prompt" placeholder="e.g. chicken thigh recipe for 4 people with a tomato sauce"></textarea></div>
    <button class="btn btn-primary btn-block" id="gen-btn">Generate</button>
    <div id="gen-result" style="margin-top:14px"></div>
    <p class="error-text hidden" id="gen-error"></p>
  `);
  document.getElementById('gen-btn').onclick = async () => {
    const prompt = document.getElementById('gen-prompt').value.trim();
    if (!prompt) return;
    const btn = document.getElementById('gen-btn');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    try {
      const { recipe } = await api('/api/recipes/generate', { method: 'POST', body: { prompt } });
      document.getElementById('gen-result').innerHTML = `
        <div class="card">
          <strong>${esc(recipe.title)}</strong>
          <p class="muted">${recipe.servings ? recipe.servings + ' servings' : ''}${recipe.minutes ? ' · ' + recipe.minutes + ' min' : ''}</p>
          <p class="muted">${(recipe.ingredients || []).map((i) => esc([i.quantity, i.unit, i.item].filter(Boolean).join(' '))).join(', ')}</p>
          <pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;color:var(--ink-soft)">${esc(recipe.instructions)}</pre>
          <button class="btn btn-primary btn-block" id="save-gen-btn">Save this recipe</button>
        </div>`;
      document.getElementById('save-gen-btn').onclick = async () => {
        try {
          await api('/api/recipes', { method: 'POST', body: { familyId: state.currentFamilyId, title: recipe.title, servings: recipe.servings, ingredients: recipe.ingredients, instructions: recipe.instructions, sourceType: 'ai' } });
          closeModal();
          renderRecipes();
          toast('Recipe saved');
        } catch (err) { toast(err.message); }
      };
    } catch (err) {
      document.getElementById('gen-error').textContent = err.message;
      document.getElementById('gen-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate';
    }
  };
}

function openRecipeForm() {
  openModal(`
    <div class="modal-head"><h3>Add a recipe</h3><button onclick="closeModal()">${icon('x')}</button></div>
    <form id="recipe-form" class="stack">
      <div class="field"><label for="rcp-title">Title</label><input id="rcp-title" required></div>
      <div class="field"><label for="rcp-servings">Servings</label><input id="rcp-servings" type="number" min="1"></div>
      <div class="field"><label for="rcp-url">Link (optional — if this is a recipe from elsewhere)</label><input id="rcp-url" type="url" placeholder="https://…"></div>
      <div class="field">
        <label for="rcp-ingredients">Ingredients (one per line — e.g. "400g chicken thighs")</label>
        <textarea id="rcp-ingredients" placeholder="400g chicken thighs&#10;1 tin chopped tomatoes"></textarea>
      </div>
      <div class="field"><label for="rcp-instructions">Instructions</label><textarea id="rcp-instructions"></textarea></div>
      <button type="submit" class="btn btn-primary btn-block">Save recipe</button>
      <p class="error-text hidden" id="recipe-error"></p>
    </form>
  `);
  document.getElementById('recipe-form').onsubmit = async (e) => {
    e.preventDefault();
    const lines = document.getElementById('rcp-ingredients').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const ingredients = lines.map((line) => {
      const match = line.match(/^([\d.\/]+\s*\w*)\s+(.+)$/);
      return match ? { quantity: match[1], unit: '', item: match[2] } : { quantity: '', unit: '', item: line };
    });
    const url = document.getElementById('rcp-url').value.trim();
    try {
      await api('/api/recipes', {
        method: 'POST',
        body: {
          familyId: state.currentFamilyId,
          title: document.getElementById('rcp-title').value.trim(),
          servings: Number(document.getElementById('rcp-servings').value) || undefined,
          ingredients, instructions: document.getElementById('rcp-instructions').value.trim() || undefined,
          sourceType: url ? 'link' : 'manual', sourceUrl: url || undefined
        }
      });
      closeModal();
      renderRecipes();
      toast('Recipe saved');
    } catch (err) {
      document.getElementById('recipe-error').textContent = err.message;
      document.getElementById('recipe-error').classList.remove('hidden');
    }
  };
}

async function renderShoppingList() {
  const el = document.getElementById('food-content');
  el.innerHTML = weekPickerHtml() + loadingHtml();
  bindWeekPicker(renderShoppingList);

  const familyId = state.currentFamilyId;
  const weekStart = state.weekStart;
  const { items } = await api(`/api/shopping-list?familyId=${familyId}&weekStart=${weekStart}`);

  el.innerHTML = weekPickerHtml() + `
    <button class="btn btn-primary btn-block" style="margin:12px 0" id="gen-shopping-btn">${items.length ? 'Refresh from this week\'s meals' : 'Generate shopping list from this week\'s meals'}</button>
    ${items.length ? `<div class="card stack">${items.map(shoppingItemHtml).join('')}</div>` : `<p class="muted">No list yet — assign recipes to days in the Dinner plan tab first, then generate.</p>`}
  `;
  bindWeekPicker(renderShoppingList);
  document.getElementById('gen-shopping-btn').onclick = async () => {
    try { await api('/api/shopping-list/generate', { method: 'POST', body: { familyId, weekStart } }); renderShoppingList(); toast('Shopping list updated'); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('.shop-check').forEach((cb) => {
    cb.onchange = async () => {
      try { await api(`/api/shopping-list/${cb.dataset.id}`, { method: 'PATCH', body: { checked: cb.checked } }); } catch (err) { toast(err.message); }
    };
  });
}
function shoppingItemHtml(i) {
  return `<label class="row" style="opacity:${i.checked ? '.5' : '1'}">
    <span style="${i.checked ? 'text-decoration:line-through' : ''}"><strong>${esc(i.ingredient)}</strong>${i.quantity ? ' — ' + esc(i.quantity) : ''}<br><span class="muted" style="font-size:13px">Needed ${i.dayLabels.join(', ')}</span></span>
    <input type="checkbox" class="shop-check" data-id="${i.id}" ${i.checked ? 'checked' : ''} style="width:20px;height:20px">
  </label>`;
}

/* =========================================================================
   Public (no-login) pages: dinner response + meal rating
   ========================================================================= */

async function bootPublicDinner(token) {
  const screen = document.getElementById('public-screen');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-root').classList.add('hidden');
  screen.classList.remove('hidden');
  screen.innerHTML = `<div class="card">${loadingHtml()}</div>`;
  try {
    const data = await fetch(`/api/dinner-response/${token}`).then((r) => { if (!r.ok) throw new Error('This link is not valid or has expired.'); return r.json(); });
    let selected = new Set(DAYS.filter((d) => data.days[d]));
    function render() {
      screen.innerHTML = `<div class="card">
        <h2>Hi ${esc(data.user.name)} 👋</h2>
        <p class="muted">Which nights are you in for dinner the week of ${fmtDate(data.weekStart, { day: 'numeric', month: 'long' })}?</p>
        <div class="day-toggle-list">
          ${DAYS.map((d) => `<div class="day-toggle-row ${selected.has(d) ? 'on' : ''}" data-day="${d}"><span>${DAY_LABELS_FULL[d]}</span><span>${selected.has(d) ? icon('check', 15) : ''}</span></div>`).join('')}
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:14px" id="submit-days">Save</button>
        <p class="muted" id="saved-msg" style="text-align:center;margin-top:8px"></p>
      </div>`;
      screen.querySelectorAll('.day-toggle-row').forEach((row) => {
        row.onclick = () => { selected.has(row.dataset.day) ? selected.delete(row.dataset.day) : selected.add(row.dataset.day); render(); };
      });
      document.getElementById('submit-days').onclick = async () => {
        await fetch(`/api/dinner-response/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: Array.from(selected) }) });
        document.getElementById('saved-msg').textContent = 'Saved — thanks!';
      };
    }
    render();
  } catch (err) {
    screen.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

async function bootPublicRating(token) {
  const screen = document.getElementById('public-screen');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-root').classList.add('hidden');
  screen.classList.remove('hidden');
  screen.innerHTML = `<div class="card">${loadingHtml()}</div>`;
  try {
    const data = await fetch(`/api/meal-rating/${token}`).then((r) => { if (!r.ok) throw new Error('This link is not valid or has expired.'); return r.json(); });
    const options = [
      { value: 'delicious', label: '😋 Delicious' },
      { value: 'edible', label: '🙂 Edible' },
      { value: 'takeaway_next_time', label: '📦 Takeaway next time please' }
    ];
    screen.innerHTML = `<div class="card">
      <h2>How was ${data.recipeTitle ? esc(data.recipeTitle) : 'dinner'}?</h2>
      <p class="muted">${data.dayLabel} night's meal</p>
      <div class="rating-options">
        ${options.map((o) => `<div class="rating-option ${data.rating === o.value ? 'selected' : ''}" data-value="${o.value}">${o.label}</div>`).join('')}
      </div>
      <p class="muted" id="rate-msg" style="text-align:center;margin-top:8px">${data.respondedAt ? 'Thanks, you already voted — tap to change.' : ''}</p>
    </div>`;
    screen.querySelectorAll('.rating-option').forEach((opt) => {
      opt.onclick = async () => {
        await fetch(`/api/meal-rating/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: opt.dataset.value }) });
        screen.querySelectorAll('.rating-option').forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        document.getElementById('rate-msg').textContent = 'Thanks for voting! 🎉';
      };
    });
  } catch (err) {
    screen.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

async function bootPublicCallout(token) {
  const screen = document.getElementById('public-screen');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-root').classList.add('hidden');
  screen.classList.remove('hidden');
  screen.innerHTML = `<div class="card">${loadingHtml()}</div>`;
  function render(data) {
    const c = data.callout;
    screen.innerHTML = `<div class="card">
      <h2>${esc(c.createdByName)} is asking…</h2>
      <p class="muted" style="font-size:16px;color:var(--ink);font-weight:600">${esc(c.title)}</p>
      ${c.notes ? `<p class="muted">${esc(c.notes)}</p>` : ''}
      ${c.status === 'open'
        ? `<button class="btn btn-primary btn-block" id="callout-accept-btn" style="margin-top:14px">${icon('check', 15)} I'll do it</button>`
        : `<p class="muted" style="text-align:center;margin-top:14px">${c.acceptedByName ? esc(c.acceptedByName) + ' has this one — thanks!' : 'This is no longer open.'}</p>`}
    </div>`;
    const btn = document.getElementById('callout-accept-btn');
    if (btn) btn.onclick = async () => {
      const res = await fetch(`/api/callout-response/${token}`, { method: 'POST' });
      const result = await res.json();
      render(result);
      if (res.ok) toast("You're on it!");
    };
  }
  try {
    const res = await fetch(`/api/callout-response/${token}`);
    if (!res.ok) throw new Error('This link is not valid or has expired.');
    render(await res.json());
  } catch (err) {
    screen.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

async function bootPublicPoll(token) {
  const screen = document.getElementById('public-screen');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-root').classList.add('hidden');
  screen.classList.remove('hidden');
  screen.innerHTML = `<div class="card">${loadingHtml()}</div>`;
  function render(data) {
    const p = data.poll;
    screen.innerHTML = `<div class="card">
      <h2>Hi ${esc(data.user.name)} 👋</h2>
      <p class="muted" style="font-size:16px;color:var(--ink);font-weight:600">${esc(p.question)}</p>
      <div class="rating-options" style="margin-top:10px">
        ${p.options.map((o) => `<div class="rating-option poll-public-option ${p.myVote === o.id ? 'selected' : ''}" data-option="${o.id}">${esc(o.label)} <span class="muted">(${o.voters.length})</span></div>`).join('')}
      </div>
      <p class="muted" style="text-align:center;margin-top:8px" id="poll-public-msg">${p.myVote ? 'Thanks for voting — tap to change.' : ''}</p>
    </div>`;
    screen.querySelectorAll('.poll-public-option').forEach((opt) => {
      opt.onclick = async () => {
        const res = await fetch(`/api/poll-response/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionId: opt.dataset.option }) });
        const result = await res.json();
        if (res.ok) render({ poll: result.poll, user: data.user });
      };
    });
  }
  try {
    const res = await fetch(`/api/poll-response/${token}`);
    if (!res.ok) throw new Error('This link is not valid or has expired.');
    render(await res.json());
  } catch (err) {
    screen.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

/* =========================================================================
   Go
   ========================================================================= */

bindAuthScreen();
boot();
