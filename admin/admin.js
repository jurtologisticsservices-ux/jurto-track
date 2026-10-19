// JURTO Ops Console. Plain JS on Supabase; every read and write goes through the admin row-level-security
// rules in the database, so only accounts in admin_users can see or change anything.
'use strict';

const SB_URL = 'https://nflgbrdrtsrdvqrjcwmh.supabase.co';
const SB_KEY = 'sb_publishable_yq-Sc5bxBlcS73lDfZpmlg_RMtybD3m';
const TRACK_BASE = 'https://jurtologisticsservices-ux.github.io/jurto-track/';
const CHENNAI = [13.0827, 80.2707];
// Read the email-link result before the Supabase client tidies the address bar.
const LINK = new URLSearchParams(location.hash.replace(/^#/, ''));
const RECOVERY = LINK.get('type') === 'recovery';
const LINK_ERROR = LINK.get('error_description');
const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v ?? 0) || 0;
const rupees = (v) => '₹' + Math.round(num(v)).toLocaleString('en-IN');
const rupees2 = (v) => '₹' + num(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const shortId = (id) => String(id || '').slice(0, 8).toUpperCase();
const name = (p) => (p ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() : '') || '—';
const initial = (p) => (name(p).trim()[0] || 'J').toUpperCase();
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
const STATUS = { pending: 'Finding driver', scheduled: 'Scheduled', accepted: 'Driver assigned', in_transit: 'In transit', completed: 'Delivered', cancelled: 'Cancelled' };
const chip = (st, label) => `<span class="chip ${esc(st)}">${esc(label ?? STATUS[st] ?? st)}</span>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message || String(error));
  return data;
}

/* ---------------- state ---------------- */
const S = { user: null, admin: null, route: 'dashboard', dash: null, vtypes: {}, channel: null, live: false, maps: [], charts: [], cleanup: [] };

/* ---------------- toasts / modal / drawer ---------------- */
function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = msg;
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}
const fail = (e) => toast('⚠️ ' + esc(e?.message || e), 'bad');

function ensureOverlay() {
  if ($('#scrim')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer"><div class="dh"><h3 id="dtitle"></h3><span id="dhead"></span><button class="x" id="dclose" aria-label="Close">×</button></div><div class="db" id="dbody"></div></aside>
    <div class="modal" id="modal"></div>`);
  $('#scrim').onclick = () => { closeDrawer(); closeModal(); };
  $('#dclose').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });
}
function openDrawer(title, head = '') {
  ensureOverlay();
  $('#dtitle').textContent = title;
  $('#dhead').innerHTML = head;
  $('#dbody').innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:200px"></div>';
  $('#drawer').classList.add('on');
  $('#scrim').classList.add('on');
  return $('#dbody');
}
function closeDrawer() { $('#drawer')?.classList.remove('on'); if (!$('#modal')?.classList.contains('on')) $('#scrim')?.classList.remove('on'); }
function closeModal() { $('#modal')?.classList.remove('on'); if (!$('#drawer')?.classList.contains('on')) $('#scrim')?.classList.remove('on'); }

// ask({title, text, fields:[{name,label,type,value,options,placeholder}], ok, danger}) -> values or null
function ask({ title, text = '', fields = [], ok = 'Confirm', danger = false }) {
  ensureOverlay();
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}
      ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${
        f.type === 'select'
          ? `<select class="input" name="${f.name}">${f.options.map((o) => `<option value="${esc(o[0])}" ${o[0] === f.value ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
          : f.type === 'textarea'
            ? `<textarea class="input" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
            : `<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">`
      }</label>`).join('')}
      <div class="err" id="merr"></div>
      <div class="actions"><button class="btn ghost" data-a="no">Cancel</button><button class="btn ${danger ? 'bad' : 'primary'}" data-a="yes">${esc(ok)}</button></div>`;
    m.classList.add('on');
    $('#scrim').classList.add('on');
    const first = $('input,select,textarea', m);
    if (first) setTimeout(() => first.focus(), 50);
    const done = (v) => { m.onclick = null; closeModal(); resolve(v); };
    m.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'no') done(null);
      if (a === 'yes') {
        const vals = {};
        for (const f of fields) {
          const v = $(`[name="${f.name}"]`, m).value.trim();
          if (f.required && !v) { $('#merr', m).textContent = f.label + ' is required'; return; }
          vals[f.name] = v;
        }
        done(vals);
      }
    };
  });
}

/* ---------------- auth ---------------- */
function renderLogin(msg = '') {
  stopLive();
  $('#app').innerHTML = `
  <div class="login"><form class="login-card" id="lf">
    <div class="brand"><div class="logo">J</div><div><b>JURTO</b><small>OPS CONSOLE</small></div></div>
    <h1>Welcome back</h1><p>Sign in with your JURTO admin account.</p>
    <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="username" required></label>
    <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
    <div class="err" id="lerr">${esc(msg)}</div>
    <button class="btn primary block" id="lbtn">Sign in</button>
    <p style="margin:16px 0 0;text-align:center"><a href="#" id="forgot" class="muted small">Forgot password?</a></p>
  </form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#lbtn').disabled = true;
    $('#lerr').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    $('#lbtn').disabled = false;
    if (error) return ($('#lerr').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password' : error.message);
    boot();
  };
  $('#forgot').onclick = async (e) => {
    e.preventDefault();
    const email = $('[name=email]').value.trim();
    if (!email) return ($('#lerr').textContent = 'Type your email first');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    $('#lerr').textContent = error ? error.message : 'Reset link sent to ' + email + '. Open it once, on this device.';
  };
}

function renderSetPassword(msg = '') {
  stopLive();
  $('#app').innerHTML = `
  <div class="login"><form class="login-card" id="pf">
    <div class="brand"><div class="logo">J</div><div><b>JURTO</b><small>OPS CONSOLE</small></div></div>
    <h1>Set a new password</h1><p>Choose a password with at least 8 characters.</p>
    <label class="field"><span>New password</span><input class="input" name="p1" type="password" autocomplete="new-password" minlength="8" required></label>
    <label class="field"><span>Type it again</span><input class="input" name="p2" type="password" autocomplete="new-password" minlength="8" required></label>
    <div class="err" id="perr">${esc(msg)}</div>
    <button class="btn primary block" id="pbtn">Save password</button>
  </form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('p1') !== f.get('p2')) return ($('#perr').textContent = 'The two passwords are not the same');
    $('#pbtn').disabled = true;
    const { error } = await sb.auth.updateUser({ password: f.get('p1') });
    $('#pbtn').disabled = false;
    if (error) return ($('#perr').textContent = error.message);
    toast('Password saved', 'ok');
    location.hash = '#/dashboard';
    boot();
  };
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin(LINK_ERROR ? 'That email link has expired or was already used. Ask for a new one below.' : '');
  S.user = session.user;
  try {
    S.admin = await q(sb.from('admin_users').select('email,first_name,is_active,admin_roles(role_name)').eq('auth_user_id', S.user.id).maybeSingle());
    if (!S.admin?.is_active) throw new Error('not_admin');
    S.dash = await q(sb.rpc('admin_dashboard'));
  } catch (e) {
    await sb.auth.signOut();
    return renderLogin(String(e.message).includes('not_admin') ? 'This account is not a JURTO admin.' : e.message);
  }
  const vt = await q(sb.from('vehicle_types').select('id,type_name,is_active'));
  S.vtypes = Object.fromEntries(vt.map((v) => [v.id, v.type_name]));
  renderShell();
  startLive();
  route();
}

/* ---------------- icons (line style) ---------------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  live: '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  orders: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  drivers: '<path d="M1 5h13v11H1zM14 9h4l3 3.5V16h-7z"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  customers: '<circle cx="9" cy="8" r="4"/><path d="M1.5 21a7.5 7.5 0 0 1 15 0"/><path d="M16 4.2a4 4 0 0 1 0 7.6M22.5 21a7.5 7.5 0 0 0-4.5-6.9"/>',
  fleets: '<rect x="4" y="2" width="16" height="20" rx="1.5"/><path d="M9 22v-4h6v4M8 6h2M14 6h2M8 10h2M14 10h2M8 14h2M14 14h2"/>',
  payouts: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2M6 6V4h12v2"/>',
  pricing: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8"/>',
  promos: '<path d="M3 7h18v3.5a2 2 0 0 0 0 4V18H3v-3.5a2 2 0 0 0 0-4z"/><path d="M14 7v11" stroke-dasharray="2 2.5"/>',
  support: '<path d="M3 15v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  xc: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  bank: '<path d="M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-7 10 7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};
// Light (white) or dark workspace, remembered on this device
const theme = () => document.documentElement.dataset.theme || 'light';
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('jurto_theme', t); } catch (_) {}
}
try { setTheme(localStorage.getItem('jurto_theme') || 'light'); } catch (_) {}
const ico = (n, size = 18) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ---------------- shell & routing ---------------- */
const NAV = [
  ['dashboard', 'dashboard', 'Dashboard'],
  ['live', 'live', 'Live dispatch'],
  ['orders', 'orders', 'Orders'],
  ['-', 'People'],
  ['drivers', 'drivers', 'Drivers', 'drivers_to_verify'],
  ['customers', 'customers', 'Customers'],
  ['fleets', 'fleets', 'Fleet owners', 'fleets_to_verify'],
  ['-', 'Money'],
  ['payouts', 'payouts', 'Payouts & dues', 'payouts_pending'],
  ['pricing', 'pricing', 'Pricing'],
  ['promos', 'promos', 'Promo codes'],
  ['-', 'System'],
  ['support', 'support', 'Support', 'tickets_open'],
  ['settings', 'settings', 'Settings'],
];
const TITLES = Object.fromEntries(NAV.filter((n) => n[0] !== '-').map((n) => [n[0], n[2]]));

function renderShell() {
  const qd = S.dash?.queue || {};
  $('#app').innerHTML = `
  <div class="shell">
    <nav class="side" id="side">
      <div class="brand"><div class="logo">J</div><div><b>JURTO</b><small>OPS CONSOLE</small></div></div>
      ${NAV.map((n) => n[0] === '-' ? `<div class="sep">${n[1]}</div>` : `<a class="nav" href="#/${n[0]}" data-r="${n[0]}">${ico(n[1])}<span>${n[2]}</span>${n[3] && qd[n[3]] ? `<span class="count">${qd[n[3]]}</span>` : ''}</a>`).join('')}
      <div class="me"><span class="avatar sm">${esc(initial(S.admin))}</span><div><b>${esc(S.admin.first_name || S.admin.email)}</b><small>${esc((S.admin.admin_roles?.role_name || 'admin').replace('_', ' '))}</small></div><a href="#" id="logout" class="icon-btn" title="Sign out">${ico('logout', 16)}</a></div>
    </nav>
    <div class="main">
      <header class="top">
        <button class="icon-btn menu-btn" id="menu" aria-label="Menu">${ico('menu')}</button>
        <div class="ttl"><div class="crumb">JURTO Ops <span>/</span> <span id="pcrumb"></span></div><h2 id="ptitle"></h2><div class="sub" id="psub"></div></div>
        <div class="grow"></div>
        <label class="gsearch">${ico('search', 16)}<input id="gq" placeholder="Search orders, phone, address…" autocomplete="off"></label>
        <span class="live off" id="live"><span class="dot"></span>CONNECTING</span>
        <a class="icon-btn bell" href="#/dashboard" title="Needs attention">${ico('bell')}${S.dash ? (() => { const n = Object.values(S.dash.queue || {}).reduce((a, b) => a + num(b), 0); return n ? `<span class="badge">${n}</span>` : ''; })() : ''}</a>
        <button class="icon-btn theme-btn" id="theme" title="Light / dark">${ico(theme() === 'light' ? 'moon' : 'sun')}</button>
        <span class="clock" id="clock"></span>
      </header>
      <main class="page" id="page"></main>
    </div>
  </div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); renderLogin(); };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  $('#theme').onclick = () => {
    setTheme(theme() === 'light' ? 'dark' : 'light');
    $('#theme').innerHTML = ico(theme() === 'light' ? 'moon' : 'sun');
    if (['dashboard'].includes(S.route)) PAGES.dashboard($('#page'), true).catch(() => {});
  };
  $('#gq').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    S.ordersQ = e.target.value.trim();
    S.ordersTab = 'all';
    if (S.route === 'orders') route(); else location.hash = '#/orders';
  };
  const tick = () => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }); };
  tick();
  clearInterval(S.clockT);
  S.clockT = setInterval(tick, 1000);
}

function route() {
  const r = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
  S.route = PAGES[r] ? r : 'dashboard';
  for (const fn of S.cleanup.splice(0)) try { fn(); } catch (_) {}
  for (const m of S.maps.splice(0)) try { m.remove(); } catch (_) {}
  $$('.nav').forEach((a) => a.classList.toggle('on', a.dataset.r === S.route));
  $('#side')?.classList.remove('open');
  $('#ptitle').textContent = TITLES[S.route];
  $('#pcrumb').textContent = TITLES[S.route];
  for (const c of S.charts.splice(0)) try { c.destroy(); } catch (_) {}
  $('#psub').textContent = '';
  closeDrawer();
  PAGES[S.route]($('#page')).catch(fail);
}
window.addEventListener('hashchange', () => S.user && $('#page') && route());

/* ---------------- realtime ---------------- */
const refreshSoon = debounce(() => {
  if (['dashboard', 'live', 'orders'].includes(S.route)) PAGES[S.route]($('#page'), true).catch(() => {});
}, 1200);
function startLive() {
  stopLive();
  S.channel = sb.channel('ops-console')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (p) => {
      if (p.eventType === 'INSERT') toast(`🆕 New order <b>#${shortId(p.new.id)}</b> · ${rupees(p.new.estimated_fare)}`, 'hot');
      if (p.eventType === 'UPDATE' && p.old?.status !== p.new.status && p.new.status === 'cancelled') toast(`❌ Order <b>#${shortId(p.new.id)}</b> cancelled`, 'bad');
      refreshSoon();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations' }, (p) => { if (S.route === 'live' || S.route === 'dashboard') moveDriver(p.new); })
    .subscribe((st) => {
      S.live = st === 'SUBSCRIBED';
      const el = $('#live');
      if (el) { el.classList.toggle('off', !S.live); el.lastChild.textContent = S.live ? 'LIVE' : 'RECONNECTING'; }
    });
  // polling fallback, in case realtime is blocked on the network
  S.poll = setInterval(refreshSoon, 30000);
}
function stopLive() {
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = null;
  clearInterval(S.poll);
}

/* ---------------- map ---------------- */
// Google Maps (website key, locked to this site) drawn inside Leaflet through GoogleMutant, so the pins,
// popups and route lines stay the same. If Google refuses the key, the maps fall back to OpenStreetMap.
const GMAP_DARK = [
  { elementType: 'geometry', stylers: [{ color: '#0F1A2E' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8A97B2' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0B1220' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2A3958' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#121D33' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1F2B45' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6B7896' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2D3F66' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#070D1A' }] },
];
window.jurtoNoGoogle = () => {
  if (S.noGoogle) return;
  S.noGoogle = true;
  if (S.user && $('#page')) { toast('Google Maps is unavailable right now, showing OpenStreetMap'); route(); }
};
function osmLayer() {
  // OpenStreetMap tiles, darkened to the console's navy with a CSS filter (.dark-tiles)
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'dark-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
}
function makeMap(el, zoom = 11) {
  const m = L.map(el, { zoomControl: true, attributionControl: true }).setView(CHENNAI, zoom);
  if (S.noGoogle || window.gmFailed || !L.gridLayer.googleMutant) {
    osmLayer().addTo(m);
  } else {
    const layers = {
      Dark: L.gridLayer.googleMutant({ type: 'roadmap', styles: GMAP_DARK, maxZoom: 21 }),
      Map: L.gridLayer.googleMutant({ type: 'roadmap', maxZoom: 21 }),
      Satellite: L.gridLayer.googleMutant({ type: 'hybrid', maxZoom: 21 }),
    };
    let pick = 'Dark';
    try { pick = localStorage.getItem('jurto_map') || 'Dark'; } catch (_) {}
    (layers[pick] || layers.Dark).addTo(m);
    L.control.layers(layers, null, { position: 'topright' }).addTo(m);
    m.on('baselayerchange', (e) => { try { localStorage.setItem('jurto_map', e.name); } catch (_) {} });
  }
  S.maps.push(m);
  return m;
}
const icon = (cls, html = '') => L.divIcon({ className: '', html: `<div class="pin ${cls}">${html}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

async function liveData() {
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const [locs, active] = await Promise.all([
    q(sb.from('driver_locations').select('driver_id,latitude,longitude,is_online,recorded_at,drivers(first_name,last_name,phone,is_online)').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(3000)),
    q(sb.from('orders').select('id,status,created_at,accepted_at,arrived_at,started_at,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,pickup_address,dropoff_address,estimated_fare,payment_method,vehicle_type_id,driver_id,driver_name,customers(first_name,last_name,phone)').in('status', ['pending', 'accepted', 'in_transit']).order('created_at', { ascending: false }).limit(200)),
  ]);
  const seen = new Set();
  const drivers = [];
  for (const l of locs) {
    if (seen.has(l.driver_id)) continue;
    seen.add(l.driver_id);
    if (l.is_online && l.drivers?.is_online) drivers.push(l);
  }
  const busy = new Set(active.filter((o) => o.driver_id).map((o) => o.driver_id));
  return { drivers, active, busy };
}

// Driver trails are built from the positions seen while the console is open (the app keeps one row per
// driver and updates it), so a trail grows as a driver moves.
S.trails = new Map();
function trailPush(id, p) {
  const t = S.trails.get(id) || [];
  const last = t[t.length - 1];
  if (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) > 0.00004) t.push(p);
  if (t.length > 60) t.shift();
  S.trails.set(id, t);
  return t;
}
function glide(mk, to, ms = 1600) {
  const from = mk.getLatLng();
  if (Math.abs(from.lat - to[0]) + Math.abs(from.lng - to[1]) < 1e-7) return;
  cancelAnimationFrame(mk._anim);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    mk.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (k < 1) mk._anim = requestAnimationFrame(step);
  };
  mk._anim = requestAnimationFrame(step);
}
function moveDriver(r) {
  if (!r?.driver_id || r.latitude == null) return;
  const p = [num(r.latitude), num(r.longitude)];
  let known = false;
  for (const m of S.maps) {
    const d = m._drv?.get(r.driver_id);
    if (!d) continue;
    known = true;
    if (r.is_online === false) continue;
    glide(d.mk, p);
    d.tr.setLatLngs(trailPush(r.driver_id, p));
  }
  if (!known || r.is_online === false) refreshSoon();
}

function paintMap(m, { drivers, active, busy }, layer) {
  if (layer) layer.clearLayers(); else layer = L.layerGroup().addTo(m);
  const pts = [];
  for (const o of active) {
    if (o.pickup_lat == null) continue;
    const p = [num(o.pickup_lat), num(o.pickup_lng)], d = [num(o.dropoff_lat), num(o.dropoff_lng)];
    pts.push(p);
    L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="pin pick">P</div>', iconSize: [22, 22], iconAnchor: [11, 22] }) })
      .bindPopup(`<b>#${shortId(o.id)}</b> ${chip(o.status)}<br>${esc(o.pickup_address)}<br><span class="muted">${rupees(o.estimated_fare)} · ${esc(S.vtypes[o.vehicle_type_id] || '')}</span>`)
      .on('click', () => openOrder(o.id)).addTo(layer);
    if (o.dropoff_lat != null) {
      L.marker(d, { icon: L.divIcon({ className: '', html: '<div class="pin drop">D</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(layer);
      L.polyline([p, d], { color: o.status === 'pending' ? '#F59E0B' : '#60A5FA', weight: 2, opacity: .55, dashArray: '6 6' }).addTo(layer);
    }
  }
  if (!m._drv) { m._drv = new Map(); m._dl = L.layerGroup().addTo(m); }
  const keep = new Set();
  for (const l of drivers) {
    const p = [num(l.latitude), num(l.longitude)];
    pts.push(p);
    keep.add(l.driver_id);
    const isBusy = busy.has(l.driver_id);
    const trail = trailPush(l.driver_id, p);
    const popup = `<b>${esc(name(l.drivers))}</b><br>${isBusy ? '🟠 On a trip' : '🟢 Free'} · ${ago(l.recorded_at)}<br><a href="tel:${esc(l.drivers?.phone)}">${esc(l.drivers?.phone || '')}</a>`;
    let dv = m._drv.get(l.driver_id);
    if (!dv) {
      const tr = L.polyline(trail, { color: isBusy ? '#F59E0B' : '#22C55E', weight: 3, opacity: .5, lineCap: 'round' }).addTo(m._dl);
      const mk = L.marker(p, { icon: icon(isBusy ? 'busy' : 'idle', '🚚'), zIndexOffset: 500 }).on('click', () => openDriver(l.driver_id)).addTo(m._dl);
      dv = { mk, tr, busy: isBusy };
      m._drv.set(l.driver_id, dv);
    } else {
      glide(dv.mk, p);
      dv.tr.setLatLngs(trail);
      if (dv.busy !== isBusy) { dv.mk.setIcon(icon(isBusy ? 'busy' : 'idle', '🚚')); dv.tr.setStyle({ color: isBusy ? '#F59E0B' : '#22C55E' }); dv.busy = isBusy; }
    }
    dv.mk.bindPopup(popup);
  }
  for (const [id, dv] of m._drv) if (!keep.has(id)) { m._dl.removeLayer(dv.mk); m._dl.removeLayer(dv.tr); m._drv.delete(id); }
  return { layer, pts };
}

/* ================= PAGES ================= */
const PAGES = {};
// shared page pieces: a row of summary cards, a search box with an icon, and an empty state
const stats = (items) => `<div class="grid stats">${items.map(([i, tone, lbl, val, sub]) => `<div class="card stat"><span class="kic ${tone}">${ico(i, 17)}</span><div><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`).join('')}</div>`;
const searchBox = (id, ph, val) => `<label class="sbox">${ico('search', 15)}<input id="${id}" placeholder="${esc(ph)}" value="${esc(val || '')}" autocomplete="off"></label>`;
const empty = (i, text) => `<div class="empty"><span class="eic">${ico(i, 22)}</span><div>${text}</div></div>`;
const weekAgo = () => Date.now() - 7 * 864e5;

/* ---------- dashboard ---------- */
const CH = { blue: '#5B7CC4', blueSoft: 'rgba(91,124,196,.22)', red: '#E00000', redSoft: '#7A1E2A', amber: '#C9A227', grid: 'rgba(138,151,178,.10)', tick: '#6B7896' };
function chart(el, cfg) {
  if (!window.Chart || !el) return null;
  Chart.defaults.color = CH.tick;
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  const c = new Chart(el, cfg);
  S.charts.push(c);
  return c;
}
const tooltip = { backgroundColor: '#16213A', borderColor: '#2A3958', borderWidth: 1, titleColor: '#E8EDF7', bodyColor: '#C9D2E5', padding: 10, cornerRadius: 10, displayColors: true, boxPadding: 4 };
function spark(vals, color) {
  const w = 110, h = 34, max = Math.max(1, ...vals), n = vals.length;
  const pts = vals.map((v, i) => [(i / Math.max(1, n - 1)) * w, h - 3 - (v / max) * (h - 8)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function delta(now, before, goodWhenUp = true) {
  now = num(now); before = num(before);
  if (!now && !before) return `<span class="delta flat">— same as yesterday</span>`;
  if (!before) return `<span class="delta ${goodWhenUp ? 'up' : 'down'}">▲ new vs yesterday</span>`;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return `<span class="delta flat">— same as yesterday</span>`;
  const good = pct > 0 === goodWhenUp;
  return `<span class="delta ${good ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs yesterday</span>`;
}

PAGES.dashboard = async (el, quiet) => {
  const [d, recent] = await Promise.all([
    q(sb.rpc('admin_dashboard')),
    q(sb.from('orders').select('id,status,created_at,estimated_fare,final_fare,pickup_address,dropoff_address,vehicle_type_id,customers(first_name,last_name,phone)').order('created_at', { ascending: false }).limit(8)),
  ]);
  S.dash = d;
  const t = d.today || {}, y = d.yesterday || {}, lv = d.live || {}, qd = d.queue || {};
  const tr = d.trend || d.week || [];
  const col = (k) => tr.map((x) => num(x[k]));
  $('#psub').textContent = 'Chennai · ' + new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  const kpi = (icon, tone, lbl, val, foot, sp) => `<div class="card kpi"><div class="kh"><span class="kic ${tone}">${ico(icon, 17)}</span><span class="lbl">${lbl}</span></div>
    <div class="kb"><div><div class="val">${val}</div>${foot}</div>${sp || ''}</div></div>`;
  const rate = t.orders ? Math.round((t.completed / t.orders) * 100) : 0;
  const queue = [
    ['shield', 'Drivers to verify', qd.drivers_to_verify, 'drivers'],
    ['file', 'Documents pending', qd.docs_pending, 'drivers'],
    ['fleets', 'Fleets to verify', qd.fleets_to_verify, 'fleets'],
    ['bank', 'Payout requests', qd.payouts_pending, 'payouts'],
    ['support', 'Open tickets', qd.tickets_open, 'support'],
  ];
  const qTotal = queue.reduce((a, x) => a + num(x[2]), 0);
  const st = d.status_7d || {};
  const stTotal = Object.values(st).reduce((a, b) => a + num(b), 0);
  const html = `
  <div class="grid kpis">
    ${kpi('orders', 'blue', 'Orders today', num(t.orders), delta(t.orders, y.orders), spark(col('orders'), CH.blue))}
    ${kpi('check', 'green', 'Delivered', num(t.completed), `<span class="delta flat">${t.orders ? rate + '% completion' : 'no orders yet'}</span>`, spark(col('completed'), '#4FA77A'))}
    ${kpi('rupee', 'red', 'GMV', rupees(t.gmv), delta(t.gmv, y.gmv), spark(col('gmv'), CH.red))}
    ${kpi('bank', 'violet', 'JURTO earnings', rupees(t.commission), delta(t.commission, y.commission), spark(col('commission'), '#8B7CC4'))}
    ${kpi('drivers', 'green', 'Drivers online', `${num(lv.drivers_online)}<small> / ${num(lv.drivers_total)}</small>`, `<span class="delta flat">${num(lv.on_trip)} on a trip · ${num(lv.pending)} waiting</span>`)}
    ${kpi('xc', 'amber', 'Cancelled today', num(t.cancelled), delta(t.cancelled, y.cancelled, false), spark(col('cancelled'), CH.amber))}
  </div>

  <div class="grid two" style="margin-top:16px">
    <div class="card"><div class="ch"><div><h3>Orders & revenue</h3><div class="cs">Last 14 days · bars = orders, line = GMV</div></div>
      <div class="kstat"><b>${tr.reduce((a, x) => a + num(x.orders), 0)}</b><span>orders</span></div><div class="kstat"><b>${rupees(tr.reduce((a, x) => a + num(x.gmv), 0))}</b><span>GMV</span></div></div>
      <div class="chartbox tall"><canvas id="c_trend"></canvas></div></div>
    <div class="card"><div class="ch"><div><h3>Order status</h3><div class="cs">Last 7 days</div></div></div>
      <div class="donut"><div class="chartbox"><canvas id="c_status"></canvas></div><div class="dc"><b>${stTotal}</b><span>orders</span></div></div>
      <div class="dl">${[['completed', 'Delivered', CH.blue], ['cancelled', 'Cancelled', CH.redSoft], ['active', 'Active / scheduled', CH.amber]].map(([k, l, c]) => {
        const n = k === 'active' ? num(st.pending) + num(st.accepted) + num(st.in_transit) + num(st.scheduled) : num(st[k]);
        return `<div><i style="background:${c}"></i>${l}<span class="grow"></span><b>${n}</b><span class="dim">${stTotal ? Math.round((n / stTotal) * 100) : 0}%</span></div>`;
      }).join('')}</div></div>
  </div>

  <div class="grid two" style="margin-top:16px">
    <div class="card"><div class="ch"><div><h3>Live map</h3><div class="cs">${num(lv.drivers_online)} drivers online · ${num(lv.pending) + num(lv.on_trip)} live orders</div></div><a class="btn sm" href="#/live">Open dispatch ${ico('chev', 14)}</a></div><div class="mapbox" id="dmap"></div></div>
    <div class="card"><div class="ch"><div><h3>Needs attention</h3><div class="cs">${qTotal ? qTotal + ' items waiting for you' : 'All clear'}</div></div></div>
      <div class="qlist">${queue.map(([i, l, n, r]) => `<a class="qi ${num(n) ? 'hot' : ''}" href="#/${r}"><span class="kic ${num(n) ? 'red' : 'grey'}">${ico(i, 16)}</span><span>${l}</span><span class="grow"></span><b>${num(n)}</b>${ico('chev', 14)}</a>`).join('')}</div>
      <div class="mini"><div><span>All-time orders</span><b>${num(d.totals?.orders)}</b></div><div><span>Delivered</span><b>${num(d.totals?.completed)}</b></div><div><span>Customers</span><b>${num(d.totals?.customers)}</b></div></div>
    </div>
  </div>

  <div class="grid two even" style="margin-top:16px">
    <div class="card"><div class="ch"><div><h3>Orders by hour</h3><div class="cs">Today · find your peak time</div></div></div><div class="chartbox"><canvas id="c_hours"></canvas></div></div>
    <div class="card"><div class="ch"><div><h3>Vehicle mix</h3><div class="cs">Last 7 days</div></div></div>
      ${(d.vehicles_7d || []).length ? `<div class="hbars">${(() => { const vs = d.vehicles_7d, mx = Math.max(...vs.map((v) => v.orders)); return vs.map((v) => `<div class="hb"><span class="nm">${esc(v.name)}</span><div class="tr"><div style="width:${(v.orders / mx) * 100}%"></div></div><b>${v.orders}</b></div>`).join(''); })()}</div>` : `<div class="empty small">No orders in the last 7 days</div>`}
    </div>
  </div>

  <div class="card" style="margin-top:16px"><div class="ch"><div><h3>Latest orders</h3><div class="cs">Click a row for the full timeline</div></div><a class="btn sm" href="#/orders">All orders ${ico('chev', 14)}</a></div>
    ${orderTable(recent)}</div>`;
  for (const c of S.charts.splice(0)) try { c.destroy(); } catch (_) {}
  if (quiet && $('#dmap')) {
    // refresh numbers without rebuilding the map
    const keepMap = $('#dmap');
    el.innerHTML = html;
    $('#dmap').replaceWith(keepMap);
  } else {
    el.innerHTML = html;
    S.dmap = makeMap($('#dmap'), 11);
    S.dlayer = null;
  }
  wireOrderRows(el);
  const anim = quiet ? false : { duration: 700 };
  chart($('#c_trend'), {
    data: {
      labels: tr.map((x) => new Date(x.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })),
      datasets: [
        { type: 'bar', label: 'Delivered', data: col('completed'), backgroundColor: CH.blue, borderRadius: 4, stack: 'o', yAxisID: 'y', maxBarThickness: 26 },
        { type: 'bar', label: 'Cancelled', data: col('cancelled'), backgroundColor: CH.redSoft, borderRadius: 4, stack: 'o', yAxisID: 'y', maxBarThickness: 26 },
        { type: 'bar', label: 'Other', data: tr.map((x) => Math.max(0, num(x.orders) - num(x.completed) - num(x.cancelled))), backgroundColor: '#2B3B60', borderRadius: 4, stack: 'o', yAxisID: 'y', maxBarThickness: 26 },
        { type: 'line', label: 'GMV ₹', data: col('gmv'), borderColor: CH.red, backgroundColor: CH.red, pointRadius: 2.5, pointHoverRadius: 5, borderWidth: 2, tension: .35, yAxisID: 'y1' },
      ],
    },
    options: {
      animation: anim, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14 } }, tooltip: { ...tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${c.dataset.yAxisID === 'y1' ? rupees(c.raw) : c.raw}` } } },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: CH.grid }, border: { display: false }, ticks: { precision: 0 } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { callback: (v) => '₹' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v) } },
      },
    },
  });
  const active = num(st.pending) + num(st.accepted) + num(st.in_transit) + num(st.scheduled);
  chart($('#c_status'), {
    type: 'doughnut',
    data: { labels: ['Delivered', 'Cancelled', 'Active'], datasets: [{ data: stTotal ? [num(st.completed), num(st.cancelled), active] : [1], backgroundColor: stTotal ? [CH.blue, CH.redSoft, CH.amber] : ['#1F2B45'], borderWidth: 0, hoverOffset: 4 }] },
    options: { animation: anim, maintainAspectRatio: false, cutout: '74%', plugins: { legend: { display: false }, tooltip: stTotal ? tooltip : { enabled: false } } },
  });
  const hrs = d.hours_today || Array(24).fill(0);
  chart($('#c_hours'), {
    type: 'bar',
    data: { labels: hrs.map((_, h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p')), datasets: [{ label: 'Orders', data: hrs, backgroundColor: hrs.map((v) => (v && v === Math.max(...hrs) ? CH.red : CH.blue)), borderRadius: 3, maxBarThickness: 14 }] },
    options: { animation: anim, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 6 } }, y: { beginAtZero: true, grid: { color: CH.grid }, border: { display: false }, ticks: { precision: 0 } } } },
  });
  const live = await liveData();
  S.dlayer = paintMap(S.dmap, live, S.dlayer).layer;
  setTimeout(() => S.dmap?.invalidateSize(), 50);
};

/* ---------- live dispatch ---------- */
PAGES.live = async (el, quiet) => {
  if (!quiet || !$('#lmap')) {
    el.innerHTML = `<div class="mapfull"><div class="mapbox" id="lmap"></div><div class="card feed" id="lfeed"></div></div>`;
    S.lmap = makeMap($('#lmap'), 11);
    S.llayer = null;
  }
  const live = await liveData();
  const r = paintMap(S.lmap, live, S.llayer);
  S.llayer = r.layer;
  if (!quiet && r.pts.length) S.lmap.fitBounds(L.latLngBounds(r.pts).pad(0.25), { maxZoom: 14 });
  setTimeout(() => S.lmap?.invalidateSize(), 50);
  $('#psub').textContent = `${live.drivers.length} drivers online · ${live.busy.size} on a trip · ${live.active.length} live orders`;
  const free = live.drivers.length - [...live.busy].filter((id) => live.drivers.some((d) => d.driver_id === id)).length;
  $('#lfeed').innerHTML = `
    <h3>Live orders<span class="grow"></span><span class="chip ok">${free} free</span></h3>
    ${live.active.length ? live.active.map((o) => {
      const wait = o.status === 'pending' ? Math.floor((Date.now() - new Date(o.created_at)) / 60000) : null;
      return `<div class="fo" data-o="${o.id}">
        <div class="hd"><b class="mono">#${shortId(o.id)}</b>${chip(o.status)}<span class="grow"></span><b>${rupees(o.estimated_fare)}</b></div>
        <div class="route small"><div class="p">${esc(o.pickup_address)}</div><div class="d">${esc(o.dropoff_address)}</div></div>
        <div class="small muted" style="margin-top:8px">${esc(S.vtypes[o.vehicle_type_id] || '')} · ${esc(name(o.customers))}${o.driver_name ? ' · 🚚 ' + esc(o.driver_name) : ''}${wait != null ? ` · <b style="color:${wait >= 3 ? 'var(--red2)' : 'var(--amber)'}">waiting ${wait} min</b>` : ''}</div>
        ${o.status === 'pending' ? `<button class="btn sm primary" style="margin-top:10px" data-assign="${o.id}">${ico('drivers', 14)} Assign driver</button>` : ''}
      </div>`;
    }).join('') : `<div class="empty"><div class="e">😌</div>No live orders right now</div>`}`;
  $$('.fo', el).forEach((f) => (f.onclick = () => openOrder(f.dataset.o)));
  $$('[data-assign]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); assignDriver(b.dataset.assign); }));
};

/* ---------- orders ---------- */
function orderTable(rows) {
  if (!rows.length) return empty('orders', 'No orders');
  return `<div class="tbl-wrap" style="border:0"><table><thead><tr><th>Order</th><th>Customer</th><th>Route</th><th>Vehicle</th><th class="right">Fare</th><th>Status</th></tr></thead><tbody>
    ${rows.map((o) => `<tr class="row" data-o="${o.id}">
      <td><b class="mono">#${shortId(o.id)}</b><div class="small muted">${fmtDate(o.created_at)}</div></td>
      <td><div class="who"><span class="avatar">${initial(o.customers)}</span><div><b>${esc(name(o.customers))}</b><small>${esc(o.customers?.phone || '')}</small></div></div></td>
      <td><div class="route small"><div class="p">${esc(o.pickup_address)}</div><div class="d">${esc(o.dropoff_address)}</div></div></td>
      <td class="nowrap small">${esc(S.vtypes[o.vehicle_type_id] || '—')}</td>
      <td class="right strong nowrap">${rupees(o.final_fare ?? o.estimated_fare)}${o.payment_method ? `<div class="small muted">${esc(o.payment_method)}</div>` : ''}</td>
      <td>${chip(o.status)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function wireOrderRows(el) { $$('tr[data-o]', el).forEach((r) => (r.onclick = () => openOrder(r.dataset.o))); }

S.ordersTab = 'all';
PAGES.orders = async (el, quiet) => {
  const tab = S.ordersTab;
  let qy = sb.from('orders').select('id,status,created_at,estimated_fare,final_fare,payment_method,pickup_address,dropoff_address,vehicle_type_id,cancellation_reason,customers(first_name,last_name,phone)').order('created_at', { ascending: false }).limit(300);
  if (tab === 'live') qy = qy.in('status', ['pending', 'accepted', 'in_transit']);
  else if (tab !== 'all') qy = qy.eq('status', tab);
  const rows = await q(qy);
  const term = (S.ordersQ || '').toLowerCase();
  const shown = term ? rows.filter((o) => [o.id, o.pickup_address, o.dropoff_address, name(o.customers), o.customers?.phone].join(' ').toLowerCase().includes(term)) : rows;
  const tabs = [['all', 'All'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['completed', 'Delivered'], ['cancelled', 'Cancelled']];
  const by = (st) => rows.filter((o) => (Array.isArray(st) ? st.includes(o.status) : o.status === st));
  const done = by('completed');
  el.innerHTML = `
  ${tab === 'all' ? stats([
    ['activity', 'amber', 'Live now', by(['pending', 'accepted', 'in_transit']).length, `${by('pending').length} finding a driver`],
    ['check', 'green', 'Delivered', done.length, rupees(done.reduce((a, o) => a + num(o.final_fare ?? o.estimated_fare), 0)) + ' in fares'],
    ['xc', 'red', 'Cancelled', by('cancelled').length, rows.length ? Math.round((by('cancelled').length / rows.length) * 100) + '% of orders' : ''],
    ['orders', 'blue', 'Scheduled', by('scheduled').length, 'booked for later'],
  ]) : ''}
  <div class="toolbar">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="grow"></div>
    ${searchBox('oq', 'Search order ID, phone, address', S.ordersQ)}
  </div>
  <div class="tbl-wrap">${orderTable(shown)}</div>
  <p class="small dim">Showing the latest ${rows.length} orders.</p>`;
  $('#psub').textContent = `${shown.length} orders`;
  $$('.tab', el).forEach((b) => (b.onclick = () => { S.ordersTab = b.dataset.t; PAGES.orders(el); }));
  const oq = $('#oq');
  oq.oninput = debounce(() => { S.ordersQ = oq.value; PAGES.orders(el).then(() => { const n = $('#oq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300);
  wireOrderRows(el);
};

async function openOrder(id) {
  const body = openDrawer('Order #' + shortId(id));
  try {
    const o = await q(sb.from('orders').select('*, customers(id,first_name,last_name,phone,email), drivers(id,first_name,last_name,phone,rating)').eq('id', id).single());
    const [ratings, pays] = await Promise.all([
      q(sb.from('order_ratings').select('rater_role,rating,comment').eq('order_id', id)),
      q(sb.from('payments').select('amount,status,razorpay_payment_id,paid_at').eq('order_id', id)),
    ]);
    $('#dhead').innerHTML = chip(o.status);
    const stops = Array.isArray(o.stops) ? o.stops : [];
    const tl = [
      ['Booked', o.created_at, true],
      o.scheduled_at && ['Scheduled for', o.scheduled_at, true],
      [o.assigned_by ? 'Driver assigned by JURTO' : 'Driver assigned', o.accepted_at],
      ['Arrived at pickup', o.arrived_at],
      ['Trip started', o.started_at],
      ['Reached drop', o.drop_arrived_at],
      o.status === 'cancelled' ? ['Cancelled' + (o.cancelled_by ? ' by ' + o.cancelled_by : ''), o.cancelled_at || o.updated_at, 'bad'] : ['Delivered', o.completed_at],
    ].filter(Boolean);
    const fare = num(o.final_fare ?? o.estimated_fare);
    body.innerHTML = `
      <div class="sec"><h4>Route</h4><div class="route" style="max-width:none">
        <div class="p">${esc(o.pickup_address)}</div>
        ${stops.map((s, i) => `<div class="small muted" style="padding-left:16px">Stop ${i + 1}: ${esc(s.address)}${s.receiver_name ? ' · ' + esc(s.receiver_name) : ''}</div>`).join('')}
        <div class="d">${esc(o.dropoff_address)}</div></div>
        <div class="mapbox" id="omap" style="height:200px;margin-top:12px"></div></div>
      <div class="sec"><h4>Timeline</h4><div class="timeline">${tl.map(([l, ts, st]) => `<div class="tl ${st === 'bad' ? 'bad' : ts ? 'done' : ''}"><i></i><b>${esc(l)}</b><span>${ts ? fmtDate(ts) : '—'}</span></div>`).join('')}</div>
        ${o.cancellation_reason ? `<div class="small" style="margin-top:6px">Reason: <b>${esc(o.cancellation_reason)}</b></div>` : ''}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="sec"><h4>Customer</h4><div class="who" style="cursor:pointer" id="ocust"><span class="avatar">${initial(o.customers)}</span><div><b>${esc(name(o.customers))}</b><small><a href="tel:${esc(o.customers?.phone)}">${esc(o.customers?.phone || '')}</a></small></div></div>
          ${o.receiver_name || o.receiver_phone ? `<div class="small muted" style="margin-top:10px">Receiver: ${esc(o.receiver_name || '')} <a href="tel:${esc(o.receiver_phone)}">${esc(o.receiver_phone || '')}</a></div>` : ''}</div>
        <div class="sec"><h4>Driver</h4>${o.drivers ? `<div class="who" style="cursor:pointer" id="odrv"><span class="avatar">${initial(o.drivers)}</span><div><b>${esc(name(o.drivers))}</b><small><a href="tel:${esc(o.drivers.phone)}">${esc(o.drivers.phone || '')}</a> · ⭐ ${num(o.drivers.rating).toFixed(1)}</small></div></div>
          <div class="small muted" style="margin-top:10px">${esc(o.vehicle_model || '')} ${esc((o.vehicle_number || '').toUpperCase())}</div>` : `<span class="muted">Not assigned</span>${o.status === 'pending' ? `<div style="margin-top:10px"><button class="btn sm primary" data-assign="${o.id}">${ico('drivers', 15)} Assign driver</button></div>` : ''}`}</div>
      </div>
      <div class="sec"><h4>Fare</h4><div class="fare">
        <div><span class="muted">${esc(S.vtypes[o.vehicle_type_id] || 'Vehicle')} · ${num(o.estimated_distance_km).toFixed(1)} km</span><span>${rupees2(o.estimated_fare)}</span></div>
        ${num(o.waiting_charge) ? `<div><span class="muted">Waiting charge</span><span>${rupees2(o.waiting_charge)}</span></div>` : ''}
        ${num(o.discount) ? `<div><span class="muted">Discount${o.promo_code ? ' (' + esc(o.promo_code) + ')' : ''}${num(o.coins_used) ? ' incl. ' + num(o.coins_used) + ' coins' : ''}</span><span style="color:#86EFAC">− ${rupees2(o.discount)}</span></div>` : ''}
        <div class="tot"><span>Customer pays</span><span>${rupees2(o.payable_fare ?? fare)}</span></div>
        ${o.platform_fee != null ? `<div class="small"><span class="muted">JURTO commission (${num(o.commission_percent)}%)</span><span>${rupees2(o.platform_fee)}</span></div><div class="small"><span class="muted">Driver earning</span><span>${rupees2(o.driver_earning)}</span></div>` : ''}
        <div class="small"><span class="muted">Payment</span><span>${esc(o.payment_method || '—')} ${o.is_paid ? chip('ok', 'Paid') : o.payment_method === 'cash' ? '' : chip('grey', 'Unpaid')}</span></div>
        ${pays.map((p) => `<div class="small"><span class="muted">Razorpay ${esc(p.razorpay_payment_id || '')}</span><span>${rupees2(p.amount)} · ${esc(p.status)}</span></div>`).join('')}
      </div></div>
      ${ratings.length ? `<div class="sec"><h4>Ratings</h4>${ratings.map((r) => `<div class="small"><b>${'⭐'.repeat(r.rating)}</b> by ${esc(r.rater_role)} ${r.comment ? '· “' + esc(r.comment) + '”' : ''}</div>`).join('')}</div>` : ''}
      <div class="sec"><h4>Actions</h4><div class="actions">
        ${o.status === 'pending' ? `<button class="btn primary" data-assign="${o.id}">${ico('drivers', 15)} Assign driver</button>` : ''}
        ${['pending', 'scheduled', 'accepted', 'in_transit'].includes(o.status) ? '<button class="btn bad" id="ocancel">Cancel order</button>' : ''}
        ${o.share_token ? `<a class="btn" target="_blank" rel="noopener" href="${TRACK_BASE}?t=${esc(o.share_token)}">Open tracking link ↗</a>` : ''}
        <button class="btn ghost" id="ocopy">Copy order ID</button>
      </div><div class="small dim" style="margin-top:8px">ID ${esc(o.id)}</div></div>`;
    const m = makeMap($('#omap'), 12);
    const pts = [];
    if (o.pickup_lat != null) { const p = [num(o.pickup_lat), num(o.pickup_lng)]; pts.push(p); L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="pin pick">P</div>', iconSize: [22, 22], iconAnchor: [11, 22] }) }).addTo(m); }
    for (const s of stops) if (s.lat != null) pts.push([num(s.lat), num(s.lng)]);
    if (o.dropoff_lat != null) { const d = [num(o.dropoff_lat), num(o.dropoff_lng)]; pts.push(d); L.marker(d, { icon: L.divIcon({ className: '', html: '<div class="pin drop">D</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(m); }
    if (pts.length > 1) { L.polyline(pts, { color: '#60A5FA', weight: 3, opacity: .7 }).addTo(m); m.fitBounds(L.latLngBounds(pts).pad(0.3)); }
    setTimeout(() => m.invalidateSize(), 300);
    if (o.customers) $('#ocust').onclick = () => openCustomer(o.customers.id);
    if (o.drivers) $('#odrv').onclick = () => openDriver(o.drivers.id);
    $$('[data-assign]', body).forEach((b) => (b.onclick = () => assignDriver(o.id)));
    $('#ocopy').onclick = () => navigator.clipboard?.writeText(o.id).then(() => toast('Copied', 'ok'));
    const c = $('#ocancel');
    if (c) c.onclick = async () => {
      const v = await ask({ title: 'Cancel this order?', text: 'The customer and driver get a notification. Paid orders and used coins are refunded automatically.', danger: true, ok: 'Cancel order',
        fields: [{ name: 'reason', label: 'Reason', type: 'select', value: 'admin', options: [['admin', 'Cancelled by JURTO support'], ['customer_request', 'Customer asked to cancel'], ['no_driver_found', 'No driver available'], ['fraud', 'Suspected fraud']] }] });
      if (!v) return;
      try {
        await q(sb.from('orders').update({ status: 'cancelled', cancelled_by: 'admin', cancellation_reason: v.reason, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id));
        toast('Order cancelled', 'ok');
        openOrder(id);
        refreshSoon();
      } catch (e) { fail(e); }
    };
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- drivers ---------- */
S.drvTab = 'all';
async function driverBalances() {
  const rows = await q(sb.from('driver_wallet_ledger').select('driver_id,amount').limit(20000));
  const m = {};
  for (const r of rows) m[r.driver_id] = (m[r.driver_id] || 0) + num(r.amount);
  return m;
}
PAGES.drivers = async (el) => {
  const [drivers, bal] = await Promise.all([
    q(sb.from('drivers').select('id,first_name,last_name,phone,is_active,is_verified,is_online,rating,total_rides,created_at,fleet_owner_id,fleet_owners(business_name),vehicles(registration_number,model,vehicle_type_id,is_active),driver_documents(status)').order('created_at', { ascending: false }).limit(1000)),
    driverBalances(),
  ]);
  const counts = {
    all: drivers.length,
    online: drivers.filter((d) => d.is_online && d.is_active).length,
    verify: drivers.filter((d) => d.is_active && (!d.is_verified || (d.driver_documents || []).some((x) => x.status === 'pending'))).length,
    dues: drivers.filter((d) => (bal[d.id] || 0) < 0).length,
    blocked: drivers.filter((d) => !d.is_active).length,
  };
  const tab = S.drvTab;
  let rows = drivers.filter((d) => tab === 'all' ? true : tab === 'online' ? d.is_online && d.is_active : tab === 'verify' ? d.is_active && (!d.is_verified || (d.driver_documents || []).some((x) => x.status === 'pending')) : tab === 'dues' ? (bal[d.id] || 0) < 0 : !d.is_active);
  const term = (S.drvQ || '').toLowerCase();
  if (term) rows = rows.filter((d) => [name(d), d.phone, ...(d.vehicles || []).map((v) => v.registration_number)].join(' ').toLowerCase().includes(term));
  const tabs = [['all', 'All'], ['online', 'Online'], ['verify', 'To verify'], ['dues', 'Owe dues'], ['blocked', 'Blocked']];
  const oweTotal = Object.values(bal).filter((v) => v < 0).reduce((a, v) => a - v, 0);
  el.innerHTML = `
  ${stats([
    ['drivers', 'blue', 'Drivers', counts.all, `${drivers.filter((d) => new Date(d.created_at) > weekAgo()).length} joined this week`],
    ['activity', 'green', 'Online now', counts.online, `${drivers.filter((d) => d.is_verified && d.is_active).length} verified`],
    ['shield', counts.verify ? 'red' : 'grey', 'To verify', counts.verify, 'new drivers or documents'],
    ['rupee', counts.dues ? 'amber' : 'grey', 'Dues owed', rupees(oweTotal), `${counts.dues} drivers`],
  ])}
  <div class="toolbar">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}<span class="c">${counts[k]}</span></button>`).join('')}</div>
    <div class="grow"></div>${searchBox('dq', 'Name, phone, vehicle number', S.drvQ)}
  </div>
  <div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Driver</th><th>Vehicle</th><th>Status</th><th class="right">Trips</th><th class="right">Rating</th><th class="right">Wallet</th><th>Joined</th></tr></thead><tbody>
    ${rows.map((d) => {
      const v = (d.vehicles || []).find((x) => x.is_active) || (d.vehicles || [])[0];
      const b = bal[d.id] || 0;
      const pend = (d.driver_documents || []).filter((x) => x.status === 'pending').length;
      return `<tr class="row" data-d="${d.id}">
        <td><div class="who"><span class="avatar">${initial(d)}</span><div><b>${esc(name(d))}</b><small>${esc(d.phone || '')}${d.fleet_owners ? ' · ' + esc(d.fleet_owners.business_name || 'Fleet') : ''}</small></div></div></td>
        <td class="small">${v ? `<b class="mono">${esc((v.registration_number || '').toUpperCase())}</b><div class="muted">${esc(S.vtypes[v.vehicle_type_id] || '')}</div>` : '<span class="dim">No vehicle</span>'}</td>
        <td>${!d.is_active ? chip('no', 'Blocked') : !d.is_verified ? chip('pending', 'Not verified') : d.is_online ? chip('ok', 'Online') : chip('grey', 'Offline')}${pend ? ` <span class="chip pending">${pend} docs</span>` : ''}</td>
        <td class="right">${num(d.total_rides)}</td><td class="right"><span class="star">★</span> ${num(d.rating).toFixed(1)}</td>
        <td class="right strong" style="color:${b < 0 ? 'var(--red2)' : b > 0 ? '#86EFAC' : 'inherit'}">${b < 0 ? '−' : ''}${rupees(Math.abs(b))}</td>
        <td class="small muted nowrap">${fmtDate(d.created_at)}</td></tr>`;
    }).join('')}</tbody></table>` : empty('drivers', 'No drivers here')}</div>`;
  $('#psub').textContent = `${counts.online} online · ${counts.verify} to verify`;
  $$('.tab', el).forEach((b) => (b.onclick = () => { S.drvTab = b.dataset.t; PAGES.drivers(el); }));
  const dq = $('#dq');
  dq.oninput = debounce(() => { S.drvQ = dq.value; PAGES.drivers(el).then(() => { const n = $('#dq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300);
  $$('tr[data-d]', el).forEach((r) => (r.onclick = () => openDriver(r.dataset.d)));
};

/* ---------- assign a driver by hand ---------- */
const ASSIGN_ERR = {
  driver_on_a_trip: 'This driver is already on a trip.',
  vehicle_type_mismatch: 'This driver has no active vehicle of the booked type.',
  order_not_available: 'This order is no longer waiting for a driver.',
  driver_not_eligible: 'This driver is blocked or not verified.',
};
async function assignDriver(orderId) {
  const body = openDrawer('Assign driver · #' + shortId(orderId));
  try {
    const [o, list] = await Promise.all([
      q(sb.from('orders').select('id,status,pickup_address,dropoff_address,estimated_fare,vehicle_type_id,created_at').eq('id', orderId).single()),
      q(sb.rpc('admin_driver_candidates', { p_order: orderId })),
    ]);
    $('#dhead').innerHTML = chip(o.status);
    const free = list.filter((d) => d.online && !d.busy).length;
    body.innerHTML = `
      <div class="sec"><div class="route small"><div class="p">${esc(o.pickup_address)}</div><div class="d">${esc(o.dropoff_address)}</div></div>
        <div class="small muted" style="margin-top:8px">${esc(S.vtypes[o.vehicle_type_id] || '')} · ${rupees(o.estimated_fare)} · booked ${ago(o.created_at)}</div></div>
      <div class="small muted">${list.length ? `${list.length} drivers with a ${esc(S.vtypes[o.vehicle_type_id] || 'matching')} vehicle · <b>${free} free and online</b>. Nearest first. Call the driver before assigning if they are offline.` : ''}</div>
      ${list.length ? `<div class="cands">${list.map((d) => `<div class="cand ${d.busy ? 'off' : ''}">
        <span class="avatar">${esc((d.name || 'D')[0].toUpperCase())}</span>
        <div class="cm"><b>${esc(d.name || 'Driver')}</b>
          <div class="small muted"><span class="mono">${esc((d.vehicle || '').toUpperCase())}</span> · <a href="tel:${esc(d.phone)}">${esc(d.phone || '')}</a> · <span class="star">★</span> ${num(d.rating).toFixed(1)}</div>
          <div class="tags">${d.busy ? chip('pending', 'On a trip') : d.online ? chip('ok', 'Online') : chip('grey', 'Offline' + (d.last_seen ? ' · seen ' + ago(d.last_seen) : ''))}
            ${d.declined ? chip('no', 'Passed on this order') : ''}${d.over_limit ? chip('no', 'Dues ' + rupees(d.dues)) : ''}</div></div>
        <div class="ck">${d.km != null ? `<b>${num(d.km).toFixed(1)} km</b><span>from pickup</span>` : '<span>no location</span>'}
          <button class="btn sm ${d.busy ? '' : 'primary'}" data-pick="${d.id}" ${d.busy ? 'disabled' : ''}>Assign</button></div>
      </div>`).join('')}</div>` : empty('drivers', 'No verified driver has an active vehicle of this type yet.')}`;
    $$('[data-pick]', body).forEach((b) => (b.onclick = async () => {
      const d = list.find((x) => x.id === b.dataset.pick);
      const v = await ask({ title: 'Assign this trip?', ok: 'Assign',
        text: `<b>${esc(d.name || 'Driver')}</b> gets the trip now and a notification on the phone. The customer is told the driver is on the way.${d.online ? '' : '<br><br>⚠️ This driver is offline. Call them first so they open the app.'}${d.over_limit ? '<br><br>⚠️ This driver owes more than the dues limit.' : ''}` });
      if (!v) return;
      b.disabled = true;
      try {
        await q(sb.rpc('admin_assign_driver', { p_order: orderId, p_driver: d.id }));
        toast(`Trip assigned to <b>${esc(d.name || 'driver')}</b>`, 'ok');
        openOrder(orderId);
        if (['dashboard', 'live', 'orders'].includes(S.route)) PAGES[S.route]($('#page'), true).catch(() => {});
      } catch (e) {
        b.disabled = false;
        const k = Object.keys(ASSIGN_ERR).find((x) => String(e.message).includes(x));
        fail(k ? ASSIGN_ERR[k] : e);
      }
    }));
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

const DOC_LABEL = { driving_license: 'Driving licence', rc_book: 'RC book', id_proof: 'ID proof', insurance: 'Insurance', profile_photo: 'Photo', vehicle_photo: 'Vehicle photo' };
async function openDriver(id) {
  const body = openDrawer('Driver');
  try {
    const [d, docs, ledger, bank, trips] = await Promise.all([
      q(sb.from('drivers').select('*, fleet_owners(business_name), vehicles(id,registration_number,model,color,vehicle_type_id,is_active)').eq('id', id).single()),
      q(sb.from('driver_documents').select('*').eq('driver_id', id).order('created_at', { ascending: false })),
      q(sb.from('driver_wallet_ledger').select('entry_type,amount,note,created_at,order_id').eq('driver_id', id).order('created_at', { ascending: false }).limit(200)),
      q(sb.from('driver_bank_accounts').select('*').eq('driver_id', id).maybeSingle()),
      q(sb.from('orders').select('id,status,created_at,final_fare,estimated_fare,driver_earning').eq('driver_id', id).order('created_at', { ascending: false }).limit(10)),
    ]);
    const bal = ledger.reduce((t, r) => t + num(r.amount), 0);
    $('#dtitle').textContent = name(d);
    $('#dhead').innerHTML = !d.is_active ? chip('no', 'Blocked') : !d.is_verified ? chip('pending', 'Not verified') : d.is_online ? chip('ok', 'Online') : chip('grey', 'Offline');
    const urls = await Promise.all(docs.map(async (x) => {
      if (!x.document_url) return '';
      if (/^https?:/.test(x.document_url)) return x.document_url;
      const { data } = await sb.storage.from('kyc-docs').createSignedUrl(x.document_url, 900);
      return data?.signedUrl || '';
    }));
    body.innerHTML = `
      <div class="sec"><div class="who"><span class="avatar" style="width:52px;height:52px;font-size:20px">${initial(d)}</span><div><b style="font-size:17px">${esc(name(d))}</b><small><a href="tel:${esc(d.phone)}">${esc(d.phone || '')}</a> · ${esc(d.email || '')}</small></div></div>
        <dl class="kv" style="margin-top:14px">
          <dt>Trips</dt><dd>${num(d.total_rides)} · ⭐ ${num(d.rating).toFixed(1)}</dd>
          <dt>Licence</dt><dd class="mono">${esc(d.license_number || '—')}${d.license_expiry ? ' · exp ' + esc(d.license_expiry) : ''}</dd>
          <dt>Fleet</dt><dd>${esc(d.fleet_owners?.business_name || 'Independent')}</dd>
          <dt>Joined</dt><dd>${fmtDate(d.created_at)}</dd>
          ${(d.vehicles || []).map((v) => `<dt>Vehicle</dt><dd><b class="mono">${esc((v.registration_number || '').toUpperCase())}</b> · ${esc(S.vtypes[v.vehicle_type_id] || '')} ${esc(v.model || '')} ${v.is_active ? '' : chip('grey', 'inactive')}</dd>`).join('')}
        </dl>
        <div class="actions" style="margin-top:14px">
          ${d.is_verified ? '<button class="btn" id="dunverify">Remove verification</button>' : '<button class="btn good" id="dverify">✓ Approve driver</button>'}
          ${d.is_active ? '<button class="btn bad" id="dblock">Block</button>' : '<button class="btn good" id="dunblock">Unblock</button>'}
        </div></div>
      <div class="sec"><h4>Documents</h4>${docs.length ? `<div class="docs">${docs.map((x, i) => `<div class="doc">
          <div class="img" data-img="${esc(urls[i])}" style="${urls[i] ? `background-image:url('${esc(urls[i])}')` : ''}">${urls[i] ? '' : 'No file'}</div>
          <div class="meta"><b class="small">${esc(DOC_LABEL[x.document_type] || x.document_type)}</b>${chip(x.status === 'approved' ? 'ok' : x.status === 'rejected' ? 'no' : 'pending', x.status)}
            ${x.status !== 'approved' ? `<button class="btn sm good" data-doc="${x.id}" data-st="approved">Approve</button>` : ''}${x.status !== 'rejected' ? `<button class="btn sm bad" data-doc="${x.id}" data-st="rejected">Reject</button>` : ''}</div></div>`).join('')}</div>` : '<span class="muted">No documents uploaded</span>'}</div>
      <div class="sec"><h4>Wallet</h4>
        <div style="display:flex;align-items:center;gap:12px"><div style="font-size:26px;font-weight:900;color:${bal < 0 ? 'var(--red2)' : 'inherit'}">${bal < 0 ? '−' : ''}${rupees2(Math.abs(bal))}</div><span class="muted small">${bal < 0 ? 'owes JURTO (cash commission)' : 'payable to driver'}</span><span class="grow" style="flex:1"></span><button class="btn sm" id="dadj">Adjust</button></div>
        ${bank ? `<div class="small muted" style="margin-top:8px">Payout to: ${esc(bank.account_holder || '')} ${bank.upi_id ? '· UPI ' + esc(bank.upi_id) : ''} ${bank.account_number ? '· A/c ••' + esc(String(bank.account_number).slice(-4)) + ' ' + esc(bank.ifsc || '') : ''}</div>` : ''}
        <div style="margin-top:10px;max-height:240px;overflow:auto">${ledger.slice(0, 40).map((r) => `<div class="small" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)"><span class="muted nowrap">${fmtDate(r.created_at)}</span><span class="grow ellipsis" style="flex:1">${esc(r.note || r.entry_type)}</span><b style="color:${num(r.amount) < 0 ? 'var(--red2)' : '#86EFAC'}">${num(r.amount) < 0 ? '−' : '+'}${rupees2(Math.abs(num(r.amount)))}</b></div>`).join('') || '<span class="muted small">No wallet entries</span>'}</div></div>
      <div class="sec"><h4>Recent trips</h4>${trips.length ? trips.map((o) => `<div class="small" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-o="${o.id}"><b class="mono">#${shortId(o.id)}</b><span class="muted">${fmtDate(o.created_at)}</span><span style="flex:1"></span>${chip(o.status)}<b>${rupees(o.final_fare ?? o.estimated_fare)}</b></div>`).join('') : '<span class="muted small">No trips yet</span>'}</div>`;
    const reload = () => { openDriver(id); if (S.route === 'drivers') PAGES.drivers($('#page')); };
    const upd = async (patch, msg) => { try { await q(sb.from('drivers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)); toast(msg, 'ok'); reload(); } catch (e) { fail(e); } };
    $('#dverify') && ($('#dverify').onclick = () => upd({ is_verified: true }, '✓ Driver approved — they can go online now'));
    $('#dunverify') && ($('#dunverify').onclick = async () => (await ask({ title: 'Remove verification?', text: 'The driver will not be able to go online until approved again.', danger: true, ok: 'Remove' })) && upd({ is_verified: false, is_online: false }, 'Verification removed'));
    $('#dblock') && ($('#dblock').onclick = async () => (await ask({ title: 'Block this driver?', text: 'They go offline and cannot take orders.', danger: true, ok: 'Block' })) && upd({ is_active: false, is_online: false }, 'Driver blocked'));
    $('#dunblock') && ($('#dunblock').onclick = () => upd({ is_active: true }, 'Driver unblocked'));
    $$('[data-doc]', body).forEach((b) => (b.onclick = async () => {
      try { await q(sb.from('driver_documents').update({ status: b.dataset.st, verified_at: b.dataset.st === 'approved' ? new Date().toISOString() : null }).eq('id', b.dataset.doc)); toast('Document ' + b.dataset.st, 'ok'); reload(); } catch (e) { fail(e); }
    }));
    $$('[data-img]', body).forEach((x) => x.dataset.img && (x.onclick = () => lightbox(x.dataset.img)));
    $$('[data-o]', body).forEach((x) => (x.onclick = () => openOrder(x.dataset.o)));
    $('#dadj').onclick = async () => {
      const v = await ask({ title: 'Adjust driver wallet', text: 'Use + to credit the driver, − to debit. Every change is kept in the ledger.',
        fields: [
          { name: 'type', label: 'Type', type: 'select', value: 'dues_payment', options: [['dues_payment', 'Dues paid to JURTO (cash/UPI received)'], ['adjustment', 'Manual adjustment']] },
          { name: 'amount', label: 'Amount (₹)', type: 'number', placeholder: 'e.g. 500 or -200', required: true },
          { name: 'note', label: 'Note', placeholder: 'Reason, UPI ref…', required: true },
        ] });
      if (!v) return;
      try { await q(sb.rpc('admin_wallet_adjust', { p_driver: id, p_amount: Number(v.amount), p_type: v.type, p_note: v.note })); toast('Wallet updated', 'ok'); reload(); } catch (e) { fail(e); }
    };
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function lightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(src)}" alt="">`;
  lb.onclick = () => lb.remove();
  document.body.append(lb);
}

/* ---------- customers ---------- */
PAGES.customers = async (el) => {
  const rows = await q(sb.from('customers').select('id,first_name,last_name,phone,email,is_active,total_rides,created_at,referred_by_code').order('created_at', { ascending: false }).limit(1000));
  const term = (S.custQ || '').toLowerCase();
  const shown = term ? rows.filter((c) => [name(c), c.phone, c.email].join(' ').toLowerCase().includes(term)) : rows;
  el.innerHTML = `
  ${stats([
    ['customers', 'blue', 'Customers', rows.length, 'all sign-ups'],
    ['activity', 'green', 'New this week', rows.filter((c) => new Date(c.created_at) > weekAgo()).length, 'joined in the last 7 days'],
    ['orders', 'violet', 'Have booked', rows.filter((c) => num(c.total_rides) > 0).length, rows.length ? Math.round((rows.filter((c) => num(c.total_rides) > 0).length / rows.length) * 100) + '% of customers' : ''],
    ['xc', 'grey', 'Blocked', rows.filter((c) => !c.is_active).length, ''],
  ])}
  <div class="toolbar"><div class="grow"></div>${searchBox('cq', 'Name, phone, email', S.custQ)}</div>
  <div class="tbl-wrap">${shown.length ? `<table><thead><tr><th>Customer</th><th>Email</th><th class="right">Bookings</th><th>Status</th><th>Joined</th></tr></thead><tbody>
    ${shown.map((c) => `<tr class="row" data-c="${c.id}"><td><div class="who"><span class="avatar">${initial(c)}</span><div><b>${esc(name(c))}</b><small>${esc(c.phone || '')}</small></div></div></td>
      <td class="small muted">${esc(c.email || '')}</td><td class="right">${num(c.total_rides)}</td><td>${c.is_active ? chip('ok', 'Active') : chip('no', 'Blocked')}</td><td class="small muted nowrap">${fmtDate(c.created_at)}</td></tr>`).join('')}
  </tbody></table>` : empty('customers', 'No customers')}</div>`;
  $('#psub').textContent = `${rows.length} customers`;
  const cq = $('#cq');
  cq.oninput = debounce(() => { S.custQ = cq.value; PAGES.customers(el).then(() => { const n = $('#cq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300);
  $$('tr[data-c]', el).forEach((r) => (r.onclick = () => openCustomer(r.dataset.c)));
};
async function openCustomer(id) {
  const body = openDrawer('Customer');
  try {
    const [c, orders, wallet, coins] = await Promise.all([
      q(sb.from('customers').select('*').eq('id', id).single()),
      q(sb.from('orders').select('id,status,created_at,final_fare,estimated_fare,payable_fare').eq('customer_id', id).order('created_at', { ascending: false }).limit(20)),
      q(sb.from('customer_wallet_ledger').select('amount,entry_type,note,created_at').eq('customer_id', id).order('created_at', { ascending: false }).limit(200)),
      q(sb.from('customer_coin_ledger').select('delta,reason,note,created_at').eq('customer_id', id).order('created_at', { ascending: false }).limit(200)),
    ]);
    $('#dtitle').textContent = name(c);
    $('#dhead').innerHTML = c.is_active ? chip('ok', 'Active') : chip('no', 'Blocked');
    const wb = wallet.reduce((t, r) => t + num(r.amount), 0), cb = coins.reduce((t, r) => t + num(r.delta), 0);
    const spent = orders.filter((o) => o.status === 'completed').reduce((t, o) => t + num(o.payable_fare ?? o.final_fare ?? o.estimated_fare), 0);
    body.innerHTML = `
      <div class="sec"><div class="who"><span class="avatar" style="width:52px;height:52px;font-size:20px">${initial(c)}</span><div><b style="font-size:17px">${esc(name(c))}</b><small><a href="tel:${esc(c.phone)}">${esc(c.phone || '')}</a> · ${esc(c.email || '')}</small></div></div>
        <div class="grid three" style="margin-top:14px">
          <div class="card kpi"><div class="lbl">Bookings</div><div class="val">${num(c.total_rides)}</div></div>
          <div class="card kpi"><div class="lbl">Wallet</div><div class="val">${rupees(wb)}</div></div>
          <div class="card kpi"><div class="lbl">JURTO Coins</div><div class="val">🪙 ${cb}</div></div>
        </div>
        <dl class="kv" style="margin-top:12px"><dt>Spent (recent)</dt><dd>${rupees(spent)}</dd><dt>Joined</dt><dd>${fmtDate(c.created_at)}</dd>${c.referred_by_code ? `<dt>Referred by</dt><dd class="mono">${esc(c.referred_by_code)}</dd>` : ''}</dl>
        <div class="actions" style="margin-top:12px">${c.is_active ? '<button class="btn bad" id="cblock">Block customer</button>' : '<button class="btn good" id="cunblock">Unblock</button>'}</div></div>
      <div class="sec"><h4>Bookings</h4>${orders.length ? orders.map((o) => `<div class="small" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-o="${o.id}"><b class="mono">#${shortId(o.id)}</b><span class="muted">${fmtDate(o.created_at)}</span><span style="flex:1"></span>${chip(o.status)}<b>${rupees(o.payable_fare ?? o.final_fare ?? o.estimated_fare)}</b></div>`).join('') : '<span class="muted small">No bookings</span>'}</div>
      <div class="sec"><h4>Wallet & coins</h4>${[...wallet.map((r) => ({ t: r.created_at, l: r.note || r.entry_type, v: rupees2(r.amount), n: num(r.amount) })), ...coins.map((r) => ({ t: r.created_at, l: '🪙 ' + (r.note || r.reason), v: r.delta + ' coins', n: num(r.delta) }))].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 30)
        .map((r) => `<div class="small" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)"><span class="muted nowrap">${fmtDate(r.t)}</span><span style="flex:1" class="ellipsis">${esc(r.l)}</span><b style="color:${r.n < 0 ? 'var(--red2)' : '#86EFAC'}">${r.n > 0 ? '+' : ''}${esc(r.v)}</b></div>`).join('') || '<span class="muted small">Nothing yet</span>'}</div>`;
    const upd = async (patch, msg) => { try { await q(sb.from('customers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)); toast(msg, 'ok'); openCustomer(id); } catch (e) { fail(e); } };
    $('#cblock') && ($('#cblock').onclick = async () => (await ask({ title: 'Block this customer?', text: 'They will not be able to place new bookings.', danger: true, ok: 'Block' })) && upd({ is_active: false }, 'Customer blocked'));
    $('#cunblock') && ($('#cunblock').onclick = () => upd({ is_active: true }, 'Customer unblocked'));
    $$('[data-o]', body).forEach((x) => (x.onclick = () => openOrder(x.dataset.o)));
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- fleets ---------- */
PAGES.fleets = async (el) => {
  const [rows, drivers] = await Promise.all([
    q(sb.from('fleet_owners').select('*').order('created_at', { ascending: false })),
    q(sb.from('drivers').select('fleet_owner_id').not('fleet_owner_id', 'is', null)),
  ]);
  const cnt = {};
  for (const d of drivers) cnt[d.fleet_owner_id] = (cnt[d.fleet_owner_id] || 0) + 1;
  el.innerHTML = `${stats([
    ['fleets', 'blue', 'Fleet owners', rows.length, ''],
    ['shield', 'green', 'Verified', rows.filter((f) => f.is_active && f.is_verified).length, ''],
    ['file', rows.some((f) => f.is_active && !f.is_verified) ? 'red' : 'grey', 'To verify', rows.filter((f) => f.is_active && !f.is_verified).length, 'check GST and business'],
    ['drivers', 'violet', 'Fleet drivers', drivers.length, 'drivers under a fleet'],
  ])}<div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Owner</th><th>Business</th><th>GST</th><th class="right">Drivers</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((f) => `<tr><td><div class="who"><span class="avatar">${initial(f)}</span><div><b>${esc(name(f))}</b><small>${esc(f.phone || '')}</small></div></div></td>
      <td>${esc(f.business_name || '—')}<div class="small muted">${esc(f.city || '')}</div></td><td class="mono small">${esc(f.gst_number || '—')}</td><td class="right">${cnt[f.id] || 0}</td>
      <td>${!f.is_active ? chip('no', 'Inactive') : f.is_verified ? chip('ok', 'Verified') : chip('pending', 'To verify')}</td>
      <td class="right">${f.is_active ? (f.is_verified ? `<button class="btn sm" data-f="${f.id}" data-v="0">Unverify</button>` : `<button class="btn sm good" data-f="${f.id}" data-v="1">Verify</button>`) : ''}</td></tr>`).join('')}
  </tbody></table>` : empty('fleets', 'No fleet owners yet')}</div>`;
  $('#psub').textContent = `${rows.length} fleet owners`;
  $$('[data-f]', el).forEach((b) => (b.onclick = async () => {
    try { await q(sb.from('fleet_owners').update({ is_verified: b.dataset.v === '1', updated_at: new Date().toISOString() }).eq('id', b.dataset.f)); toast('Updated', 'ok'); PAGES.fleets(el); } catch (e) { fail(e); }
  }));
};

/* ---------- payouts & dues ---------- */
PAGES.payouts = async (el) => {
  const [reqs, dues, bal] = await Promise.all([
    q(sb.from('payout_requests').select('*, drivers(id,first_name,last_name,phone)').order('created_at', { ascending: false }).limit(300)),
    q(sb.from('driver_dues_payments').select('*, drivers(id,first_name,last_name,phone)').order('created_at', { ascending: false }).limit(100)),
    driverBalances(),
  ]);
  const owe = Object.values(bal).filter((v) => v < 0).reduce((t, v) => t - v, 0);
  const pendingAmt = reqs.filter((r) => r.status === 'pending').reduce((t, r) => t + num(r.amount), 0);
  el.innerHTML = `
  ${stats([
    ['payouts', pendingAmt ? 'red' : 'grey', 'Payouts to send', rupees(pendingAmt), `${reqs.filter((r) => r.status === 'pending').length} requests waiting`],
    ['rupee', owe ? 'amber' : 'grey', 'Drivers owe JURTO', rupees(owe), 'cash commission not yet paid'],
    ['check', 'green', 'Dues paid online', rupees(dues.filter((d) => d.status === 'completed' || d.status === 'paid').reduce((t, d) => t + num(d.amount), 0)), `last ${dues.length} payments`],
    ['bank', 'blue', 'Paid out', rupees(reqs.filter((r) => r.status === 'paid').reduce((t, r) => t + num(r.amount), 0)), `${reqs.filter((r) => r.status === 'paid').length} withdrawals`],
  ])}
  <div class="card" style="margin-top:16px"><div class="ch"><div><h3>Withdrawal requests</h3><div class="cs">Send the money by UPI / bank first, then mark it paid</div></div></div>${reqs.length ? `<div class="tbl-wrap" style="border:0"><table><thead><tr><th>Driver</th><th class="right">Amount</th><th>Send to</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>
    ${reqs.map((r) => { const a = r.account_snapshot || {}; return `<tr><td><div class="who" style="cursor:pointer" data-d="${r.drivers?.id}"><span class="avatar">${initial(r.drivers)}</span><div><b>${esc(name(r.drivers))}</b><small>${esc(r.drivers?.phone || '')}</small></div></div></td>
      <td class="right strong">${rupees2(r.amount)}</td>
      <td class="small">${a.upi_id ? 'UPI <b class="mono">' + esc(a.upi_id) + '</b>' : ''}${a.account_number ? `<div>${esc(a.account_holder || '')} · <span class="mono">${esc(a.account_number)}</span> · ${esc(a.ifsc || '')}</div>` : ''}${!a.upi_id && !a.account_number ? '<span class="dim">—</span>' : ''}</td>
      <td class="small muted nowrap">${fmtDate(r.created_at)}</td>
      <td>${r.status === 'pending' ? chip('pending', 'Pending') : r.status === 'paid' ? chip('ok', 'Paid') : chip('no', 'Rejected')}${r.reference ? `<div class="small muted mono">${esc(r.reference)}</div>` : ''}</td>
      <td class="right nowrap">${r.status === 'pending' ? `<button class="btn sm good" data-p="${r.id}" data-s="paid">Mark paid</button> <button class="btn sm bad" data-p="${r.id}" data-s="rejected">Reject</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>` : empty('payouts', 'No withdrawal requests')}</div>
  <div class="card" style="margin-top:16px"><div class="ch"><div><h3>Driver dues payments</h3><div class="cs">Paid online from the driver app</div></div></div>${dues.length ? dues.map((d) => `<div class="small" style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><b>${esc(name(d.drivers))}</b><span class="muted">${fmtDate(d.created_at)}</span><span style="flex:1"></span>${chip(d.status === 'completed' || d.status === 'paid' ? 'ok' : d.status === 'failed' ? 'no' : 'grey', d.status)}<b>${rupees2(d.amount)}</b></div>`).join('') : empty('rupee', 'No dues payments yet')}</div>`;
  $$('[data-d]', el).forEach((x) => x.dataset.d && (x.onclick = () => openDriver(x.dataset.d)));
  $$('[data-p]', el).forEach((b) => (b.onclick = async () => {
    const paid = b.dataset.s === 'paid';
    const v = await ask({ title: paid ? 'Mark payout as paid' : 'Reject payout', text: paid ? 'Send the money first (UPI/bank), then save the transfer reference here.' : 'The amount goes back to the driver’s wallet.', danger: !paid, ok: paid ? 'Mark paid' : 'Reject',
      fields: [{ name: 'ref', label: paid ? 'UPI / bank reference' : 'Reason', required: true }] });
    if (!v) return;
    try { await q(sb.rpc('admin_settle_payout', { p_id: b.dataset.p, p_status: b.dataset.s, p_reference: v.ref })); toast(paid ? 'Payout marked paid' : 'Payout rejected', 'ok'); PAGES.payouts(el); } catch (e) { fail(e); }
  }));
};

/* ---------- pricing ---------- */
PAGES.pricing = async (el) => {
  const [vt, commission] = await Promise.all([
    q(sb.from('vehicle_types').select('*').order('base_rate')),
    q(sb.from('app_settings').select('value').eq('key', 'commission').maybeSingle()),
  ]);
  const defPct = num(commission?.value?.percent ?? 15);
  const cols = [['base_rate', 'Base ₹'], ['included_km', 'Incl. km'], ['per_km_rate', '₹ / km'], ['per_min_rate', '₹ / min'], ['free_minutes', 'Free min'], ['capacity_kg', 'Max kg'], ['commission_percent', 'Commission %']];
  el.innerHTML = `
  ${stats([
    ['drivers', 'blue', 'Vehicle types', vt.length, `${vt.filter((v) => v.is_active).length} active in the app`],
    ['rupee', 'green', 'Lowest base fare', vt.length ? rupees(Math.min(...vt.map((v) => num(v.base_rate)))) : '—', ''],
    ['rupee', 'violet', 'Highest base fare', vt.length ? rupees(Math.max(...vt.map((v) => num(v.base_rate)))) : '—', ''],
    ['bank', 'amber', 'Default commission', defPct + '%', 'change it in Settings'],
  ])}
  <div class="card" style="margin-top:16px"><div class="ch"><div><h3>Vehicle fares</h3><div class="cs">Edit a row and press Save · commission blank = default ${defPct}%</div></div></div>
    <div class="tbl-wrap" style="border:0"><table><thead><tr><th>Vehicle</th>${cols.map((c) => `<th>${c[1]}</th>`).join('')}<th>Active</th><th></th></tr></thead><tbody>
    ${vt.map((v) => `<tr data-v="${v.id}"><td><b>${esc(v.type_name)}</b><div class="small muted">${esc(v.body_size || '')}</div></td>
      ${cols.map(([k]) => `<td><input class="cell-in" type="number" step="0.5" name="${k}" value="${v[k] ?? ''}"></td>`).join('')}
      <td><label class="switch"><input type="checkbox" name="is_active" ${v.is_active ? 'checked' : ''}></label></td>
      <td><button class="btn sm primary" data-save="${v.id}">Save</button></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">Example: a 10 km trip in a vehicle with ₹220 base, 2 km included and ₹20/km costs about ₹220 + 8 × ₹20 = ₹380. New fares apply to new bookings.</p></div>`;
  $$('[data-save]', el).forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    const patch = {};
    for (const [k] of cols) { const v = $(`[name="${k}"]`, tr).value; patch[k] = v === '' ? null : Number(v); }
    patch.is_active = $('[name=is_active]', tr).checked;
    try { await q(sb.from('vehicle_types').update(patch).eq('id', b.dataset.save)); toast('Fares saved', 'ok'); } catch (e) { fail(e); }
  }));
};

/* ---------- promos ---------- */
PAGES.promos = async (el) => {
  const rows = await q(sb.from('promo_codes').select('*').order('created_at', { ascending: false }));
  const live = rows.filter((p) => p.is_active && (!p.valid_to || new Date(p.valid_to) > new Date()));
  el.innerHTML = `
  ${stats([
    ['promos', 'blue', 'Promo codes', rows.length, ''],
    ['check', 'green', 'Running now', live.length, 'active and not expired'],
    ['customers', 'violet', 'First booking only', rows.filter((p) => p.first_order_only).length, ''],
    ['xc', 'grey', 'Off or expired', rows.length - live.length, ''],
  ])}
  <div class="toolbar"><div class="grow"></div><button class="btn primary" id="pnew">＋ New promo code</button></div>
  <div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Code</th><th>Offer</th><th>Rules</th><th>Valid till</th><th>Active</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><b class="mono" style="font-size:14px">${esc(p.code)}</b><div class="small muted">${esc(p.description || '')}</div></td>
      <td class="strong">${p.discount_type === 'percent' ? num(p.discount_value) + '% off' + (p.max_discount ? ` (max ${rupees(p.max_discount)})` : '') : rupees(p.discount_value) + ' off'}</td>
      <td class="small muted">${p.min_fare ? 'Min fare ' + rupees(p.min_fare) + '<br>' : ''}${p.first_order_only ? 'First booking only<br>' : ''}${p.per_customer_limit ? p.per_customer_limit + ' per customer' : ''}${p.max_uses ? ' · ' + p.max_uses + ' total' : ''}</td>
      <td class="small">${p.valid_to ? fmtDate(p.valid_to) : '<span class="dim">No end</span>'}</td>
      <td><label class="switch"><input type="checkbox" data-code="${esc(p.code)}" ${p.is_active ? 'checked' : ''}></label></td></tr>`).join('')}
  </tbody></table>` : empty('promos', 'No promo codes')}</div>`;
  $$('[data-code]', el).forEach((c) => (c.onchange = async () => {
    try { await q(sb.from('promo_codes').update({ is_active: c.checked }).eq('code', c.dataset.code)); toast(c.checked ? 'Promo turned on' : 'Promo turned off', 'ok'); } catch (e) { fail(e); c.checked = !c.checked; }
  }));
  $('#pnew').onclick = async () => {
    const v = await ask({ title: 'New promo code', ok: 'Create', fields: [
      { name: 'code', label: 'Code (A–Z, 0–9)', placeholder: 'DIWALI100', required: true },
      { name: 'description', label: 'Shown to customers', placeholder: '₹100 off this Diwali', required: true },
      { name: 'type', label: 'Discount', type: 'select', value: 'flat', options: [['flat', 'Flat ₹ off'], ['percent', '% off']] },
      { name: 'value', label: 'Value (₹ or %)', type: 'number', required: true },
      { name: 'max', label: 'Max discount ₹ (for %)', type: 'number' },
      { name: 'min', label: 'Minimum fare ₹', type: 'number' },
      { name: 'first', label: 'Who can use', type: 'select', value: 'all', options: [['all', 'All customers'], ['first', 'First booking only']] },
      { name: 'per', label: 'Uses per customer', type: 'number', value: '1' },
      { name: 'to', label: 'Valid till (optional)', type: 'date' },
    ] });
    if (!v) return;
    try {
      await q(sb.from('promo_codes').insert({
        code: v.code.toUpperCase().replace(/[^A-Z0-9]/g, ''), description: v.description, discount_type: v.type, discount_value: Number(v.value),
        max_discount: v.max ? Number(v.max) : null, min_fare: v.min ? Number(v.min) : 0, first_order_only: v.first === 'first',
        per_customer_limit: v.per ? Number(v.per) : 1, valid_to: v.to ? new Date(v.to + 'T23:59:59+05:30').toISOString() : null, is_active: true,
      }));
      toast('Promo code created', 'ok');
      PAGES.promos(el);
    } catch (e) { fail(e); }
  };
};

/* ---------- support ---------- */
PAGES.support = async (el) => {
  const rows = await q(sb.from('support_tickets').select('*, customers(id,first_name,last_name,phone)').order('created_at', { ascending: false }).limit(300));
  const open = rows.filter((t) => !['resolved', 'closed'].includes(t.status || 'open'));
  el.innerHTML = `${stats([
    ['support', open.length ? 'red' : 'grey', 'Open', rows.filter((t) => (t.status || 'open') === 'open').length, 'waiting for a reply'],
    ['activity', 'amber', 'In progress', rows.filter((t) => t.status === 'in_progress').length, ''],
    ['check', 'green', 'Resolved', rows.filter((t) => ['resolved', 'closed'].includes(t.status)).length, ''],
    ['customers', 'blue', 'This week', rows.filter((t) => new Date(t.created_at) > weekAgo()).length, 'new tickets'],
  ])}<div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Customer</th><th>Issue</th><th>Order</th><th>Raised</th><th>Status</th></tr></thead><tbody>
    ${rows.map((t) => `<tr><td><div class="who" style="cursor:pointer" data-c="${t.customers?.id || ''}"><span class="avatar">${initial(t.customers)}</span><div><b>${esc(name(t.customers))}</b><small><a href="tel:${esc(t.customers?.phone)}">${esc(t.customers?.phone || '')}</a></small></div></div></td>
      <td><b>${esc(t.subject || '')}</b><div class="small muted" style="max-width:420px;white-space:pre-wrap">${esc(t.description || '')}</div></td>
      <td>${t.order_id ? `<a href="#" class="mono" data-o="${t.order_id}">#${shortId(t.order_id)}</a>` : '—'}</td>
      <td class="small muted nowrap">${fmtDate(t.created_at)}</td>
      <td><select class="cell-in" data-t="${t.id}">${[['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']].map(([k, l]) => `<option value="${k}" ${(t.status || 'open') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}
  </tbody></table>` : empty('support', 'No support tickets. Customers raise them from Account → Support.')}</div>`;
  $('#psub').textContent = `${open.length} open`;
  $$('[data-t]', el).forEach((s) => (s.onchange = async () => { try { await q(sb.from('support_tickets').update({ status: s.value }).eq('id', s.dataset.t)); toast('Ticket updated', 'ok'); } catch (e) { fail(e); } }));
  $$('[data-o]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openOrder(a.dataset.o); }));
  $$('[data-c]', el).forEach((a) => a.dataset.c && (a.onclick = () => openCustomer(a.dataset.c)));
};

/* ---------- settings ---------- */
const SETTING_FORMS = [
  ['commission', `${ico('bank', 16)} Commission`, [['percent', 'Default commission %', 'JURTO keeps this % of every completed fare (unless the vehicle has its own %).']]],
  ['order_timeout', `${ico('activity', 16)} Order timeout`, [['minutes', 'Minutes to find a driver', 'After this, a pending order is cancelled as "no driver found".']]],
  ['near_alert', `${ico('live', 16)} Driver almost-there alert`, [['meters', 'Distance in metres', 'Customer gets “Driver is almost there” at this distance. 0 turns it off.']]],
  ['coins', `${ico('rupee', 16)} JURTO Coins`, [['earn_per', 'Earn 1 coin per ₹', 'Lower = more coins.'], ['value', '₹ value of 1 coin', ''], ['max_pct', 'Max % of a fare paid by coins', ''], ['min_redeem', 'Minimum coins to use', '']]],
  ['wallet', `${ico('payouts', 16)} Driver wallet`, [['dues_limit', 'Dues limit ₹', 'Drivers who owe more than this cannot go online.'], ['min_withdrawal', 'Minimum withdrawal ₹', '']]],
  ['cancel_fee', `${ico('xc', 16)} Cancellation fee`, [['amount', 'Fee ₹', 'Charged when a customer cancels after the driver has come.']]],
  ['incentive', `${ico('check', 16)} Driver daily bonus`, [['trips', 'Trips in a day', ''], ['bonus', 'Bonus ₹', 'Paid once a driver finishes this many trips in a day.']]],
  ['order_limits', `${ico('orders', 16)} Customer booking limits`, [['max_active', 'Bookings in progress at once', 'A customer cannot book more until one is finished or cancelled. 0 = no limit.'], ['per_day', 'Bookings per day', 'Counted from midnight. 0 = no limit.']]],
  ['referral', `${ico('customers', 16)} Referral`, [['bonus', 'Bonus ₹ for both', 'Added to the wallet after the friend’s first booking.']]],
];
PAGES.settings = async (el) => {
  const rows = await q(sb.from('app_settings').select('key,value').order('key'));
  const val = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  el.innerHTML = `
  <div class="grid three">${SETTING_FORMS.map(([key, title, fields]) => `<div class="card" data-k="${key}"><h3>${title}</h3>
    ${fields.map(([f, l, hint]) => `<label class="field"><span>${esc(l)}</span><input class="input" type="number" step="any" name="${f}" value="${esc(val[key]?.[f] ?? '')}">${hint ? `<div class="small dim" style="margin-top:4px">${esc(hint)}</div>` : ''}</label>`).join('')}
    <button class="btn primary sm" data-s="${key}">Save</button></div>`).join('')}</div>
  <div class="card" style="margin-top:14px"><h3>All settings (advanced)<span class="grow"></span><select class="cell-in" id="sk" style="width:auto">${rows.map((r) => `<option>${esc(r.key)}</option>`).join('')}</select></h3>
    <textarea class="input" id="sv" style="min-height:260px"></textarea><div class="err" id="serr"></div>
    <div class="actions"><button class="btn primary" id="ssave">Save JSON</button><span class="small muted" style="align-self:center">Home offers, cancel fee, incentives, referral and service area live here. Apps pick up changes without an update.</span></div></div>`;
  const show = () => { $('#sv').value = JSON.stringify(val[$('#sk').value], null, 2); $('#serr').textContent = ''; };
  $('#sk').onchange = show;
  $('#sk').value = 'home_offers' in val ? 'home_offers' : rows[0]?.key || '';
  show();
  $('#ssave').onclick = async () => {
    let parsed;
    try { parsed = JSON.parse($('#sv').value); } catch (e) { return ($('#serr').textContent = 'Not valid JSON: ' + e.message); }
    try { await q(sb.from('app_settings').update({ value: parsed }).eq('key', $('#sk').value)); val[$('#sk').value] = parsed; toast('Saved ' + esc($('#sk').value), 'ok'); } catch (e) { fail(e); }
  };
  $$('[data-s]', el).forEach((b) => (b.onclick = async () => {
    const key = b.dataset.s, card = b.closest('[data-k]');
    const next = { ...(val[key] || {}) };
    for (const i of $$('input', card)) if (i.value !== '') next[i.name] = Number(i.value);
    try { await q(sb.from('app_settings').update({ value: next }).eq('key', key)); val[key] = next; toast('Saved', 'ok'); } catch (e) { fail(e); }
  }));
};

/* ---------------- start ---------------- */
sb.auth.onAuthStateChange((ev) => {
  if (ev === 'SIGNED_OUT') renderLogin();
  if (ev === 'PASSWORD_RECOVERY') setTimeout(() => renderSetPassword(), 0);
});
if (RECOVERY) {
  // opened from the reset-password email: wait for the link's session, then ask for the new password
  sb.auth.getSession().then(({ data: { session } }) => (session ? renderSetPassword() : renderLogin('That email link has expired or was already used. Ask for a new one below.')));
} else {
  if (!location.hash || LINK_ERROR) location.hash = '#/dashboard';
  boot();
}
