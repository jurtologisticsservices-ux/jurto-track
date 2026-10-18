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
const S = { user: null, admin: null, route: 'dashboard', dash: null, vtypes: {}, channel: null, live: false, maps: [], cleanup: [] };

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

/* ---------------- shell & routing ---------------- */
const NAV = [
  ['dashboard', '📊', 'Dashboard'],
  ['live', '🛰️', 'Live dispatch'],
  ['orders', '📦', 'Orders'],
  ['-', 'PEOPLE'],
  ['drivers', '🚚', 'Drivers', 'drivers_to_verify'],
  ['customers', '👤', 'Customers'],
  ['fleets', '🏢', 'Fleet owners', 'fleets_to_verify'],
  ['-', 'MONEY'],
  ['payouts', '💸', 'Payouts & dues', 'payouts_pending'],
  ['pricing', '🧮', 'Pricing'],
  ['promos', '🎁', 'Promo codes'],
  ['-', 'SYSTEM'],
  ['support', '🎧', 'Support', 'tickets_open'],
  ['settings', '⚙️', 'Settings'],
];
const TITLES = Object.fromEntries(NAV.filter((n) => n[0] !== '-').map((n) => [n[0], n[2]]));

function renderShell() {
  const qd = S.dash?.queue || {};
  $('#app').innerHTML = `
  <div class="shell">
    <nav class="side" id="side">
      <div class="brand"><div class="logo">J</div><div><b>JURTO</b><small>OPS CONSOLE</small></div></div>
      ${NAV.map((n) => n[0] === '-' ? `<div class="sep">${n[1]}</div>` : `<a class="nav" href="#/${n[0]}" data-r="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}${n[3] && qd[n[3]] ? `<span class="count">${qd[n[3]]}</span>` : ''}</a>`).join('')}
      <div class="me"><b>${esc(S.admin.first_name || S.admin.email)}</b>${esc(S.admin.admin_roles?.role_name || 'admin')}<br><a href="#" id="logout" class="muted">Sign out</a></div>
    </nav>
    <div class="main">
      <header class="top">
        <button class="btn sm menu-btn" id="menu">☰</button>
        <div><h2 id="ptitle"></h2><div class="sub" id="psub"></div></div>
        <div class="grow"></div>
        <span class="live off" id="live"><span class="dot"></span>CONNECTING</span>
        <span class="clock" id="clock"></span>
      </header>
      <main class="page" id="page"></main>
    </div>
  </div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); renderLogin(); };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
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
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'driver_locations' }, () => { if (S.route === 'live' || S.route === 'dashboard') refreshSoon(); })
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
function makeMap(el, zoom = 11) {
  const m = L.map(el, { zoomControl: true, attributionControl: true }).setView(CHENNAI, zoom);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  }).addTo(m);
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
  for (const l of drivers) {
    const p = [num(l.latitude), num(l.longitude)];
    pts.push(p);
    const isBusy = busy.has(l.driver_id);
    L.marker(p, { icon: icon(isBusy ? 'busy' : 'idle', '🚚'), zIndexOffset: 500 })
      .bindPopup(`<b>${esc(name(l.drivers))}</b><br>${isBusy ? '🟠 On a trip' : '🟢 Free'} · ${ago(l.recorded_at)}<br><a href="tel:${esc(l.drivers?.phone)}">${esc(l.drivers?.phone || '')}</a>`)
      .on('click', () => openDriver(l.driver_id)).addTo(layer);
  }
  return { layer, pts };
}

/* ================= PAGES ================= */
const PAGES = {};

/* ---------- dashboard ---------- */
PAGES.dashboard = async (el, quiet) => {
  const [d, recent] = await Promise.all([
    q(sb.rpc('admin_dashboard')),
    q(sb.from('orders').select('id,status,created_at,estimated_fare,final_fare,pickup_address,dropoff_address,vehicle_type_id,customers(first_name,last_name)').order('created_at', { ascending: false }).limit(8)),
  ]);
  S.dash = d;
  const t = d.today, lv = d.live, qd = d.queue;
  $('#psub').textContent = 'Chennai · today since midnight IST';
  const maxN = Math.max(1, ...d.week.map((w) => w.orders));
  const kpi = (ico, lbl, val, hint, cls = '') => `<div class="card kpi ${cls}"><span class="ico">${ico}</span><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="hint">${hint}</div></div>`;
  const qq = (key, n, t2, r) => `<a class="q ${n ? 'hot' : ''}" href="#/${r}"><div class="n">${n}</div><div class="t">${t2}</div></a>`;
  const html = `
  <div class="grid kpis">
    ${kpi('📦', 'Orders today', t.orders, `${t.active} active now`)}
    ${kpi('✅', 'Delivered', t.completed, t.orders ? Math.round((t.completed / t.orders) * 100) + '% completion' : 'no orders yet')}
    ${kpi('💰', 'GMV', rupees(t.gmv), 'delivered fares', 'accent')}
    ${kpi('🏦', 'JURTO earnings', rupees(t.commission), `− ${rupees(t.discounts)} promos & coins`)}
    ${kpi('🟢', 'Drivers online', `${lv.drivers_online}<span class="dim" style="font-size:16px"> / ${lv.drivers_total}</span>`, `${lv.on_trip} on a trip`)}
    ${kpi('⚠️', 'Cancelled', t.cancelled, `${t.no_driver} with no driver found`)}
  </div>
  <div class="card" style="margin-top:14px"><h3>Needs attention</h3><div class="queue">
    ${qq('d', qd.drivers_to_verify, 'Drivers to verify', 'drivers')}
    ${qq('doc', qd.docs_pending, 'Documents pending', 'drivers')}
    ${qq('f', qd.fleets_to_verify, 'Fleets to verify', 'fleets')}
    ${qq('p', qd.payouts_pending, 'Payout requests', 'payouts')}
    ${qq('t', qd.tickets_open, 'Open tickets', 'support')}
  </div></div>
  <div class="grid two" style="margin-top:14px">
    <div class="card"><h3>Live map<span class="grow"></span><a class="btn sm" href="#/live">Open dispatch →</a></h3><div class="mapbox" id="dmap"></div></div>
    <div class="card"><h3>Last 7 days</h3>
      <div class="bars">${d.week.map((w, i) => `<div class="bar ${i === d.week.length - 1 ? 'today' : ''}" title="${w.orders} orders, ${w.completed} delivered, ${rupees(w.gmv)}">
        <div class="v">${w.orders}</div>
        <div class="col" style="height:${Math.max(3, (w.orders / maxN) * 120)}px"><div class="done" style="height:${w.orders ? (w.completed / w.orders) * 100 : 0}%"></div></div>
        <div class="d">${new Date(w.day).toLocaleDateString('en-IN', { weekday: 'short' })}</div></div>`).join('')}</div>
      <div class="legend"><span><i style="background:#2B3B60"></i>Orders</span><span><i style="background:var(--red)"></i>Delivered</span><span class="grow"></span><span>All time: <b>${d.totals.orders}</b> orders · <b>${d.totals.customers}</b> customers</span></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Latest orders<span class="grow"></span><a class="btn sm" href="#/orders">All orders →</a></h3>
    ${orderTable(recent)}</div>`;
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
      </div>`;
    }).join('') : `<div class="empty"><div class="e">😌</div>No live orders right now</div>`}`;
  $$('.fo', el).forEach((f) => (f.onclick = () => openOrder(f.dataset.o)));
};

/* ---------- orders ---------- */
function orderTable(rows) {
  if (!rows.length) return `<div class="empty"><div class="e">📭</div>No orders</div>`;
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
  el.innerHTML = `
  <div class="toolbar">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="grow"></div>
    <input class="input search" id="oq" placeholder="🔎  Search order ID, phone, address" value="${esc(S.ordersQ || '')}">
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
      ['Driver assigned', o.accepted_at],
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
          <div class="small muted" style="margin-top:10px">${esc(o.vehicle_model || '')} ${esc((o.vehicle_number || '').toUpperCase())}</div>` : '<span class="muted">Not assigned</span>'}</div>
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
  el.innerHTML = `
  <div class="toolbar">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}<span class="c">${counts[k]}</span></button>`).join('')}</div>
    <div class="grow"></div><input class="input search" id="dq" placeholder="🔎  Name, phone, vehicle number" value="${esc(S.drvQ || '')}">
  </div>
  <div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Driver</th><th>Vehicle</th><th>Status</th><th class="right">Trips</th><th class="right">Rating</th><th class="right">Wallet</th><th>Joined</th></tr></thead><tbody>
    ${rows.map((d) => {
      const v = (d.vehicles || []).find((x) => x.is_active) || (d.vehicles || [])[0];
      const b = bal[d.id] || 0;
      const pend = (d.driver_documents || []).filter((x) => x.status === 'pending').length;
      return `<tr class="row" data-d="${d.id}">
        <td><div class="who"><span class="avatar">${initial(d)}</span><div><b>${esc(name(d))}</b><small>${esc(d.phone || '')}${d.fleet_owners ? ' · 🏢 ' + esc(d.fleet_owners.business_name || 'Fleet') : ''}</small></div></div></td>
        <td class="small">${v ? `<b class="mono">${esc((v.registration_number || '').toUpperCase())}</b><div class="muted">${esc(S.vtypes[v.vehicle_type_id] || '')}</div>` : '<span class="dim">No vehicle</span>'}</td>
        <td>${!d.is_active ? chip('no', 'Blocked') : !d.is_verified ? chip('pending', 'Not verified') : d.is_online ? chip('ok', 'Online') : chip('grey', 'Offline')}${pend ? ` <span class="chip pending">${pend} docs</span>` : ''}</td>
        <td class="right">${num(d.total_rides)}</td><td class="right">⭐ ${num(d.rating).toFixed(1)}</td>
        <td class="right strong" style="color:${b < 0 ? 'var(--red2)' : b > 0 ? '#86EFAC' : 'inherit'}">${b < 0 ? '−' : ''}${rupees(Math.abs(b))}</td>
        <td class="small muted nowrap">${fmtDate(d.created_at)}</td></tr>`;
    }).join('')}</tbody></table>` : `<div class="empty"><div class="e">🚚</div>No drivers here</div>`}</div>`;
  $('#psub').textContent = `${counts.online} online · ${counts.verify} to verify`;
  $$('.tab', el).forEach((b) => (b.onclick = () => { S.drvTab = b.dataset.t; PAGES.drivers(el); }));
  const dq = $('#dq');
  dq.oninput = debounce(() => { S.drvQ = dq.value; PAGES.drivers(el).then(() => { const n = $('#dq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300);
  $$('tr[data-d]', el).forEach((r) => (r.onclick = () => openDriver(r.dataset.d)));
};

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
  <div class="toolbar"><div class="grow"></div><input class="input search" id="cq" placeholder="🔎  Name, phone, email" value="${esc(S.custQ || '')}"></div>
  <div class="tbl-wrap">${shown.length ? `<table><thead><tr><th>Customer</th><th>Email</th><th class="right">Bookings</th><th>Status</th><th>Joined</th></tr></thead><tbody>
    ${shown.map((c) => `<tr class="row" data-c="${c.id}"><td><div class="who"><span class="avatar">${initial(c)}</span><div><b>${esc(name(c))}</b><small>${esc(c.phone || '')}</small></div></div></td>
      <td class="small muted">${esc(c.email || '')}</td><td class="right">${num(c.total_rides)}</td><td>${c.is_active ? chip('ok', 'Active') : chip('no', 'Blocked')}</td><td class="small muted nowrap">${fmtDate(c.created_at)}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><div class="e">👤</div>No customers</div>'}</div>`;
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
  el.innerHTML = `<div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Owner</th><th>Business</th><th>GST</th><th class="right">Drivers</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((f) => `<tr><td><div class="who"><span class="avatar">${initial(f)}</span><div><b>${esc(name(f))}</b><small>${esc(f.phone || '')}</small></div></div></td>
      <td>${esc(f.business_name || '—')}<div class="small muted">${esc(f.city || '')}</div></td><td class="mono small">${esc(f.gst_number || '—')}</td><td class="right">${cnt[f.id] || 0}</td>
      <td>${!f.is_active ? chip('no', 'Inactive') : f.is_verified ? chip('ok', 'Verified') : chip('pending', 'To verify')}</td>
      <td class="right">${f.is_active ? (f.is_verified ? `<button class="btn sm" data-f="${f.id}" data-v="0">Unverify</button>` : `<button class="btn sm good" data-f="${f.id}" data-v="1">Verify</button>`) : ''}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><div class="e">🏢</div>No fleet owners yet</div>'}</div>`;
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
  <div class="grid three">
    <div class="card kpi"><span class="ico">⏳</span><div class="lbl">Payouts to send</div><div class="val">${rupees(pendingAmt)}</div><div class="hint">${reqs.filter((r) => r.status === 'pending').length} requests</div></div>
    <div class="card kpi accent"><span class="ico">🧾</span><div class="lbl">Drivers owe JURTO</div><div class="val">${rupees(owe)}</div><div class="hint">cash commission not yet paid</div></div>
    <div class="card kpi"><span class="ico">✅</span><div class="lbl">Dues paid online</div><div class="val">${rupees(dues.filter((d) => d.status === 'paid').reduce((t, d) => t + num(d.amount), 0))}</div><div class="hint">last ${dues.length} payments</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Withdrawal requests</h3>${reqs.length ? `<div class="tbl-wrap" style="border:0"><table><thead><tr><th>Driver</th><th class="right">Amount</th><th>Send to</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>
    ${reqs.map((r) => { const a = r.account_snapshot || {}; return `<tr><td><div class="who" style="cursor:pointer" data-d="${r.drivers?.id}"><span class="avatar">${initial(r.drivers)}</span><div><b>${esc(name(r.drivers))}</b><small>${esc(r.drivers?.phone || '')}</small></div></div></td>
      <td class="right strong">${rupees2(r.amount)}</td>
      <td class="small">${a.upi_id ? 'UPI <b class="mono">' + esc(a.upi_id) + '</b>' : ''}${a.account_number ? `<div>${esc(a.account_holder || '')} · <span class="mono">${esc(a.account_number)}</span> · ${esc(a.ifsc || '')}</div>` : ''}${!a.upi_id && !a.account_number ? '<span class="dim">—</span>' : ''}</td>
      <td class="small muted nowrap">${fmtDate(r.created_at)}</td>
      <td>${r.status === 'pending' ? chip('pending', 'Pending') : r.status === 'paid' ? chip('ok', 'Paid') : chip('no', 'Rejected')}${r.reference ? `<div class="small muted mono">${esc(r.reference)}</div>` : ''}</td>
      <td class="right nowrap">${r.status === 'pending' ? `<button class="btn sm good" data-p="${r.id}" data-s="paid">Mark paid</button> <button class="btn sm bad" data-p="${r.id}" data-s="rejected">Reject</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>` : '<div class="empty"><div class="e">💸</div>No withdrawal requests</div>'}</div>
  <div class="card" style="margin-top:14px"><h3>Driver dues payments (online)</h3>${dues.length ? dues.map((d) => `<div class="small" style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><b>${esc(name(d.drivers))}</b><span class="muted">${fmtDate(d.created_at)}</span><span style="flex:1"></span>${chip(d.status === 'paid' ? 'ok' : 'grey', d.status)}<b>${rupees2(d.amount)}</b></div>`).join('') : '<div class="empty">No dues payments yet</div>'}</div>`;
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
  <div class="card"><h3>Vehicle fares<span class="grow"></span><span class="small muted" style="text-transform:none;letter-spacing:0">Commission blank = default ${defPct}%</span></h3>
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
  el.innerHTML = `
  <div class="toolbar"><div class="grow"></div><button class="btn primary" id="pnew">＋ New promo code</button></div>
  <div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Code</th><th>Offer</th><th>Rules</th><th>Valid till</th><th>Active</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><b class="mono" style="font-size:14px">${esc(p.code)}</b><div class="small muted">${esc(p.description || '')}</div></td>
      <td class="strong">${p.discount_type === 'percent' ? num(p.discount_value) + '% off' + (p.max_discount ? ` (max ${rupees(p.max_discount)})` : '') : rupees(p.discount_value) + ' off'}</td>
      <td class="small muted">${p.min_fare ? 'Min fare ' + rupees(p.min_fare) + '<br>' : ''}${p.first_order_only ? 'First booking only<br>' : ''}${p.per_customer_limit ? p.per_customer_limit + ' per customer' : ''}${p.max_uses ? ' · ' + p.max_uses + ' total' : ''}</td>
      <td class="small">${p.valid_to ? fmtDate(p.valid_to) : '<span class="dim">No end</span>'}</td>
      <td><label class="switch"><input type="checkbox" data-code="${esc(p.code)}" ${p.is_active ? 'checked' : ''}></label></td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><div class="e">🎁</div>No promo codes</div>'}</div>`;
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
  el.innerHTML = `<div class="tbl-wrap">${rows.length ? `<table><thead><tr><th>Customer</th><th>Issue</th><th>Order</th><th>Raised</th><th>Status</th></tr></thead><tbody>
    ${rows.map((t) => `<tr><td><div class="who" style="cursor:pointer" data-c="${t.customers?.id || ''}"><span class="avatar">${initial(t.customers)}</span><div><b>${esc(name(t.customers))}</b><small><a href="tel:${esc(t.customers?.phone)}">${esc(t.customers?.phone || '')}</a></small></div></div></td>
      <td><b>${esc(t.subject || '')}</b><div class="small muted" style="max-width:420px;white-space:pre-wrap">${esc(t.description || '')}</div></td>
      <td>${t.order_id ? `<a href="#" class="mono" data-o="${t.order_id}">#${shortId(t.order_id)}</a>` : '—'}</td>
      <td class="small muted nowrap">${fmtDate(t.created_at)}</td>
      <td><select class="cell-in" data-t="${t.id}">${[['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']].map(([k, l]) => `<option value="${k}" ${(t.status || 'open') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><div class="e">🎧</div>No support tickets. Customers raise them from Account → Support.</div>'}</div>`;
  $('#psub').textContent = `${open.length} open`;
  $$('[data-t]', el).forEach((s) => (s.onchange = async () => { try { await q(sb.from('support_tickets').update({ status: s.value }).eq('id', s.dataset.t)); toast('Ticket updated', 'ok'); } catch (e) { fail(e); } }));
  $$('[data-o]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openOrder(a.dataset.o); }));
  $$('[data-c]', el).forEach((a) => a.dataset.c && (a.onclick = () => openCustomer(a.dataset.c)));
};

/* ---------- settings ---------- */
const SETTING_FORMS = [
  ['commission', '🏦 Commission', [['percent', 'Default commission %', 'JURTO keeps this % of every completed fare (unless the vehicle has its own %).']]],
  ['order_timeout', '⏱️ Order timeout', [['minutes', 'Minutes to find a driver', 'After this, a pending order is cancelled as "no driver found".']]],
  ['near_alert', '📍 Driver almost-there alert', [['meters', 'Distance in metres', 'Customer gets “Driver is almost there” at this distance. 0 turns it off.']]],
  ['coins', '🪙 JURTO Coins', [['earn_per', 'Earn 1 coin per ₹', 'Lower = more coins.'], ['value', '₹ value of 1 coin', ''], ['max_pct', 'Max % of a fare paid by coins', ''], ['min_redeem', 'Minimum coins to use', '']]],
  ['wallet', '👛 Driver wallet', [['dues_limit', 'Dues limit ₹', 'Drivers who owe more than this cannot go online.'], ['min_withdrawal', 'Minimum withdrawal ₹', '']]],
  ['cancel_fee', '🚫 Cancellation fee', [['amount', 'Fee ₹', 'Charged when a customer cancels after the driver has come.']]],
  ['incentive', '🏆 Driver daily bonus', [['trips', 'Trips in a day', ''], ['bonus', 'Bonus ₹', 'Paid once a driver finishes this many trips in a day.']]],
  ['referral', '🤝 Referral', [['bonus', 'Bonus ₹ for both', 'Added to the wallet after the friend’s first booking.']]],
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
