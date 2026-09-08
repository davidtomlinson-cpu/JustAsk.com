'use strict';

/* =========================================================================
   The Memory Maker — frontend
   Plain JS single-page app, no build step: fetch() against the JSON API,
   template-literal rendering, event delegation after each render. Kept in
   one file on purpose — this is a small app, and a build step would be
   pure overhead for it.
   ========================================================================= */

const AVATAR_FALLBACK = '#b25545';
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
  utensils: '<path d="M7 3v6.5a1.8 1.8 0 0 0 1.8 1.8H8a1.8 1.8 0 0 0 1.8-1.8V3"/><path d="M8.4 11.3V21"/><path d="M15.5 3c-1.4 0-2.5 1.7-2.5 3.8 0 1.7.8 3.2 2 3.7V21"/>'
};
function icon(name, size, cls) {
  size = size || 18;
  return `<svg class="i ${cls || ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
function loadingHtml(msg) { return `<div class="loading-row"><div class="spinner"></div><span>${esc(msg || 'Loading…')}</span></div>`; }

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
  if (dinnerMatch) return bootPublicDinner(dinnerMatch[1]);
  if (rateMatch) return bootPublicRating(rateMatch[1]);

  if (!state.token) return showAuthScreen();

  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
  } catch (e) {
    localStorage.removeItem('mm_token');
    state.token = null;
    return showAuthScreen();
  }

  try { state.config = await api('/api/config'); } catch (e) { /* defaults are fine */ }
  await loadFamiliesAndGroups();
  showApp();
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
      if (!state.families.length) {
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
      <button class="btn btn-block" onclick="openFamilyManager()">Manage families &amp; friend groups</button>
      <button class="btn btn-bad btn-block" id="profile-logout">Log out</button>
    </div>
  `);
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

function openFamilyManager(introMessage) {
  openModal(`
    <div class="modal-head"><h3>Families &amp; friend groups</h3><button onclick="closeModal()">${icon('x')}</button></div>
    ${introMessage ? `<p class="muted">${esc(introMessage)}</p>` : ''}
    <div class="section-title">Your families</div>
    <div class="stack" id="fam-list">${state.families.map(famRow).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="hstack">
      <input id="new-fam-name" placeholder="New family name" aria-label="New family name" style="flex:1">
      <button class="btn btn-primary" id="create-fam-btn">Create</button>
    </div>
    <div class="hstack" style="margin-top:8px">
      <input id="join-fam-code" placeholder="Join code" aria-label="Family join code" style="flex:1">
      <button class="btn" id="join-fam-btn">Join</button>
    </div>

    <div class="section-title">Your friend groups</div>
    <div class="stack" id="grp-list">${state.groups.map(grpRow).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="hstack">
      <input id="new-grp-name" placeholder="New group name" aria-label="New friend group name" style="flex:1">
      <button class="btn btn-primary" id="create-grp-btn">Create</button>
    </div>
    <div class="hstack" style="margin-top:8px">
      <input id="join-grp-code" placeholder="Join code" aria-label="Friend group join code" style="flex:1">
      <button class="btn" id="join-grp-btn">Join</button>
    </div>
  `);
  function famRow(f) { return `<div class="row card-tight card"><div><strong>${esc(f.name)}</strong><p class="muted">Join code: <b>${esc(f.joinCode)}</b></p></div></div>`; }
  function grpRow(g) { return `<div class="row card-tight card"><div><strong>${esc(g.name)}</strong><p class="muted">Join code: <b>${esc(g.joinCode)}</b></p></div></div>`; }

  document.getElementById('create-fam-btn').onclick = async () => {
    const name = document.getElementById('new-fam-name').value.trim();
    if (!name) return;
    try {
      await api('/api/families', { method: 'POST', body: { name } });
      await loadFamiliesAndGroups();
      renderHeader();
      openFamilyManager();
      toast('Family created');
    } catch (err) { toast(err.message); }
  };
  document.getElementById('join-fam-btn').onclick = async () => {
    const joinCode = document.getElementById('join-fam-code').value.trim();
    if (!joinCode) return;
    try {
      await api('/api/families/join', { method: 'POST', body: { joinCode } });
      await loadFamiliesAndGroups();
      renderHeader();
      openFamilyManager();
      toast('Joined family');
    } catch (err) { toast(err.message); }
  };
  document.getElementById('create-grp-btn').onclick = async () => {
    const name = document.getElementById('new-grp-name').value.trim();
    if (!name) return;
    try {
      await api('/api/groups', { method: 'POST', body: { name } });
      await loadFamiliesAndGroups();
      openFamilyManager();
      toast('Friend group created');
    } catch (err) { toast(err.message); }
  };
  document.getElementById('join-grp-btn').onclick = async () => {
    const joinCode = document.getElementById('join-grp-code').value.trim();
    if (!joinCode) return;
    try {
      await api('/api/groups/join', { method: 'POST', body: { joinCode } });
      await loadFamiliesAndGroups();
      openFamilyManager();
      toast('Joined friend group');
    } catch (err) { toast(err.message); }
  };
}

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
  if (!currentFamily() && state.tab !== 'today') {
    root.innerHTML = noFamilyState();
    return;
  }
  switch (state.tab) {
    case 'today': return renderToday();
    case 'calendar': return renderCalendarTab();
    case 'memories': return renderMemoriesTab();
    case 'todos': return renderTodosTab();
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
  const [calRes, memRes] = await Promise.all([
    api(`/api/calendar?from=${date}&to=${date}`),
    api(`/api/memories?familyId=${familyId}&date=${date}`)
  ]);
  const events = calRes.events;
  const memories = memRes.memories;
  const allMedia = memories.flatMap((m) => m.media);

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

    <div class="section-title">Today's memories</div>
    ${allMedia.length
      ? `<div class="card"><div class="media-grid">${allMedia.map(mediaTileHtml).join('')}</div></div>`
      : `<p class="muted">No photos or videos yet — tap the camera above to start.</p>`}
  `;
  document.getElementById('today-camera').onclick = () => openCameraFor(date);
  document.getElementById('today-gallery').onclick = () => openGalleryFor(date);
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
      ${events.length ? events.map((ev) => `
        <div class="row" style="align-items:flex-start">
          <div>
            <strong>${occasionEmoji(ev.occasionType)} ${esc(ev.title)}</strong>
            <p class="muted">${ev.allDay ? 'All day' : fmtTime(ev.startsAt) + '–' + fmtTime(ev.endsAt)}${ev.location ? ' · ' + esc(ev.location) : ''}</p>
            <div class="avatar-stack">${(ev.attendees || []).map((a) => avatarHtml(a)).join('')}</div>
          </div>
          <button class="btn btn-sm btn-bad" onclick="deleteEvent('${ev.id}')" aria-label="Delete ${esc(ev.title)}">${icon('trash', 14)}</button>
        </div>`).join('<div class="divider"></div>')
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
      <div class="field"><label for="todo-title">Task</label><input id="todo-title" required placeholder="e.g. Pack swimming kit"></div>
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
        <div class="muted" style="font-size:11px;margin-top:4px">${mealByDay[p.day] ? esc(mealByDay[p.day].recipeTitle || '') : ''}</div>
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
          <pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:var(--ink-soft)">${esc(recipe.instructions)}</pre>
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
    <span style="${i.checked ? 'text-decoration:line-through' : ''}"><strong>${esc(i.ingredient)}</strong>${i.quantity ? ' — ' + esc(i.quantity) : ''}<br><span class="muted" style="font-size:11px">Needed ${i.dayLabels.join(', ')}</span></span>
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

/* =========================================================================
   Go
   ========================================================================= */

bindAuthScreen();
boot();
