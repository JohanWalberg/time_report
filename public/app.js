/* TimePort SPA */
'use strict';

// ---------- state & api ----------
const S = { meta: null, users: [], teams: [], projects: [], currentUser: null, chat: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    if (res.status === 401 && !path.startsWith('/api/auth/')) renderLogin('Your session has expired — please sign in again.');
    throw new Error(msg);
  }
  return res.json();
}

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only allow safe link schemes — blocks javascript:/data:/vbscript: URLs in user-supplied
// links (ticket link field, markdown links). Returns '#' for anything not clearly safe.
const safeUrl = (u) => {
  const s = String(u ?? '').trim();
  if (/^(https?:|mailto:|\/|#)/i.test(s) && !/^\s*(javascript|data|vbscript):/i.test(s)) return s;
  return '#';
};
// role helper — mirrors the server-side requireRole gates so members don't see buttons that 403
const isMgr = () => ['admin', 'manager'].includes(S.currentUser?.role);
const cap = (s) => typeof s === 'string' ? s.replace(/^(\s*)(\p{Ll})/u, (m, ws, ch) => ws + ch.toUpperCase()) : s;
const initials = (name) => (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const avatar = (name, color) => `<span class="avatar" style="background:${esc(color || '#6b7280')}" title="${esc(name || 'Unassigned')}">${esc(initials(name))}</span>`;
const badge = (v) => v ? `<span class="badge b-${esc(v)}">${esc(String(v).replace(/_/g, ' '))}</span>` : '';
const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t) => t.deadline && t.deadline < today() && !(t.is_done !== undefined ? t.is_done : t.status === 'done');
// options for a status <select> from a statuses list [{key,label}]
const statusOpts = (list, selected) => list.map((s) => `<option value="${esc(s.key)}" ${selected === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
const fmtH = (n) => Math.round((n || 0) * 10) / 10;
// duration in decimal hours → "2h 30m"
const fmtDur = (h) => {
  const m = Math.round((h || 0) * 60);
  if (!m) return '0m';
  return [Math.floor(m / 60) ? Math.floor(m / 60) + 'h' : '', m % 60 ? (m % 60) + 'm' : ''].filter(Boolean).join(' ');
};
// read an hours+minutes input pair → decimal hours (null if empty/invalid)
const hmValue = (form) => {
  const h = parseInt(form.hours_part.value, 10) || 0;
  const m = parseInt(form.minutes_part.value, 10) || 0;
  const total = h + m / 60;
  return total > 0 && total <= 24 ? total : null;
};
const HM_INPUTS = (hLabel = 'Time spent *') => `
  <label class="f">${hLabel}</label>
  <div class="flex" style="gap:6px">
    <input type="number" name="hours_part" min="0" max="24" placeholder="0" style="width:70px"> <span class="small muted">h</span>
    <input type="number" name="minutes_part" min="0" max="59" step="5" placeholder="0" style="width:70px"> <span class="small muted">min</span>
  </div>`;
const dstr = (d) => d ? d : '—';
// compact display label for a reference link: "linear.app · ENG-123"
const linkLabel = (url) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return u.hostname.replace(/^www\./, '') + (last && last.length <= 24 ? ' · ' + decodeURIComponent(last) : '');
  } catch { return url.slice(0, 34); }
};

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// tiny markdown renderer for AI replies (bold, links, bullets, headings)
function md(text) {
  const lines = esc(text).split('\n');
  let html = '', inList = false, inCode = false, codeBuf = [];
  const flushList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { // fenced code blocks
      if (inCode) { html += `<pre class="md-code">${codeBuf.join('\n')}</pre>`; codeBuf = []; inCode = false; }
      else { flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    let l = line
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      // export links download directly (a _blank tab would just sit empty while the file saves).
      // GPT models sometimes prefix URLs with "sandbox:" (a code-interpreter habit) — strip it.
      // safeUrl() blocks javascript:/data: schemes (stored-XSS via ticket descriptions / AI replies).
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, href) => {
        href = safeUrl(href.replace(/^sandbox:/i, ''));
        return href.includes('/api/export/')
          ? `<a href="${href}" download>⬇ ${txt}</a>`
          : `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`;
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const h = l.match(/^\s*(#{1,4})\s+(.*)/);
    if (h) { flushList(); html += `<p class="md-h"><b>${h[2]}</b></p>`; continue; }
    if (/^\s*([-•*]|\d+\.)\s+/.test(l)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${l.replace(/^\s*([-•*]|\d+\.)\s+/, '')}</li>`;
    } else {
      flushList();
      if (l.trim()) html += `<p>${l}</p>`;
    }
  }
  if (inCode) html += `<pre class="md-code">${codeBuf.join('\n')}</pre>`;
  flushList();
  return html;
}

// ---------- modal ----------
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}
function hideModal() {
  $('#modalBackdrop').hidden = true;
  $('#modal').innerHTML = '';
  $('#modal').classList.remove('wide');
  document.body.style.overflow = '';
}
function closeModal() {
  hideModal();
  // leaving a deep-linked detail: restore the underlying view's URL
  if (/^#\/(ticket|project)\//.test(location.hash)) {
    history.replaceState(null, '', S.returnHash || '#/' + (location.hash.startsWith('#/ticket/') ? 'tickets' : 'projects'));
  }
  // edits made inside the modal (deadline, status, …) must show on the roadmap behind it
  if (S.modalDirty) {
    S.modalDirty = false;
    if (location.hash.startsWith('#/roadmap')) route();
  }
}
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- shared option builders ----------
const opts = (list, valKey, labelKey, selected, emptyLabel) =>
  (emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : '') +
  list.map((x) => `<option value="${x[valKey]}" ${String(selected) === String(x[valKey]) ? 'selected' : ''}>${esc(x[labelKey])}</option>`).join('');
const enumOpts = (list, selected, emptyLabel) =>
  (emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : '') +
  list.map((v) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${esc(cap(v.replace(/_/g, ' ')))}</option>`).join('');

async function refreshBase() {
  [S.meta, S.users, S.teams, S.projects] = await Promise.all([
    api('/api/meta'), api('/api/users'), api('/api/teams'), api('/api/projects'),
  ]);
}

// ---------- Auth screens ----------
async function renderLogin(message = '') {
  document.querySelector('.app').style.display = 'none';
  let el = $('#authScreen');
  if (!el) { el = document.createElement('div'); el.id = 'authScreen'; document.body.appendChild(el); }
  // Empty database → first-run setup instead of sign-in
  try {
    const ns = await fetch('/api/auth/needs-setup').then((r) => r.json());
    if (ns.needs_setup) return renderSetup(el);
  } catch {}
  el.innerHTML = `
    <div class="auth-card card">
      <div class="auth-logo">⏱️ TimePort</div>
      <p class="small muted" style="margin-bottom:16px">Sign in to your workspace</p>
      ${message ? `<div class="small mb" style="color:var(--red)">${esc(message)}</div>` : ''}
      <form onsubmit="return doLogin(event)">
        <div class="field"><label class="f">Email</label><input name="email" type="email" required autocomplete="username" placeholder="you@company.com"></div>
        <div class="field"><label class="f">Password</label><input name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn primary" style="width:100%;padding:9px">Sign in</button>
      </form>
    </div>`;
}
function renderSetup(el) {
  el.innerHTML = `
    <div class="auth-card card">
      <div class="auth-logo">⏱️ TimePort</div>
      <p class="small muted" style="margin-bottom:16px">Welcome! This workspace is empty — create the first admin account to get started. You can invite the rest of your team afterwards.</p>
      <form onsubmit="return doSetup(event)">
        <div class="field"><label class="f">Your name</label><input name="name" required placeholder="First Last"></div>
        <div class="field"><label class="f">Email</label><input name="email" type="email" required autocomplete="username" placeholder="you@company.com"></div>
        <div class="field"><label class="f">Password (min 6 characters)</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div>
        <button class="btn primary" style="width:100%;padding:9px">Create admin account</button>
      </form>
    </div>`;
}
window.doSetup = async function (e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/auth/setup', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), password: f.get('password') } });
    location.hash = '#/dashboard';
    location.reload();
  } catch (err) { toast(err.message, true); }
  return false;
};
window.doLogin = async function (e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    location.hash = '#/dashboard';
    location.reload();
  } catch (err) { renderLogin(err.message); }
  return false;
};
window.doLogout = async function () {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
};

async function renderJoin() {
  document.querySelector('.app').style.display = 'none';
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
  let el = $('#authScreen');
  if (!el) { el = document.createElement('div'); el.id = 'authScreen'; document.body.appendChild(el); }
  let info;
  try { info = await fetch('/api/auth/invite-info?token=' + encodeURIComponent(token)).then((r) => r.ok ? r.json() : r.json().then((j) => { throw new Error(j.error); })); }
  catch (err) {
    el.innerHTML = `<div class="auth-card card"><div class="auth-logo">⏱️ TimePort</div><p class="small" style="color:var(--red)">${esc(err.message)}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="auth-card card">
      <div class="auth-logo">⏱️ TimePort</div>
      <p class="small muted" style="margin-bottom:16px">${esc(info.invited_by || 'A colleague')} invited <b>${esc(info.email)}</b> to join${info.team_name ? ` team <b>${esc(info.team_name)}</b> in` : ''} this workspace as <b>${esc(info.role)}</b>.</p>
      <form onsubmit="return doJoin(event, '${esc(token)}')">
        <div class="field"><label class="f">Your name</label><input name="name" required placeholder="First Last"></div>
        <div class="field"><label class="f">Choose a password (min 6 characters)</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div>
        <button class="btn primary" style="width:100%;padding:9px">Create account & join</button>
      </form>
    </div>`;
}
window.doJoin = async function (e, token) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/auth/join', { method: 'POST', body: { token, name: f.get('name'), password: f.get('password') } });
    location.hash = '#/dashboard';
    location.reload();
  } catch (err) { toast(err.message, true); }
  return false;
};

function renderSidebarUser() {
  const me = S.currentUser;
  $('#sidebarUser').innerHTML = `
    <div class="flex" style="gap:8px;margin-bottom:10px">${avatar(me.name, me.color)}
      <div style="min-width:0"><div class="small" style="color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(me.name)}</div>
      <div class="small" style="color:var(--faint)">${esc(cap(me.role))}</div></div></div>
    <div class="flex" style="gap:6px">
      ${['admin', 'manager'].includes(me.role) ? '<button class="btn sm" style="flex:1" onclick="openInviteModal()">+ Invite</button>' : ''}
      <button class="btn sm" style="flex:1" onclick="doLogout()">Sign out</button>
    </div>`;
}

window.openInviteModal = async function () {
  let pending = [];
  try { pending = await api('/api/invites'); } catch {}
  openModal(`
    <h2><span>Invite people to the workspace</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form class="form-grid" onsubmit="return sendInvite(event)">
      <div class="field full"><label class="f">Email *</label><input name="email" type="email" required placeholder="colleague@company.com"></div>
      <div class="field"><label class="f">Role</label><select name="role"><option value="member">Member</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
      <div class="field"><label class="f">Team</label><select name="team_id">${opts(S.teams, 'id', 'name', '', '— none —')}</select></div>
      <div class="modal-actions full"><button class="btn primary">Create invite link</button></div>
    </form>
    <div id="inviteResult"></div>
    ${pending.length ? `<div class="section-title" style="margin-top:14px">Pending invites</div>
      <table class="data">${pending.map((i) => `<tr><td class="small">${esc(i.email)}</td><td>${badge(i.role)}</td><td class="small muted">${esc(i.team_name || '—')}</td>
        <td style="text-align:right"><button class="btn sm" onclick="copyInvite('${esc(i.link)}')">Copy link</button> <button class="btn sm danger" onclick="revokeInvite(${i.id})">Revoke</button></td></tr>`).join('')}</table>` : ''}`);
};
window.sendInvite = async function (e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const inv = await api('/api/invites', { method: 'POST', body: { email: f.get('email'), role: f.get('role'), team_id: f.get('team_id') || null } });
    const url = location.origin + '/' + inv.link;
    $('#inviteResult').innerHTML = `<div class="card" style="margin-top:6px;border-color:var(--green)">
      <div class="small" style="margin-bottom:6px">✅ Invite created for <b>${esc(inv.email)}</b> — send them this link:</div>
      <div class="flex"><input readonly value="${esc(url)}" onclick="this.select()"><button class="btn sm primary" onclick="copyInvite('${esc(inv.link)}')">Copy</button></div>
    </div>`;
  } catch (err) { toast(err.message, true); }
  return false;
};
window.copyInvite = async function (link) {
  const url = location.origin + '/' + link;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied 🔗'); } catch { window.prompt('Copy this link:', url); }
};
window.revokeInvite = async function (id) {
  await api(`/api/invites/${id}`, { method: 'DELETE' });
  toast('Invite revoked');
  openInviteModal();
};

// ---------- router ----------
const PAGES = { dashboard: pageDashboard, me: pageMe, projects: pageProjects, tickets: pageTickets, roadmap: pageRoadmap, time: pageTime, reports: pageReports, ai: pageAI, integrations: pageIntegrations, settings: pageSettings };
const TITLES = { dashboard: 'Dashboard', me: 'My work', projects: 'Projects', tickets: 'Tickets', roadmap: 'Roadmap', time: 'Time Reporting', reports: 'Reports', ai: 'AI Assistant', integrations: 'Integrations', settings: 'Settings' };

async function route() {
  hideModal(); // navigating away always dismisses any open dialog
  const raw = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const segs = raw.split('/');
  let page = segs[0];
  let openAfter = null;
  // deep links: #/ticket/TP-107 and #/project/2 render the page underneath, then open the detail
  if (page === 'ticket' && segs[1]) { page = 'tickets'; openAfter = () => openTicketRef(decodeURIComponent(segs[1])); }
  else if (page === 'project' && segs[1]) { page = 'projects'; openAfter = () => openProject(+segs[1]); }
  else if (page === 'user' && segs[1]) {
    // someone else's profile page, e.g. #/user/3
    document.querySelectorAll('#nav a').forEach((a) => a.classList.remove('active'));
    $('#pageTitle').textContent = 'Profile';
    $('#topbarActions').innerHTML = '';
    $('#content').innerHTML = '<div class="muted" style="padding:30px">Loading…</div>';
    try { await pageProfile(+segs[1]); } catch (e) { $('#content').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p></div>`; }
    return;
  }
  const fn = PAGES[page] || pageDashboard;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#pageTitle').textContent = TITLES[page] || 'Dashboard';
  $('#topbarActions').innerHTML = '';
  $('#content').innerHTML = '<div class="muted" style="padding:30px">Loading…</div>';
  try { await fn(); if (openAfter) await openAfter(); }
  catch (e) { $('#content').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);

async function openTicketRef(ref) {
  return /^\d+$/.test(ref) ? openTicket(+ref) : openTicketByKey(ref);
}

// copy a shareable deep link, e.g. copyLink('ticket/TP-107')
window.copyLink = async function (path) {
  const url = `${location.origin}/#/${path}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied 🔗'); }
  catch { window.prompt('Copy this link:', url); }
};

// ================= DASHBOARD =================
async function pageDashboard() {
  const d = await api('/api/dashboard');
  const t = d.totals;
  const kpi = (v, l, cls = '') => `<div class="card kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const wl = d.userWorkload;
  const maxWeek = Math.max(...wl.map((u) => u.hours_week), 1);

  $('#topbarActions').innerHTML = `<button class="btn primary" onclick="openTicketForm()">+ New ticket</button>`;

  // needs-attention strip: everything that's off track, each chip deep-links to the fix
  const chip = (cls, txt, href) => `<a class="attn-chip ${cls}" href="${href}">${txt}</a>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const lateProjects = d.roadmap.filter((p) => p.deadline && p.deadline < today()).length;
  const chips = [
    t.overdue_tickets ? chip('red', `⏰ ${plural(t.overdue_tickets, 'overdue ticket', 'overdue tickets')}`, '#/tickets?overdue=1') : '',
    t.blocked_tickets ? chip('red', `⛔ ${plural(t.blocked_tickets, 'blocked ticket', 'blocked tickets')}`, '#/tickets') : '',
    lateProjects ? chip('red', `📁 ${plural(lateProjects, 'project past its deadline', 'projects past their deadline')}`, '#/roadmap') : '',
    t.at_risk_milestones ? chip('amber', `◆ ${plural(t.at_risk_milestones, 'milestone at risk', 'milestones at risk')}`, '#/roadmap') : '',
    d.missingReports.length ? chip('amber', `📝 ${plural(d.missingReports.length, 'person missing time reports', 'people missing time reports')}`, '#/time?tab=analytics') : '',
  ].filter(Boolean);

  $('#content').innerHTML = `
    <div class="attn">${chips.length ? chips.join('') : '<span class="attn-ok">✓ All clear — nothing needs attention right now</span>'}</div>
    <div class="grid kpis">
      ${kpi(fmtH(t.hours_this_week), 'Hours this week')}
      ${kpi(fmtH(t.hours_this_month), 'Hours this month')}
      ${kpi(t.active_projects, 'Active projects')}
      ${kpi(t.open_tickets, 'Open tickets')}
      ${kpi(t.overdue_tickets, 'Overdue tickets', t.overdue_tickets ? 'warn' : 'ok')}
      ${kpi(t.blocked_tickets, 'Blocked', t.blocked_tickets ? 'warn' : 'ok')}
    </div>
    <div class="grid two-col">
      <div class="card">
        <div class="section-title">Roadmap progress <a class="small" href="#/roadmap">View roadmap →</a></div>
        ${d.roadmap.map((p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          return `<div class="bar-row"><span title="${esc(p.name)}">${esc(p.name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="small muted">${pct}% ${p.deadline && p.deadline < today() ? '<span class="overdue-flag">late</span>' : ''}</span></div>`;
        }).join('') || '<div class="empty">No active projects</div>'}
      </div>
      <div class="card">
        <div class="section-title">Missing time reports (7 days) <a class="small" href="#/reports">Report →</a></div>
        ${d.missingReports.length ? d.missingReports.map((m) => `
          <div class="flex" style="margin-bottom:9px">${avatar(m.name, m.color)}
            <div><b class="small">${esc(m.name)}</b><div class="small muted">${m.missing_days.length} missing day(s): ${m.missing_days.slice(-4).join(', ')}${m.missing_days.length > 4 ? '…' : ''}</div></div>
          </div>`).join('') : '<div class="empty"><div class="big">🎉</div>Everyone has logged their time!</div>'}
      </div>
      <div class="card">
        <div class="section-title">Individual workload (hours last 7 days)</div>
        ${wl.map((u) => `<div class="bar-row"><span class="flex" style="gap:7px">${avatar(u.name, u.color)} <span class="small">${esc(u.name.split(' ')[0])}</span></span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round((u.hours_week / maxWeek) * 100)}%;background:${esc(u.color)}"></div></div>
          <span class="small muted">${fmtH(u.hours_week)}h · ${u.open_tickets}🎫</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="section-title">Team workload</div>
        <table class="data"><thead><tr><th>Team</th><th>Open tickets</th><th>Hours (7d)</th></tr></thead>
        <tbody>${d.teamWorkload.map((tm) => `<tr><td><span class="dot" style="background:${esc(tm.color)}"></span> ${esc(tm.name)}</td><td>${tm.open_tickets}</td><td>${fmtH(tm.hours_week)}</td></tr>`).join('')}</tbody></table>
        <div class="section-title" style="margin-top:18px">Recent activity</div>
        ${d.recentActivity.slice(0, 6).map((a) => `<div class="activity-item"><b>${esc(a.user_name || 'System')}</b> ${esc(a.type)}: ${esc(a.detail)} on <a href="#" onclick="openTicketByKey('${esc(a.ticket_key)}');return false">${esc(a.ticket_key)}</a> <span class="small">· ${esc(a.created_at.slice(0, 16))}</span></div>`).join('')}
      </div>
    </div>`;
}

// ================= MY WORK / PROFILE =================
async function pageMe() { hlWeek = null; return pageProfile(S.currentUser.id); } // fresh visit starts on the current week

// ---- Weekly highlights: achievements handled outside the ticket system ----
let hlWeek = null; // Monday of the week being shown; null = current week
const hlWeekLabel = (mon) => {
  const s = new Date(mon + 'T12:00'), e = new Date(s); e.setDate(e.getDate() + 6);
  return `${s.getDate()} ${s.toLocaleString('en', { month: 'short' })} – ${e.getDate()} ${e.toLocaleString('en', { month: 'short' })} ${e.getFullYear()}`;
};
async function renderHighlights(userId, me) {
  const el = $('#hlCard');
  if (!el) return;
  const week = hlWeek || mondayOf(new Date());
  const rows = await api(`/api/highlights?user_id=${userId}&week=${week}`);
  const isCur = week === mondayOf(new Date());
  el.innerHTML = `
    <div class="section-title"><span>⭐ Weekly highlights <span class="muted small" style="font-weight:400">— work outside the ticket system</span></span>
      <span class="flex" style="gap:6px;align-items:center">
        <button class="btn sm" title="Previous week" onclick="hlNav(-1, ${userId}, ${me})">‹</button>
        <b class="small" style="min-width:160px;text-align:center">${hlWeekLabel(week)}${isCur ? ' · this week' : ''}</b>
        <button class="btn sm" title="Next week" onclick="hlNav(1, ${userId}, ${me})">›</button>
        ${isCur ? '' : `<button class="btn sm" onclick="hlNav(0, ${userId}, ${me})">↺ This week</button>`}
      </span></div>
    ${rows.length
      ? rows.map((h) => `<div class="hl-item"><span class="hl-star">✦</span><span style="flex:1">${esc(h.body)}</span>${me ? `<button class="hl-x" title="Remove highlight" onclick="hlDelete(${h.id}, ${userId}, ${me})">✕</button>` : ''}</div>`).join('')
      : `<div class="small muted" style="padding:4px 0 8px">No highlights for this week${me ? ' yet — add meetings held, incidents fixed, people helped, or anything not tracked as a ticket.' : '.'}</div>`}
    ${me ? `<form class="flex" style="gap:8px;margin-top:8px" onsubmit="return hlAdd(event, ${userId})">
      <input name="body" placeholder="E.g. Held customer workshop · Fixed prod incident · Onboarded new colleague" maxlength="300" style="flex:1" autocomplete="off">
      <button class="btn primary" style="flex-shrink:0">+ Add</button></form>` : ''}`;
}
window.hlNav = (dir, userId, me) => {
  hlWeek = dir === 0 ? null : addDays(hlWeek || mondayOf(new Date()), dir * 7);
  renderHighlights(userId, me);
};
window.hlAdd = async function (e, userId) {
  e.preventDefault();
  const body = e.target.body.value.trim();
  if (!body) return false;
  try {
    await api('/api/highlights', { method: 'POST', body: { week: hlWeek || mondayOf(new Date()), body } });
    renderHighlights(userId, true);
  } catch (err) { toast(err.message, true); }
  return false;
};
window.hlDelete = async function (id, userId, me) {
  try {
    await api(`/api/highlights/${id}`, { method: 'DELETE' });
    renderHighlights(userId, me);
  } catch (err) { toast(err.message, true); }
};

// GitHub-style calendar heatmap of daily logged hours (26 weeks, Mon–Sun columns)
function heatmapCard(rows, opts = {}) {
  const byDate = new Map(rows.map((r) => [r.date, r.hours]));
  const t = today();
  const end = new Date(t + 'T12:00');
  const start = new Date(end);
  start.setDate(start.getDate() - ((end.getDay() + 6) % 7) - 25 * 7); // Monday, 26 weeks back
  let cells = '', months = '', lastMonth = -1;
  const d = new Date(start);
  for (let w = 0; w < 26; w++) {
    months += `<span class="hm-m">${d.getMonth() !== lastMonth ? d.toLocaleString('en', { month: 'short' }) : ''}</span>`;
    lastMonth = d.getMonth();
    for (let i = 0; i < 7; i++) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const h = Math.round((byDate.get(iso) || 0) * 10) / 10;
      const lvl = iso > t ? -1 : h === 0 ? 0 : h < 2 ? 1 : h < 4 ? 2 : h < 6.5 ? 3 : 4;
      cells += `<span class="hm-c ${lvl < 0 ? 'fut' : 'l' + lvl}" title="${iso} · ${h}h"></span>`;
      d.setDate(d.getDate() + 1);
    }
  }
  return `<div class="card" style="${opts.style || ''}">
    <div class="section-title">${opts.title || 'Daily logged time — last 6 months'}</div>
    <div style="overflow-x:auto;padding-bottom:2px">
      <div class="hm-months">${months}</div>
      <div class="hm-grid">${cells}</div>
    </div>
    <div class="flex small muted" style="gap:4px;margin-top:9px;align-items:center">Less ${[0, 1, 2, 3, 4].map((l) => `<span class="hm-c l${l}"></span>`).join('')} More <span style="margin-left:8px">· each column is a week (Mon–Sun)</span></div>
  </div>`;
}

const PROFILE_PERIODS = ['week', 'month', 'year'];
let profileAnchor = null; // date inside the period being viewed; null = current period
window.setProfilePeriod = (p, userId) => {
  localStorage.setItem('tp_profile_period', p);
  profileAnchor = null; // switching granularity jumps back to the current period
  pageProfile(userId);
};
// step to the previous/next week/month/year (dir = -1 | 1), or back to now (dir = 0)
window.shiftProfilePeriod = (dir, userId, startISO) => {
  if (dir === 0) { profileAnchor = null; return pageProfile(userId); }
  const period = localStorage.getItem('tp_profile_period') || 'month';
  const d = new Date(startISO + 'T12:00');
  if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else if (period === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  profileAnchor = d.toISOString().slice(0, 10);
  pageProfile(userId);
};

async function pageProfile(userId) {
  const period = localStorage.getItem('tp_profile_period') || 'month';
  const [p, heat] = await Promise.all([
    api(`/api/users/${userId}/profile?period=${period}${profileAnchor ? '&anchor=' + profileAnchor : ''}`),
    api(`/api/time-heat?user_id=${userId}`),
  ]);
  // human label for the selected period, e.g. "6–12 Jul 2026" / "July 2026" / "2026"
  const ps = new Date(p.period_start + 'T12:00');
  const pe = new Date(p.period_end + 'T12:00'); pe.setDate(pe.getDate() - 1);
  const label = p.period === 'year' ? String(ps.getFullYear())
    : p.period === 'month' ? ps.toLocaleString('en', { month: 'long', year: 'numeric' })
    : `${ps.getDate()} ${ps.toLocaleString('en', { month: 'short' })} – ${pe.getDate()} ${pe.toLocaleString('en', { month: 'short' })} ${pe.getFullYear()}`;
  const isCurrent = today() >= p.period_start && today() < p.period_end;
  const me = p.user.id === S.currentUser.id;
  $('#pageTitle').textContent = me ? 'My work' : p.user.name;
  $('#topbarActions').innerHTML = `
    <a class="btn" href="/api/export/excel/user?user_id=${p.user.id}">⬇ Excel report</a>
    <a class="btn" href="/api/export/pdf/user?user_id=${p.user.id}">⬇ PDF report</a>`;

  const k = p.kpis;
  const utilColor = k.utilization === null ? 'var(--muted)' : k.utilization > 105 ? 'var(--red)' : k.utilization < 60 ? 'var(--amber)' : 'var(--green)';
  const maxEffort = Math.max(...p.effort.map((w) => w.hours), 1);
  const maxProj = Math.max(...p.projects.map((x) => x.hours), 1);
  const maxCat = Math.max(...p.byCategory.map((c) => c.hours), 1);
  const openAssigned = p.assigned.filter((t) => !t.is_done);
  const act = p.activityCounts;
  const delta = k.hours_prev ? Math.round(((k.hours_period - k.hours_prev) / k.hours_prev) * 100) : null;
  const effortTitle = `Effort — ${p.period === 'year' ? 'month by month' : 'day by day'}, ${label}`;
  const effortLabel = (w) => p.period === 'year' ? w.label.slice(5) : w.label.slice(5);

  $('#content').innerHTML = `
    <div class="card mb">
      <div class="flex" style="gap:14px">
        <span class="avatar" style="width:52px;height:52px;font-size:1.1rem;background:${esc(p.user.color)}">${esc(initials(p.user.name))}</span>
        <div style="flex:1;min-width:0">
          <div class="flex"><b style="font-size:1.1rem">${esc(p.user.name)}</b> ${badge(p.user.role)}</div>
          <div class="small muted">${esc(p.team_name || 'No team')} · ${esc(p.user.email)} · capacity ${p.user.capacity_hours}h/week</div>
          ${p.user.skills ? `<div style="margin-top:6px">${p.user.skills.split(',').map((s) => `<span class="chip">${esc(s.trim())}</span>`).join(' ')}</div>` : ''}
        </div>
        <div style="align-self:flex-start;text-align:right">
          <div class="flex" style="gap:6px;justify-content:flex-end">
            ${PROFILE_PERIODS.map((key) => `<button class="btn sm ${p.period === key ? 'primary' : ''}" onclick="setProfilePeriod('${key}', ${p.user.id})">${cap(key)}</button>`).join('')}
          </div>
          <div class="flex" style="gap:6px;justify-content:flex-end;margin-top:6px;align-items:center">
            <button class="btn sm" title="Previous ${p.period}" onclick="shiftProfilePeriod(-1, ${p.user.id}, '${p.period_start}')">◀</button>
            <b class="small" style="min-width:130px;text-align:center">${esc(label)}</b>
            <button class="btn sm" title="Next ${p.period}" onclick="shiftProfilePeriod(1, ${p.user.id}, '${p.period_start}')">▶</button>
            ${isCurrent ? '' : `<button class="btn sm" onclick="shiftProfilePeriod(0, ${p.user.id})">↺ Current</button>`}
          </div>
        </div>
      </div>
    </div>
    <div class="grid kpis">
      <div class="card kpi"><div class="v">${fmtH(k.hours_period)}</div><div class="l">Hours logged</div></div>
      <div class="card kpi"><div class="v">${fmtH(k.hours_prev)}${delta !== null ? `<span class="small" style="color:${delta >= 0 ? 'var(--green)' : 'var(--amber)'};font-weight:600"> ${delta >= 0 ? '+' : ''}${delta}%</span>` : ''}</div><div class="l">Previous ${p.period}</div></div>
      <div class="card kpi"><div class="v">${k.open_tickets}</div><div class="l">Open tickets</div></div>
      <div class="card kpi"><div class="v">${k.done_period}</div><div class="l">Completed</div></div>
      <div class="card kpi"><div class="v" style="color:${utilColor}">${k.utilization === null ? '—' : k.utilization + '%'}</div><div class="l">Utilization</div></div>
      <div class="card kpi"><div class="v">${k.avg_hours_day}</div><div class="l">Avg h / workday</div></div>
    </div>
    <div class="card mb" id="hlCard"><div class="small muted">Loading highlights…</div></div>
    <div class="grid two-col">
      <div class="card">
        <div class="section-title">${effortTitle}</div>
        <div style="display:flex;align-items:flex-end;gap:${p.period === 'month' ? 2 : 4}px;height:120px;padding-top:8px">
          ${p.effort.map((w) => `<div title="${w.label}: ${w.hours}h" style="flex:1;background:var(--brand);opacity:.85;border-radius:3px 3px 0 0;height:${Math.max((w.hours / maxEffort) * 100, 2)}%"></div>`).join('') || '<span class="muted small">No time logged yet</span>'}
        </div>
        <div class="spread small muted" style="margin-top:6px"><span>${effortLabel(p.effort[0] || { label: '' })}</span><span>${effortLabel(p.effort[p.effort.length - 1] || { label: '' })}</span></div>
        <div class="section-title" style="margin-top:16px">Work mix — hours by category (${label})</div>
        ${p.byCategory.map((c) => hbar(cap(c.name), c.hours, maxCat, '#64748b')).join('') || '<span class="muted small">—</span>'}
      </div>
      <div class="card">
        <div class="section-title">Engagement — ${label}</div>
        <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
          <div class="kpi card" style="box-shadow:none" title="Distinct tickets you did anything on ${label}: commented, created, or changed status/assignee/deadline/files"><div class="v" style="font-size:1.2rem">${act.tickets_touched || 0}</div><div class="l">Tickets involved in</div></div>
          <div class="kpi card" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${act.created || 0}</div><div class="l">Tickets created</div></div>
          <div class="kpi card" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${act.status || 0}</div><div class="l">Status changes</div></div>
          <div class="kpi card" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${act.comments || 0}</div><div class="l">Comments</div></div>
        </div>
        ${p.missing_days.length ? `<div class="small" style="color:var(--amber);margin-bottom:12px">⚠ ${p.missing_days.length} workday(s) without logged time in the last 14 days: ${p.missing_days.slice(-5).map((d) => d.slice(5)).join(', ')}${p.missing_days.length > 5 ? '…' : ''}</div>`
          : '<div class="small" style="color:var(--green);margin-bottom:12px">✓ Time logged on every workday in the last 14 days</div>'}
        <div class="section-title">Recent activity</div>
        ${p.recentActivity.map((a) => `<div class="activity-item">${esc(a.type)}: ${esc(a.detail)} on <a href="#/ticket/${encodeURIComponent(a.ticket_key)}">${esc(a.ticket_key)}</a> <span class="small">· ${esc(a.created_at.slice(0, 16))}</span></div>`).join('') || '<span class="muted small">No activity yet</span>'}
      </div>
      <div class="card">
        <div class="section-title">Projects involved — ${label} (${p.projects.length})</div>
        ${p.projects.map((pr) => `<div class="bar-row" style="grid-template-columns:150px 1fr 110px">
          <a class="small" href="#/project/${pr.id}" title="${esc(pr.name)}">${esc(pr.name.slice(0, 22))}</a>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.min((pr.hours / maxProj) * 100, 100)}%"></div></div>
          <span class="small muted">${fmtH(pr.hours)}h · ${pr.open}/${pr.assigned} open</span>
        </div>`).join('') || '<span class="muted small">Not involved in any project yet</span>'}
        <div class="small muted" style="margin-top:8px">Bar = hours logged on the project ${label} · open/assigned = this person's tickets there (current)</div>
      </div>
      <div class="card">
        <div class="section-title">Assigned tickets — open (${openAssigned.length})</div>
        <table class="data"><tbody>
          ${openAssigned.slice(0, 12).map((t) => `<tr class="clickable" onclick="openTicket(${t.id})">
            <td class="small muted">${esc(t.key)}</td><td class="small">${esc(t.title.slice(0, 38))}</td>
            <td>${badge(t.status)}</td><td>${badge(t.priority)}</td>
            <td class="small ${isOverdue(t) ? 'overdue-flag' : 'muted'}">${dstr(t.deadline)}</td></tr>`).join('') || '<tr><td class="muted small">Nothing assigned 🎉</td></tr>'}
        </tbody></table>
        ${openAssigned.length > 12 ? `<div class="small muted" style="margin-top:6px"><a href="#/tickets?assignee_id=${p.user.id}">See all ${openAssigned.length} on the board →</a></div>` : ''}
      </div>
      ${heatmapCard(heat, { style: 'grid-column:1/-1', title: `Daily logged time — last 6 months${me ? '' : ' (' + esc(p.user.name.split(' ')[0]) + ')'}` })}
    </div>`;
  renderHighlights(p.user.id, me);
}

// ================= PROJECTS =================
async function pageProjects() {
  S.projects = await api('/api/projects');
  $('#topbarActions').innerHTML = isMgr() ? `<button class="btn primary" onclick="openProjectForm()">+ New project</button>` : '';
  if (!S.projects.length) {
    $('#content').innerHTML = `<div class="card empty"><div class="big">📁</div><p>No projects yet. Create your first project to start planning work.</p><button class="btn primary" onclick="openProjectForm()">+ Create project</button></div>`;
    return;
  }
  $('#content').innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
    ${S.projects.map((p) => {
      const pct = p.ticket_count ? Math.round((p.done_count / p.ticket_count) * 100) : 0;
      const late = p.deadline && p.deadline < today() && p.status !== 'completed';
      return `<div class="card" style="cursor:pointer" onclick="openProject(${p.id})">
        <div class="spread"><b>${esc(p.name)}</b>${badge(p.status)}</div>
        <div class="small muted" style="margin:6px 0 10px">${esc(p.description || '')}</div>
        <div class="bar-track progress-lg mb" style="margin-bottom:10px"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="spread small muted">
          <span>${p.done_count}/${p.ticket_count} tickets · ${fmtH(p.logged_hours)}h logged</span>
          <span>${badge(p.priority)}</span>
        </div>
        <div class="spread small muted" style="margin-top:8px">
          <span>👤 ${esc(p.owner_name || '—')} · ${esc(p.team_name || '—')}</span>
          <span ${late ? 'class="overdue-flag"' : ''}>📅 ${dstr(p.deadline)}</span>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

window.openProject = async function (id) {
  const p = await api(`/api/projects/${id}`);
  const pStatuses = await api(`/api/statuses?project_id=${id}`);
  if (!/^#\/(ticket|project)\//.test(location.hash)) S.returnHash = location.hash || '#/projects';
  history.replaceState(null, '', '#/project/' + p.id);
  const pct = p.tickets.length ? Math.round((p.tickets.filter((t) => t.status === 'done').length / p.tickets.length) * 100) : 0;
  openModal(`
    <h2><span>${esc(p.name)} ${badge(p.status)} ${badge(p.priority)}</span>
      <span class="flex" style="gap:6px;flex-shrink:0"><button class="btn sm" onclick="copyLink('project/${p.id}')" title="Copy a shareable link to this project">🔗 Copy link</button><button class="close-x" onclick="closeModal()">✕</button></span></h2>
    <div class="small muted mb">${esc(p.description || '')}</div>
    <div class="props mb">
      <span class="k">Owner</span><span>${esc(p.owner_name || '—')}</span>
      <span class="k">Team</span><span>${esc(p.team_name || '—')}</span>
      <span class="k">Timeline</span><span>${dstr(p.start_date)} → ${dstr(p.deadline)}</span>
      <span class="k">Progress</span><span><div class="bar-track progress-lg" style="width:180px;display:inline-block;vertical-align:middle"><div class="bar-fill" style="width:${pct}%"></div></div> ${pct}%</span>
    </div>
    <div class="spread"><b class="small">Milestones</b>${isMgr() ? `<button class="btn sm" onclick="openMilestoneForm(${p.id})">+ Milestone</button>` : ''}</div>
    <table class="data mb"><tbody>
      ${p.milestones.map((m) => `<tr><td><b>${esc(m.name)}</b><div class="small muted">${esc(m.description || '')}</div></td><td>${dstr(m.due_date)}</td><td>${badge(m.status)}</td>
        <td style="text-align:right"><button class="btn sm" onclick="cycleMilestone(${m.id},'${esc(m.status)}',${p.id})" title="Advance status">→</button></td></tr>`).join('') || '<tr><td class="muted small">No milestones yet</td></tr>'}
    </tbody></table>
    <div class="spread" style="margin-top:14px"><b class="small">Workflow statuses</b>${isMgr() ? '<span class="small muted">order here = column order on the board</span>' : ''}</div>
    <div class="flex" style="flex-wrap:wrap;gap:6px;margin:8px 0 10px">
      ${pStatuses.map((s) => s.custom && isMgr()
        ? `<span class="badge b-${esc(s.key)}" style="display:inline-flex;align-items:center;gap:5px">
            <a class="tp-x" onclick="moveProjectStatus(${s.id}, -1, ${p.id})" title="Move earlier in the workflow">‹</a>${esc(s.label)}${s.category === 'done' ? ' ✓' : ''}<a class="tp-x" onclick="moveProjectStatus(${s.id}, 1, ${p.id})" title="Move later in the workflow">›</a>
            <a class="tp-x" onclick="deleteProjectStatus(${s.id}, ${p.id})" title="Remove status">×</a></span>`
        : `<span class="badge b-${esc(s.key)}" title="${s.custom ? 'Custom status' : 'Built-in status'}">${esc(s.label)}${s.custom && s.category === 'done' ? ' ✓' : ''}</span>`).join('')}
    </div>
    ${isMgr() ? `<form class="flex" style="margin-bottom:14px;flex-wrap:wrap" onsubmit="return addProjectStatus(event, ${p.id})">
      <input name="label" placeholder="New status, e.g. QA, Deployed, Released…" required style="max-width:240px">
      <select name="category" style="max-width:160px"><option value="open">Counts as open</option><option value="done">Counts as done</option></select>
      <select name="after" style="max-width:190px" title="Where the new status goes in the workflow">
        ${pStatuses.map((s) => `<option value="${esc(s.key)}" ${s.key === 'in_review' ? 'selected' : ''}>after ${esc(s.label)}</option>`).join('')}
      </select>
      <button class="btn sm primary">+ Add status</button>
    </form>` : ''}
    <div class="spread"><b class="small">Tickets (${p.tickets.length})</b>
      <span><a class="btn sm" href="/api/export/excel/project?project_id=${p.id}">⬇ Excel</a>
      <a class="btn sm" href="/api/export/pdf/project?project_id=${p.id}">⬇ PDF</a>
      <button class="btn sm primary" onclick="openTicketForm({project_id:${p.id}})">+ Ticket</button></span></div>
    <table class="data"><tbody>
      ${p.tickets.map((t) => {
        // status options come from this project's workflow (built-in + custom), with labels
        const stList = pStatuses.some((s) => s.key === t.status) ? pStatuses : [...pStatuses, { key: t.status, label: cap(String(t.status).replace(/_/g, ' ')) }];
        const stOpts = stList.map((s) => `<option value="${esc(s.key)}" ${s.key === t.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
        return `<tr>
        <td class="small muted tl-title" onclick="openTicket(${t.id})">${esc(t.key)}</td>
        <td class="tl-title" onclick="openTicket(${t.id})" title="Open ticket">${esc(t.title)}</td>
        <td><select class="list-edit" onchange="projTicketPatch(${t.id}, 'status', this.value, ${p.id})">${stOpts}</select></td>
        <td><select class="list-edit" onchange="projTicketPatch(${t.id}, 'priority', this.value, ${p.id})">${enumOpts(S.meta.priorities, t.priority)}</select></td>
        <td><select class="list-edit" onchange="projTicketPatch(${t.id}, 'assignee_id', this.value, ${p.id})">${opts(S.users, 'id', 'name', t.assignee_id ?? '', 'Unassigned')}</select></td>
        <td class="small ${isOverdue(t) ? 'overdue-flag' : 'muted'}">${dstr(t.deadline)}</td></tr>`;
      }).join('') || '<tr><td class="muted small">No tickets yet</td></tr>'}
    </tbody></table>
    <div class="modal-actions">
      ${isMgr() ? `<button class="btn danger" onclick="deleteProject(${p.id})">Delete</button>
      <button class="btn" onclick="openProjectForm(${p.id})">Edit</button>` : ''}
      <button class="btn primary" onclick="closeModal()">Close</button>
    </div>`);
};

// inline edits in the project modal's ticket table — saves, then re-renders the
// modal so the progress bar and counts stay truthful
window.projTicketPatch = async function (tid, field, value, projectId) {
  try {
    await api(`/api/tickets/${tid}`, { method: 'PATCH', body: { [field]: value || null, actor_id: S.currentUser?.id } });
    toast('Updated');
    S.modalDirty = true; // e.g. roadmap behind the modal refreshes on close
    openProject(projectId);
  } catch (e) { toast(e.message, true); }
};

window.addProjectStatus = async function (e, projectId) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(`/api/projects/${projectId}/statuses`, { method: 'POST', body: { label: f.get('label'), category: f.get('category'), after: f.get('after') } });
    toast(`Status "${f.get('label')}" added`);
    openProject(projectId);
  } catch (err) { toast(err.message, true); }
  return false;
};

// nudge a custom status one position left/right in the workflow (board column order)
window.moveProjectStatus = async function (id, dir, projectId) {
  try {
    const list = await api(`/api/statuses?project_id=${projectId}`); // merged, sorted
    const i = list.findIndex((s) => s.custom && s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const neighbor = list[j], beyond = list[j + dir];
    const sort = beyond !== undefined ? (neighbor.sort_order + beyond.sort_order) / 2 : neighbor.sort_order + dir * 10;
    await api(`/api/project-statuses/${id}`, { method: 'PATCH', body: { sort_order: sort } });
    openProject(projectId);
  } catch (err) { toast(err.message, true); }
};
window.deleteProjectStatus = async function (id, projectId) {
  try {
    await api(`/api/project-statuses/${id}`, { method: 'DELETE' });
    toast('Status removed');
    openProject(projectId);
  } catch (err) { toast(err.message, true); }
};

window.cycleMilestone = async function (id, status, projectId) {
  const order = ['planned', 'in_progress', 'at_risk', 'completed'];
  const next = order[(order.indexOf(status) + 1) % order.length];
  await api(`/api/milestones/${id}`, { method: 'PATCH', body: { status: next } });
  openProject(projectId);
};

window.openProjectForm = function (id) {
  const p = id ? S.projects.find((x) => x.id === id) || {} : {};
  openModal(`
    <h2><span>${id ? 'Edit project' : 'New project'}</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form id="pf" class="form-grid" onsubmit="return saveProject(event, ${id || 'null'})">
      <div class="field full"><label class="f">Name *</label><input name="name" required value="${esc(p.name || '')}" placeholder="e.g. Customer Portal 2.0"></div>
      <div class="field full"><label class="f">Description</label><textarea name="description" rows="2" placeholder="What is this project about?">${esc(p.description || '')}</textarea></div>
      <div class="field"><label class="f">Owner</label><select name="owner_id">${opts(S.users, 'id', 'name', p.owner_id, '— none —')}</select></div>
      <div class="field"><label class="f">Team</label><select name="team_id">${opts(S.teams, 'id', 'name', p.team_id, '— none —')}</select></div>
      <div class="field"><label class="f">Start date</label><input type="date" name="start_date" value="${esc(p.start_date || '')}"></div>
      <div class="field"><label class="f">Deadline</label><input type="date" name="deadline" value="${esc(p.deadline || '')}"></div>
      <div class="field"><label class="f">Status</label><select name="status">${enumOpts(S.meta.projectStatuses, p.status || 'planning')}</select></div>
      <div class="field"><label class="f">Priority</label><select name="priority">${enumOpts(S.meta.priorities, p.priority || 'medium')}</select></div>
      <div class="modal-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">${id ? 'Save' : 'Create project'}</button></div>
    </form>`);
};
window.saveProject = async function (e, id) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    if (id) await api(`/api/projects/${id}`, { method: 'PATCH', body });
    else await api('/api/projects', { method: 'POST', body });
    toast(id ? 'Project updated' : 'Project created');
    closeModal(); await refreshBase(); route();
  } catch (err) { toast(err.message, true); }
  return false;
};
window.deleteProject = async function (id) {
  if (!confirm('Delete this project? Tickets will be kept but unlinked.')) return;
  await api(`/api/projects/${id}`, { method: 'DELETE' });
  toast('Project deleted'); closeModal(); await refreshBase(); route();
};

window.openMilestoneForm = function (projectId) {
  openModal(`
    <h2><span>New milestone</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form class="form-grid" onsubmit="return saveMilestone(event, ${projectId})">
      <div class="field full"><label class="f">Name *</label><input name="name" required placeholder="e.g. Beta launch"></div>
      <div class="field full"><label class="f">Description</label><input name="description" placeholder="What does done look like?"></div>
      <div class="field"><label class="f">Due date</label><input type="date" name="due_date"></div>
      <div class="field"><label class="f">Status</label><select name="status">${enumOpts(S.meta.milestoneStatuses, 'planned')}</select></div>
      <div class="modal-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Create</button></div>
    </form>`);
};
window.saveMilestone = async function (e, projectId) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.project_id = projectId;
  try { await api('/api/milestones', { method: 'POST', body }); toast('Milestone created'); openProject(projectId); }
  catch (err) { toast(err.message, true); }
  return false;
};

// ================= TICKETS =================
let ticketView = localStorage.getItem('tp_ticket_view') || 'board';
let boardGrouped = localStorage.getItem('tp_board_group') === '1';
window.toggleBoardGroup = function () {
  boardGrouped = !boardGrouped;
  localStorage.setItem('tp_board_group', boardGrouped ? '1' : '0');
  pageTickets();
};
async function pageTickets() {
  const qGroup = new URLSearchParams(location.hash.split('?')[1] || '').get('group');
  if (qGroup !== null) boardGrouped = qGroup === '1';
  $('#topbarActions').innerHTML = `
    ${ticketView === 'board' ? `<button class="btn ${boardGrouped ? 'primary' : ''}" onclick="toggleBoardGroup()" title="One row per project, each with its own workflow columns">▤ Group by project</button>` : ''}
    <button class="btn" onclick="toggleTicketView()">${ticketView === 'board' ? '☰ List view' : '▦ Board view'}</button>
    <button class="btn" onclick="openImportModal()">⬆ Import</button>
    <a class="btn" href="/api/export/excel/tickets">⬇ Excel</a>
    <a class="btn" href="/api/export/pdf/tickets">⬇ PDF</a>
    <button class="btn primary" onclick="openTicketForm()">+ New ticket</button>`;
  $('#content').innerHTML = `
    <div class="filters">
      <div style="flex:1;min-width:200px"><label class="f">Search</label><input id="fq" placeholder="Search title, key or label…"></div>
      <div><label class="f">Project</label><select id="fproject">${opts(S.projects, 'id', 'name', '', 'All projects')}</select></div>
      <div><label class="f">Assignee</label><select id="fassignee">${opts(S.users, 'id', 'name', '', 'Anyone')}</select></div>
      <div><label class="f">Team</label><select id="fteam">${opts(S.teams, 'id', 'name', '', 'All teams')}</select></div>
      <div><label class="f">Priority</label><select id="fpriority">${enumOpts(S.meta.priorities, '', 'Any')}</select></div>
      <div><label class="f">&nbsp;</label><label class="flex small" style="gap:6px;padding:8px 0"><input type="checkbox" id="foverdue" style="width:auto"> Overdue only</label></div>
    </div>
    <div id="ticketArea"></div>`;
  // restore filters from the URL so filtered views are shareable links
  const qp = new URLSearchParams(location.hash.split('?')[1] || '');
  if (qp.get('q')) $('#fq').value = qp.get('q');
  if (qp.get('project_id')) $('#fproject').value = qp.get('project_id');
  if (qp.get('assignee_id')) $('#fassignee').value = qp.get('assignee_id');
  if (qp.get('team_id')) $('#fteam').value = qp.get('team_id');
  if (qp.get('priority')) $('#fpriority').value = qp.get('priority');
  if (qp.get('overdue') === '1') $('#foverdue').checked = true;
  // debounce the free-text search so we don't fire an API call per keystroke
  let searchT;
  const debounced = () => { clearTimeout(searchT); searchT = setTimeout(() => renderTickets(), 250); };
  ['fq', 'fproject', 'fassignee', 'fteam', 'fpriority', 'foverdue'].forEach((id) => {
    $('#' + id).addEventListener(id === 'fq' ? 'input' : 'change', id === 'fq' ? debounced : () => renderTickets());
  });
  await renderTickets();
}
window.toggleTicketView = function () {
  ticketView = ticketView === 'board' ? 'list' : 'board';
  localStorage.setItem('tp_ticket_view', ticketView);
  pageTickets();
};

async function renderTickets() {
  const params = new URLSearchParams();
  if ($('#fq').value) params.set('q', $('#fq').value);
  if ($('#fproject').value) params.set('project_id', $('#fproject').value);
  if ($('#fassignee').value) params.set('assignee_id', $('#fassignee').value);
  if ($('#fteam').value) params.set('team_id', $('#fteam').value);
  if ($('#fpriority').value) params.set('priority', $('#fpriority').value);
  if ($('#foverdue').checked) params.set('overdue', '1');
  // keep the URL in sync with the current view so it can be shared (but never
  // clobber an open ticket/project deep link)
  if (location.hash.startsWith('#/tickets') || location.hash === '' || location.hash === '#/') {
    const viewParams = new URLSearchParams(params);
    if (ticketView === 'board' && boardGrouped) viewParams.set('group', '1');
    history.replaceState(null, '', '#/tickets' + (viewParams.toString() ? '?' + viewParams.toString() : ''));
  }
  const statusUrl = $('#fproject').value ? `/api/statuses?project_id=${$('#fproject').value}` : '/api/statuses';
  const [tickets, statuses] = await Promise.all([api('/api/tickets?' + params), api(statusUrl)]);
  const area = $('#ticketArea');
  if (!tickets.length) {
    area.innerHTML = `<div class="card empty"><div class="big">🔍</div><p>No tickets match your filters.</p><button class="btn primary" onclick="openTicketForm()">+ Create a ticket</button></div>`;
    return;
  }
  if (ticketView === 'list') {
    // Project / Assignee / Status / Priority are edited inline; the title opens the ticket
    area.innerHTML = `<div class="card" style="padding:0;overflow:hidden"><table class="data">
      <thead><tr><th>Key</th><th>Title</th><th>Project</th><th>Assignee</th><th>Status</th><th>Priority</th><th>Est/Logged</th><th>Deadline</th></tr></thead>
      <tbody>${tickets.map((t) => {
        const statuses = S.meta.ticketStatuses.includes(t.status) ? S.meta.ticketStatuses : [...S.meta.ticketStatuses, t.status];
        return `<tr>
        <td class="small muted tl-title" onclick="openTicket(${t.id})">${esc(t.key)}</td>
        <td><b class="tl-title" onclick="openTicket(${t.id})" title="Open ticket">${esc(t.title)}</b> ${t.link ? `<a href="${esc(safeUrl(t.link))}" target="_blank" rel="noopener" title="${esc(t.link)}">🔗</a>` : ''}</td>
        <td><select class="list-edit" onchange="listSetProject(${t.id}, this.value)">${opts(S.projects, 'id', 'name', t.project_id ?? '', '— No project —')}</select></td>
        <td><select class="list-edit" onchange="quickPatch(${t.id}, 'assignee_id', this.value)">${opts(S.users, 'id', 'name', t.assignee_id ?? '', 'Unassigned')}</select></td>
        <td><select class="list-edit" onchange="quickPatch(${t.id}, 'status', this.value)">${enumOpts(statuses, t.status)}</select></td>
        <td><select class="list-edit" onchange="quickPatch(${t.id}, 'priority', this.value)">${enumOpts(S.meta.priorities, t.priority)}</select></td>
        <td class="small muted">${fmtH(t.estimate_hours)}h / ${fmtH(t.logged_hours)}h</td>
        <td class="small ${isOverdue(t) ? 'overdue-flag' : 'muted'}">${dstr(t.deadline)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    return;
  }
  // Kanban — columns are the workflow statuses (defaults + custom), cards ordered by board position
  boardTickets = tickets;

  const kcard = (t) => `<div class="kcard" data-id="${t.id}" onclick="openTicket(${t.id})">
    <div class="spread"><span class="key">${esc(t.key)}</span>${badge(t.priority)}</div>
    <div class="t">${esc(t.title)}</div>
    <div class="meta">
      <span class="small muted">${esc(t.project_name || '')}</span>
      <span class="flex" style="gap:5px">${isOverdue(t) ? '<span class="overdue-flag" title="Overdue">⚠</span>' : ''}${t.link ? `<a href="${esc(safeUrl(t.link))}" target="_blank" rel="noopener" title="${esc(t.link)}" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()">🔗</a>` : ''}${t.comment_count ? `<span class="small muted">💬${t.comment_count}</span>` : ''}${t.assignee_name ? avatar(t.assignee_name, t.assignee_color) : ''}</span>
    </div>
  </div>`;
  const kanbanHtml = (cols, items, laneProject, addForProject) => `<div class="kanban" style="grid-template-columns:repeat(${cols.length + (addForProject ? 1 : 0)}, minmax(185px, 1fr))">${cols.map((sc) => {
    const inCol = items.filter((t) => t.status === sc.key).sort((a, b) => bo(a) - bo(b));
    return `<div class="kcol" data-status="${esc(sc.key)}"${laneProject !== undefined ? ` data-project="${laneProject}"` : ''}>
      <h4>${esc(sc.label)}${sc.custom ? ' <span class="chip">Custom</span>' : ''} <span>${inCol.length}</span></h4>
      ${inCol.map(kcard).join('')}
    </div>`;
  }).join('')}${addForProject ? `<div class="kcol kcol-add" onclick="promptAddStatus(${addForProject})" title="Add a workflow status to this project">＋ Add status</div>` : ''}</div>`;
  // statuses on tickets but missing from a list still get a column (safety net)
  const withTicketStatuses = (list, items) => {
    const cols = [...list];
    const known = new Set(list.map((s) => s.key));
    for (const t of items) if (!known.has(t.status)) { known.add(t.status); cols.push({ key: t.status, label: cap(t.status.replace(/_/g, ' ')), custom: true }); }
    return cols;
  };

  if (boardGrouped) {
    // one swimlane per project, each with that project's own workflow columns
    const lanes = [...new Set(tickets.map((t) => t.project_id))].map((pid) => ({
      id: pid || '',
      name: pid ? (S.projects.find((p) => p.id === pid) || {}).name || '?' : 'No project',
      tickets: tickets.filter((t) => t.project_id === pid),
    })).sort((a, b) => a.id === '' ? 1 : b.id === '' ? -1 : a.name.localeCompare(b.name));
    const statusLists = await Promise.all(lanes.map((l) => api(`/api/statuses?project_id=${l.id}`)));
    area.innerHTML = lanes.map((lane, i) => `
      <div class="lane">
        <div class="lane-head"><b>${esc(lane.name)}</b><span class="small muted">${lane.tickets.length} ticket(s)</span>
          ${lane.id ? `<button class="btn sm" onclick="openProject(${lane.id})">⚙ Workflow</button>` : ''}</div>
        ${kanbanHtml(withTicketStatuses(statusLists[i], lane.tickets), lane.tickets, lane.id, lane.id || null)}
      </div>`).join('');
  } else {
    // flat board: the add-column appears when a single project is filtered
    area.innerHTML = kanbanHtml(withTicketStatuses(statuses, tickets), tickets, undefined, $('#fproject').value || null);
  }
  attachBoardDnD(area);
}

// Add a workflow status to a project straight from the board
window.promptAddStatus = function (projectId) {
  const p = S.projects.find((x) => String(x.id) === String(projectId));
  openModal(`
    <h2><span>New status column — ${esc(p ? p.name : '')}</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form onsubmit="return saveBoardStatus(event, ${projectId})">
      <div class="field"><label class="f">Status name *</label><input name="label" required placeholder="e.g. QA, Deployed, Released…" autofocus></div>
      <div class="field"><label class="f">Tickets in this status count as…</label>
        <select name="category"><option value="open">Open (still in progress)</option><option value="done">Done (completed work)</option></select></div>
      <p class="small muted">Saved on the project — this column shows on ${esc(p ? p.name : 'the project')}'s board, its ticket status list, and in reports. "Done"-type statuses count toward project progress.</p>
      <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Add status</button></div>
    </form>`);
};
window.saveBoardStatus = async function (e, projectId) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(`/api/projects/${projectId}/statuses`, { method: 'POST', body: { label: f.get('label'), category: f.get('category') } });
    toast(`Status "${f.get('label')}" added`);
    closeModal();
    renderTickets();
  } catch (err) { toast(err.message, true); }
  return false;
};

// ---- Board drag & drop (pointer-based, Trello-style) ----
// Native HTML5 DnD is throttled and can't animate, so we implement dragging with
// pointer events: a floating full-fidelity clone follows the cursor, the original
// card becomes an empty slot marking the drop position, and neighbouring cards
// FLIP-animate out of the way. Click (< 6px movement) still opens the ticket.
let boardTickets = [];
const bo = (t) => t.board_order ?? t.id * 1000; // effective board position
let suppressTicketClick = false;
let boardDnDCtl = null;

function attachBoardDnD(area) {
  // `board` spans all lanes so drags work within and across projects
  const board = area.querySelector('.kanban') ? area : null;
  if (!board) return;
  if (boardDnDCtl) boardDnDCtl.abort(); // drop listeners from a previous render
  boardDnDCtl = new AbortController();
  const { signal } = boardDnDCtl;

  let down = null; // pressed but not yet dragging
  let drag = null; // active drag state

  // FLIP: record positions, mutate the DOM, then animate everything to its new spot
  const flip = (mutate, exclude) => {
    const cards = [...board.querySelectorAll('.kcard')].filter((c) => c !== exclude);
    const first = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of cards) {
      const f = first.get(c), l = c.getBoundingClientRect();
      const dx = f.left - l.left, dy = f.top - l.top;
      if (!dx && !dy) continue;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => {
        c.style.transition = 'transform .18s cubic-bezier(.2,.7,.3,1)';
        c.style.transform = '';
      });
      clearTimeout(c._flipT);
      c._flipT = setTimeout(() => { c.style.transition = ''; }, 240);
    }
  };

  function startDrag(card, e) {
    const r = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.className = 'kcard drag-float';
    clone.style.width = r.width + 'px';
    document.body.appendChild(clone);
    card.classList.add('drag-slot');
    card.style.height = r.height + 'px';
    document.body.classList.add('board-dragging');
    const d = {
      card, clone, ox: e.clientX - r.left, oy: e.clientY - r.top,
      origCol: card.closest('.kcol'), origNext: card.nextElementSibling,
      lastCol: null, lastAfter: undefined,
    };
    position(d, e);
    return d;
  }
  const position = (d, e) => {
    d.clone.style.transform = `translate(${e.clientX - d.ox}px, ${e.clientY - d.oy}px) rotate(2.5deg)`;
  };
  function moveDrag(d, e) {
    position(d, e);
    const cols = [...board.querySelectorAll('.kcol')];
    const col = cols.find((c) => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right; });
    cols.forEach((c) => c.classList.toggle('dragover', c === col));
    if (!col) return;
    // insertion point: first card (ignoring the slot) whose midpoint is below the cursor
    const cards = [...col.querySelectorAll('.kcard')].filter((c) => c !== d.card);
    const after = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
    if (col === d.lastCol && after === d.lastAfter) return; // nothing changed — no relayout
    d.lastCol = col; d.lastAfter = after;
    flip(() => { if (after) col.insertBefore(d.card, after); else col.appendChild(d.card); }, d.card);
  }
  async function endDrag(d) {
    suppressTicketClick = true;
    setTimeout(() => { suppressTicketClick = false; }, 150);
    // glide the floating card into its slot before committing
    const r = d.card.getBoundingClientRect();
    d.clone.style.transition = 'transform .15s cubic-bezier(.2,.7,.3,1)';
    d.clone.style.transform = `translate(${r.left}px, ${r.top}px) rotate(0deg)`;
    await new Promise((res) => setTimeout(res, 160));
    cleanup(d);
    await commitBoardMove(d.card);
  }
  function cancelDrag(d) {
    flip(() => { d.origCol.insertBefore(d.card, d.origNext); }, null);
    cleanup(d);
  }
  function cleanup(d) {
    d.clone.remove();
    d.card.classList.remove('drag-slot');
    d.card.style.height = '';
    document.body.classList.remove('board-dragging');
    board.querySelectorAll('.kcol').forEach((c) => c.classList.remove('dragover'));
  }

  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const card = e.target.closest('.kcard');
    if (!card) return;
    e.preventDefault(); // no text selection while pressing
    down = { card, x: e.clientX, y: e.clientY };
  }, { signal });

  document.addEventListener('pointermove', (e) => {
    if (!down && !drag) return;
    if (!drag) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return; // still a click
      drag = startDrag(down.card, e);
      down = null;
    }
    moveDrag(drag, e);
  }, { signal });

  document.addEventListener('pointerup', () => {
    down = null;
    if (!drag) return;
    const d = drag; drag = null;
    endDrag(d);
  }, { signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) { const d = drag; drag = null; cancelDrag(d); }
  }, { signal });
}

// Persist the card's final DOM position: status from its column, order between its neighbors
async function commitBoardMove(card) {
  const col = card.closest('.kcol');
  if (!col) { renderTickets(); return; }
  const id = +card.dataset.id;
  const t = boardTickets.find((x) => x.id === id);
  const status = col.dataset.status;
  const siblings = [...col.querySelectorAll('.kcard')];
  const idx = siblings.indexOf(card);
  const neighbor = (i) => (i >= 0 && i < siblings.length) ? boardTickets.find((x) => x.id === +siblings[i].dataset.id) : null;
  const prev = neighbor(idx - 1), next = neighbor(idx + 1);
  let order;
  if (prev && next) order = (bo(prev) + bo(next)) / 2;
  else if (prev) order = bo(prev) + 1000;
  else if (next) order = bo(next) - 1000;
  else order = 1000;
  const statusChanged = t && t.status !== status;
  // grouped board: dropping into another project's lane moves the ticket there too
  const laneProject = col.dataset.project;
  const projectChanged = laneProject !== undefined && t && String(t.project_id || '') !== laneProject;
  if (t && !statusChanged && !projectChanged && Math.abs(bo(t) - order) < 0.001) return; // dropped back where it started
  const body = { status, board_order: order, actor_id: S.currentUser?.id };
  if (projectChanged) { body.project_id = laneProject || null; body.milestone_id = null; }
  try {
    await api(`/api/tickets/${id}`, { method: 'PATCH', body });
    if (projectChanged) {
      const p = S.projects.find((x) => String(x.id) === laneProject);
      toast(`Moved to ${p ? p.name : 'No project'} · ${status.replace(/_/g, ' ')}`);
    } else if (statusChanged) toast(`Moved to ${status.replace(/_/g, ' ')}`);
    renderTickets();
  } catch (err) { toast(err.message, true); renderTickets(); }
}

window.openTicketByKey = async function (key) {
  const all = await api('/api/tickets?q=' + encodeURIComponent(key));
  const t = all.find((x) => x.key === key);
  if (t) openTicket(t.id);
};

window.openTicket = async function (id) {
  if (suppressTicketClick) return; // the click that follows a board drag
  const t = await api(`/api/tickets/${id}`);
  const tStatuses = await api(`/api/statuses?project_id=${t.project_id || ''}`);
  const remaining = (t.estimate_hours || 0) - (t.logged_hours || 0);
  // reflect the ticket in the URL so it can be shared / bookmarked
  if (!/^#\/(ticket|project)\//.test(location.hash)) S.returnHash = location.hash || '#/tickets';
  history.replaceState(null, '', '#/ticket/' + encodeURIComponent(t.key));
  openModal(`
    <h2><span><span class="muted small">${esc(t.key)}</span> ${esc(t.title)}</span>
      <span class="flex" style="gap:6px;flex-shrink:0">
        <button class="btn sm ${(S.stars || []).some((s) => s.ticket_id === t.id) ? 'starred' : ''}" id="starBtn" onclick="toggleStar(${t.id})" title="Pin this ticket to your sidebar">${(S.stars || []).some((s) => s.ticket_id === t.id) ? '★ Starred' : '☆ Star'}</button>
        <button class="btn sm" onclick="copyLink('ticket/${esc(t.key)}')" title="Copy a shareable link to this ticket">🔗 Copy link</button><button class="close-x" onclick="closeModal()">✕</button></span></h2>
    <div class="ticket-detail">
      <div>
        <div class="small mb md-body">${t.description ? md(t.description) : '<span class="muted">No description.</span>'}</div>
        <div class="tabs">
          <button class="active" onclick="switchTab(this,'comments')">💬 Comments (${t.comments.length})</button>
          <button onclick="switchTab(this,'activity')">📜 Activity (${t.activity.length})</button>
          <button onclick="switchTab(this,'time')">⏱ Time (${t.time_entries.length})</button>
          <button onclick="switchTab(this,'files')">📎 Files (${t.attachments.length})</button>
        </div>
        <div id="tab-comments">
          ${t.comments.map((c) => `<div class="comment"><div class="who">${avatar(c.user_name, c.user_color)} ${esc(c.user_name || '—')} <span class="when">${esc(c.created_at.slice(0, 16))}</span></div><div style="margin:5px 0 0 34px">${esc(c.body)}</div></div>`).join('') || '<div class="muted small" style="padding:10px 0">No comments yet.</div>'}
          <form class="flex" style="margin-top:10px" onsubmit="return addComment(event, ${t.id})">
            <input name="body" placeholder="Write a comment…" required><button class="btn primary">Send</button>
          </form>
        </div>
        <div id="tab-activity" hidden>${t.activity.map((a) => `<div class="activity-item"><b>${esc(a.user_name || 'System')}</b> · ${esc(a.type)}: ${esc(a.detail)} <span class="small">${esc(a.created_at.slice(0, 16))}</span></div>`).join('') || '<div class="muted small">No activity.</div>'}</div>
        <div id="tab-time" hidden>
          <table class="data"><tbody>${t.time_entries.map((e) => `<tr><td class="small">${e.date}</td><td class="small">${esc(e.user_name)}</td><td><b>${fmtDur(e.hours)}</b></td><td class="small muted">${esc(e.description || '')}</td></tr>`).join('') || '<tr><td class="muted small">No time logged yet.</td></tr>'}</tbody></table>
          <form class="form-grid" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)" onsubmit="return logTicketTime(event, ${t.id})">
            <div class="field">${HM_INPUTS()}</div>
            <div class="field"><label class="f">Date</label><input type="date" name="date" value="${today()}" required></div>
            <div class="field"><label class="f">Category</label><select name="category">${enumOpts(S.meta.timeCategories, 'development')}</select></div>
            <div class="field"><label class="f">Description</label><input name="description" placeholder="What did you do?"></div>
            <div class="full" style="text-align:right"><button class="btn primary sm">+ Log time as ${esc(S.currentUser?.name.split(' ')[0] || 'me')}</button></div>
          </form>
        </div>
        <div id="tab-files" hidden>
          ${t.attachments.map((a) => `<div class="activity-item">📎 <a href="/api/attachments/${a.id}/download">${esc(a.filename)}</a> <span class="small">(${Math.round(a.size / 1024)} KB)</span></div>`).join('') || '<div class="muted small" style="padding:8px 0">No attachments.</div>'}
          <form style="margin-top:10px" onsubmit="return uploadFile(event, ${t.id})">
            <input type="file" name="file" required style="border:none;padding:0"><button class="btn sm" style="margin-top:6px">Upload</button>
          </form>
        </div>
      </div>
      <div>
        <div class="props card" style="box-shadow:none">
          <span class="k">Timer</span><span>${timerState && timerState.ticket_id === t.id
            ? `<button class="btn sm" onclick="openStopTimer()">■ Stop timer</button>`
            : `<button class="btn sm primary" onclick="startTimer(${t.id})">▶ Start timer</button>`}</span>
          <span class="k">Status</span><span><select onchange="quickPatch(${t.id},'status',this.value)">${statusOpts(tStatuses, t.status)}</select></span>
          <span class="k">Assignee</span><span><select onchange="quickPatch(${t.id},'assignee_id',this.value)">${opts(S.users, 'id', 'name', t.assignee_id, 'Unassigned')}</select></span>
          <span class="k">Priority</span><span><select onchange="quickPatch(${t.id},'priority',this.value)">${enumOpts(S.meta.priorities, t.priority)}</select></span>
          <span class="k">Project</span><span><div class="tagpick" id="detailProject"></div></span>
          <span class="k">Milestone</span><span class="small">${esc(t.milestone_name || '—')}</span>
          <span class="k">Team</span><span class="small">${esc(t.team_name || '—')}</span>
          <span class="k">Deadline</span><span><input type="date" value="${esc(t.deadline || '')}" onchange="quickPatch(${t.id},'deadline',this.value)"></span>
          <span class="k">Estimate</span><span class="small">${fmtH(t.estimate_hours)}h</span>
          <span class="k">Logged</span><span class="small">${fmtDur(t.logged_hours)} ${remaining >= 0 ? `<span class="muted">(${fmtDur(remaining)} left)</span>` : `<span class="overdue-flag">(${fmtDur(-remaining)} over)</span>`}</span>
          <span class="k">Link</span><span class="small">${t.link
            ? `<a href="${esc(safeUrl(t.link))}" target="_blank" rel="noopener" title="${esc(t.link)}">🔗 ${esc(linkLabel(t.link))} ↗</a>`
            : `<input type="url" placeholder="Paste a Linear/Jira link…" onchange="quickPatch(${t.id},'link',this.value);setTimeout(()=>openTicket(${t.id}),300)">`}</span>
          <span class="k">Labels</span><span><div class="tagpick" id="detailLabels"></div><input type="hidden" id="detailLabelsVal" value="${esc(t.labels || '')}"></span>
          <span class="k">Created</span><span class="small muted">${esc(t.created_at.slice(0, 10))} by ${esc(t.creator_name || '—')}</span>
        </div>
        <div class="modal-actions">
          ${isMgr() || t.created_by === S.currentUser.id ? `<button class="btn danger sm" onclick="deleteTicket(${t.id})">Delete</button>` : ''}
          <button class="btn sm" onclick="openTicketForm(null, ${t.id})">Edit all fields</button>
        </div>
      </div>
    </div>`);
  // live label editing: every add/remove saves immediately
  initLabelPicker($('#detailLabels'), $('#detailLabelsVal'), async (val) => {
    try {
      await api(`/api/tickets/${t.id}`, { method: 'PATCH', body: { labels: val, actor_id: S.currentUser?.id } });
      toast('Labels updated');
      if (location.hash.includes('tickets')) renderTickets();
    } catch (e) { toast(e.message, true); }
  });
  // project picker: search existing projects or create a new one right here
  initComboPicker($('#detailProject'), {
    items: S.projects, value: t.project_id, placeholder: 'No project — search or create…', createLabel: 'Create project',
    onPick: async (id, newName) => {
      try {
        if (newName) {
          const p = await api('/api/projects', { method: 'POST', body: { name: newName, owner_id: S.currentUser?.id, status: 'active' } });
          await refreshBase();
          toast(`Project "${newName}" created`);
          id = p.id;
        }
        await moveTicketProject(t.id, id || '');
        return id ? { id, name: (S.projects.find((x) => String(x.id) === String(id)) || { name: newName }).name } : null;
      } catch (e) { toast(e.message, true); }
    },
  });
};
window.switchTab = function (btn, name) {
  btn.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  ['comments', 'activity', 'time', 'files'].forEach((n) => { $('#tab-' + n).hidden = n !== name; });
};
// Move a ticket to another project — clears the milestone (it belongs to the old project)
window.moveTicketProject = async function (id, projectId) {
  try {
    await api(`/api/tickets/${id}`, { method: 'PATCH', body: { project_id: projectId || null, milestone_id: null, actor_id: S.currentUser?.id } });
    const p = S.projects.find((x) => String(x.id) === String(projectId));
    S.modalDirty = true;
    toast(p ? `Moved to ${p.name}` : 'Removed from project');
    openTicket(id); // refresh modal so milestone/team reflect the move
  } catch (e) { toast(e.message, true); }
};

// list-view inline project change — moving projects also clears the milestone
window.listSetProject = async function (id, val) {
  try {
    await api(`/api/tickets/${id}`, { method: 'PATCH', body: { project_id: val || null, milestone_id: null, actor_id: S.currentUser?.id } });
    toast('Updated');
    renderTickets();
  } catch (e) { toast(e.message, true); }
};

window.quickPatch = async function (id, field, value) {
  try {
    await api(`/api/tickets/${id}`, { method: 'PATCH', body: { [field]: value || null, actor_id: S.currentUser?.id } });
    toast('Updated');
    S.modalDirty = true; // refresh the underlying view (e.g. roadmap) when the modal closes
    if (location.hash.includes('tickets')) renderTickets();
  } catch (e) { toast(e.message, true); }
};
window.logTicketTime = async function (e, ticketId) {
  e.preventDefault();
  const hours = hmValue(e.target);
  if (!hours) { toast('Enter a duration (hours and/or minutes, max 24h)', true); return false; }
  const f = new FormData(e.target);
  try {
    await api('/api/time-entries', { method: 'POST', body: {
      user_id: S.currentUser.id, ticket_id: ticketId, hours,
      date: f.get('date'), category: f.get('category'), description: f.get('description'),
    } });
    toast(`Logged ${fmtDur(hours)}`);
    openTicket(ticketId); // refresh the modal with the new entry
  } catch (err) { toast(err.message, true); }
  return false;
};

window.addComment = async function (e, id) {
  e.preventDefault();
  const body = new FormData(e.target).get('body');
  try {
    await api(`/api/tickets/${id}/comments`, { method: 'POST', body: { body, user_id: S.currentUser?.id } });
    openTicket(id);
  } catch (err) { toast(err.message, true); }
  return false;
};
window.uploadFile = async function (e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  fd.append('user_id', S.currentUser?.id || '');
  try {
    const res = await fetch(`/api/tickets/${id}/attachments`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
    toast('File attached'); openTicket(id);
  } catch (err) { toast(err.message, true); }
  return false;
};
window.deleteTicket = async function (id) {
  if (!confirm('Delete this ticket permanently?')) return;
  await api(`/api/tickets/${id}`, { method: 'DELETE' });
  toast('Ticket deleted'); closeModal(); route();
};

window.openTicketForm = async function (defaults = {}, editId = null) {
  let t = { ...(defaults || {}) };
  if (editId) t = await api(`/api/tickets/${editId}`);
  const formStatuses = await api(`/api/statuses?project_id=${t.project_id || ''}`);
  openModal(`
    <h2><span>${editId ? `Edit ${esc(t.key)}` : 'New ticket'}</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form class="form-grid" onsubmit="return saveTicket(event, ${editId || 'null'})">
      <div class="field full"><label class="f">Title *</label><input name="title" required value="${esc(t.title || '')}" placeholder="Short, action-oriented summary"></div>
      <div class="field full"><label class="f">Description</label><textarea name="description" rows="4" placeholder="Context, requirements, acceptance criteria…">${esc(t.description || '')}</textarea></div>
      <div class="field"><label class="f">Project (search or create)</label>
        <div class="tagpick" id="formProject"></div>
        <input type="hidden" name="project_id" value="${t.project_id || ''}"></div>
      <div class="field"><label class="f">Assignee</label><select name="assignee_id">${opts(S.users, 'id', 'name', t.assignee_id, 'Unassigned')}</select></div>
      <div class="field"><label class="f">Team</label><select name="team_id">${opts(S.teams, 'id', 'name', t.team_id, '— none —')}</select></div>
      <div class="field"><label class="f">Status</label><select name="status" id="formStatus">${statusOpts(formStatuses, t.status || 'todo')}</select></div>
      <div class="field"><label class="f">Priority</label><select name="priority">${enumOpts(S.meta.priorities, t.priority || 'medium')}</select></div>
      <div class="field"><label class="f">Estimate (hours)</label><input type="number" step="0.5" min="0" name="estimate_hours" value="${t.estimate_hours || ''}"></div>
      <div class="field"><label class="f">Deadline</label><input type="date" name="deadline" value="${esc(t.deadline || '')}"></div>
      <div class="field"><label class="f">Labels</label>
        <div class="tagpick" id="labelPicker"></div>
        <input type="hidden" name="labels" value="${esc(t.labels || '')}"></div>
      <div class="field full"><label class="f">Reference link (Linear, Jira, docs, …)</label><input type="url" name="link" value="${esc(t.link || '')}" placeholder="https://linear.app/…"></div>
      <div class="modal-actions full">
        <span class="small muted" style="margin-right:auto">💡 Tip: the <a href="#/ai" onclick="closeModal()">AI assistant</a> can write tickets for you.</span>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">${editId ? 'Save changes' : 'Create ticket'}</button></div>
    </form>`);
  initLabelPicker($('#labelPicker'), $('#modal input[name="labels"]'));
  initComboPicker($('#formProject'), {
    items: S.projects, value: t.project_id, placeholder: '— none — search or create…', createLabel: 'Create project',
    onPick: async (id, newName) => {
      try {
        if (newName) {
          const p = await api('/api/projects', { method: 'POST', body: { name: newName, owner_id: S.currentUser?.id, status: 'active' } });
          await refreshBase();
          toast(`Project "${newName}" created`);
          id = p.id;
          $('#modal input[name="project_id"]').value = id;
          return { id, name: newName };
        }
        $('#modal input[name="project_id"]').value = id || '';
        // the status list follows the chosen project (custom workflow statuses)
        const sel = $('#formStatus');
        if (sel) {
          const cur = sel.value;
          const list = await api(`/api/statuses?project_id=${id || ''}`);
          sel.innerHTML = statusOpts(list, list.some((s) => s.key === cur) ? cur : 'todo');
        }
        return id ? S.projects.find((x) => String(x.id) === String(id)) : null;
      } catch (e) { toast(e.message, true); }
    },
  });
};

// Searchable multi-label picker: pick existing labels (with usage counts) or create new ones.
// Optional onChange(value) fires after every user add/remove — used for instant saving on ticket detail.
async function initLabelPicker(el, hidden, onChange) {
  if (!el || !hidden) return;
  let all = [];
  try { all = (await api('/api/labels')).filter((l) => !l.label.startsWith('linear:')); } catch {}
  let selected = (hidden.value || '').split(',').map((s) => s.trim()).filter(Boolean);
  el.innerHTML = `<div class="tagpick-box"><span class="tp-chips"></span><input class="tagpick-input" placeholder="Search or create…"></div><div class="tagpick-menu" hidden></div>`;
  const input = $('.tagpick-input', el), menu = $('.tagpick-menu', el), chips = $('.tp-chips', el);
  const has = (label) => selected.some((s) => s.toLowerCase() === label.toLowerCase());
  let ready = false; // suppress onChange during initial render
  const sync = () => {
    hidden.value = selected.join(',');
    chips.innerHTML = selected.map((l, i) => `<span class="chip">${esc(l)}<a class="tp-x" data-i="${i}" title="Remove">×</a></span>`).join('');
    if (ready && onChange) onChange(hidden.value);
  };
  const renderMenu = () => {
    const q = input.value.trim();
    const avail = all.filter((l) => !has(l.label) && (!q || l.label.toLowerCase().includes(q.toLowerCase())));
    let html = avail.slice(0, 8).map((l) => `<div class="tp-item" data-v="${esc(l.label)}"><span>${esc(l.label)}</span><span class="muted small">${l.count}</span></div>`).join('');
    if (q && !q.includes(',') && !all.some((l) => l.label.toLowerCase() === q.toLowerCase()) && !has(q)) {
      html += `<div class="tp-item tp-new" data-v="${esc(q)}">＋ Create "${esc(q)}"</div>`;
    }
    menu.innerHTML = html || '<div class="tp-item" style="cursor:default;color:var(--faint)">Type to search or create a label…</div>';
  };
  const add = (label) => {
    label = label.trim().replace(/,/g, '');
    if (!label) return;
    if (!has(label)) {
      selected.push(label);
      if (!all.some((l) => l.label.toLowerCase() === label.toLowerCase())) all.unshift({ label, count: 0 });
      sync();
    }
    input.value = '';
    renderMenu();
    input.focus();
  };
  input.addEventListener('focus', () => { renderMenu(); menu.hidden = false; });
  input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 120));
  input.addEventListener('input', () => { renderMenu(); menu.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // never submit the form from the picker
      if (!input.value.trim()) return;
      const first = menu.querySelector('.tp-item[data-v]');
      if (first) add(first.dataset.v); else add(input.value);
    } else if (e.key === 'Backspace' && !input.value && selected.length) {
      selected.pop(); sync(); renderMenu();
    } else if (e.key === 'Escape') { menu.hidden = true; }
  });
  menu.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.tp-item[data-v]');
    if (item) { e.preventDefault(); add(item.dataset.v); }
  });
  chips.addEventListener('click', (e) => {
    const x = e.target.closest('.tp-x');
    if (x) { selected.splice(+x.dataset.i, 1); sync(); renderMenu(); input.focus(); }
  });
  el.querySelector('.tagpick-box').addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.tp-x') && e.target !== input) { e.preventDefault(); input.focus(); }
  });
  sync();
  ready = true;
}

// Searchable single-select picker (projects): search existing items or create a new one inline.
// onPick(id, newName) — newName is set when the user chose "＋ Create"; return {id, name} to update the display.
function initComboPicker(el, cfg) {
  const { items, placeholder, createLabel, onPick } = cfg;
  let value = cfg.value || '';
  el.innerHTML = `<div class="tagpick-box"><input class="tagpick-input" placeholder="${esc(placeholder)}"></div><div class="tagpick-menu" hidden></div>`;
  const input = $('.tagpick-input', el), menu = $('.tagpick-menu', el);
  const byId = (v) => items.find((i) => String(i.id) === String(v));
  const showCurrent = () => { input.value = byId(value)?.name || ''; };
  showCurrent();
  const renderMenu = () => {
    const q = input.value.trim().toLowerCase();
    const avail = items.filter((i) => !q || i.name.toLowerCase().includes(q));
    let html = `<div class="tp-item" data-v=""><span class="muted">— none —</span></div>` +
      avail.slice(0, 10).map((i) => `<div class="tp-item" data-v="${i.id}"><span>${esc(i.name)}</span>${String(i.id) === String(value) ? '<span class="muted small">current</span>' : ''}</div>`).join('');
    if (createLabel && q && !items.some((i) => i.name.toLowerCase() === q)) {
      html += `<div class="tp-item tp-new" data-new="${esc(input.value.trim())}">＋ ${createLabel} "${esc(input.value.trim())}"</div>`;
    }
    menu.innerHTML = html;
  };
  const pick = async (item) => {
    if (!item) return;
    menu.hidden = true;
    let res;
    if (item.dataset.new !== undefined) res = await onPick(null, item.dataset.new);
    else res = await onPick(item.dataset.v || null, null);
    if (res !== undefined) { value = res ? res.id : ''; if (res && res.name && !byId(value)) items.push(res); }
    showCurrent();
  };
  input.addEventListener('focus', () => { input.select(); renderMenu(); menu.hidden = false; });
  input.addEventListener('input', () => { renderMenu(); menu.hidden = false; });
  input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; showCurrent(); }, 140));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      const candidates = [...menu.querySelectorAll('.tp-item')];
      pick(q ? candidates.find((c) => c.dataset.v || c.dataset.new !== undefined) : candidates[0]);
    } else if (e.key === 'Escape') { menu.hidden = true; input.blur(); }
  });
  menu.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.tp-item');
    if (item) { e.preventDefault(); pick(item); }
  });
}

window.saveTicket = async function (e, editId) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.actor_id = S.currentUser?.id;
  try {
    if (editId) { await api(`/api/tickets/${editId}`, { method: 'PATCH', body }); toast('Ticket updated'); }
    else { const t = await api('/api/tickets', { method: 'POST', body }); toast(`Created ${t.key}`); }
    closeModal(); route();
  } catch (err) { toast(err.message, true); }
  return false;
};

// ================= ROADMAP =================
async function pageRoadmap() {
  const report = await api('/api/reports/roadmap');
  const projects = await api('/api/projects');
  const active = projects.filter((p) => !['cancelled'].includes(p.status));
  $('#topbarActions').innerHTML = `
    <a class="btn" href="/api/export/excel/roadmap">⬇ Excel</a>
    <a class="btn" href="/api/export/pdf/roadmap">⬇ PDF</a>
    ${isMgr() ? '<button class="btn primary" onclick="openProjectForm()">+ New project</button>' : ''}`;
  if (!active.length) {
    $('#content').innerHTML = `<div class="card empty"><div class="big">🗺️</div><p>Your roadmap is empty. Create a project with a start date and deadline to see it here.</p><button class="btn primary" onclick="openProjectForm()">+ Create project</button></div>`;
    return;
  }
  // which calendar years the roadmap touches (project starts → deadlines, always incl. current year)
  const thisYear = Number(today().slice(0, 4));
  const dates = active.flatMap((p) => [p.start_date || p.created_at?.slice(0, 10), p.deadline]).filter(Boolean).sort();
  const yearFirst = Math.min(Number((dates[0] || today()).slice(0, 4)), thisYear);
  const yearLast = Math.max(Number((dates[dates.length - 1] || today()).slice(0, 4)), thisYear);
  const years = []; for (let y = yearFirst; y <= yearLast; y++) years.push(y);
  let sel = localStorage.getItem('tp_roadmap_year') || (years.length > 1 && years.includes(thisYear) ? String(thisYear) : 'all');
  if (sel !== 'all' && !years.includes(Number(sel))) sel = 'all';

  // timeline window: selected year, or min start → max deadline (padded)
  let min, max;
  if (sel === 'all') {
    min = new Date(dates[0] || today()); min.setDate(1);
    max = new Date(dates[dates.length - 1] || today()); max.setMonth(max.getMonth() + 1, 15);
  } else {
    min = new Date(`${sel}-01-01`);
    max = new Date(`${Number(sel) + 1}-01-01`);
  }
  const span = max - min;
  const pos = (d) => Math.min(Math.max(((new Date(d) - min) / span) * 100, 0), 100);
  const inWindow = (d) => { const t = new Date(d); return t >= min && t < max; };

  // projects overlapping the window
  const visible = active.filter((p) => {
    const s = new Date(p.start_date || p.created_at?.slice(0, 10) || today());
    const e = new Date(p.deadline || today());
    return e >= min && s < max;
  });

  // months header
  const months = [];
  const cur = new Date(min);
  while (cur < max) {
    const next = new Date(cur); next.setMonth(next.getMonth() + 1);
    months.push({ label: cur.toLocaleString('en', { month: 'short', year: '2-digit' }), w: ((Math.min(next, max) - cur) / span) * 100 });
    cur.setMonth(cur.getMonth() + 1);
  }
  const msColor = { planned: '#62666d', in_progress: '#f2c94c', completed: '#4cb782', at_risk: '#eb5757' };
  // one batched request for all visible projects' milestones + tickets (avoids N+1)
  const details = visible.length ? await api(`/api/projects-detail?ids=${visible.map((p) => p.id).join(',')}`) : [];
  const milestonesByProject = {}, ticketsByProject = {};
  for (const dp of details) { milestonesByProject[dp.id] = dp.milestones || []; ticketsByProject[dp.id] = dp.tickets || []; }

  const yearPicker = `
    <div class="spread" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div class="flex" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm ${sel === 'all' ? 'primary' : ''}" onclick="setRoadmapYear('all')">All time</button>
        ${years.map((y) => `<button class="btn sm ${sel === String(y) ? 'primary' : ''}" onclick="setRoadmapYear(${y})">${y}</button>`).join('')}
      </div>
      <span class="small muted">${visible.length} of ${active.length} project${active.length === 1 ? '' : 's'} in view</span>
    </div>`;

  $('#content').innerHTML = `<div class="card roadmap-wrap">
    ${yearPicker}
    ${!visible.length ? `<div class="empty" style="padding:30px 0"><p class="muted">No projects overlap ${esc(sel)} — pick another year or "All time".</p></div>` : `
    <div class="rm-grid">
      <div class="rm-months">${months.map((m) => `<div class="rm-month" style="width:${m.w}%">${m.label}</div>`).join('')}</div>
      ${visible.map((p) => {
        const start = p.start_date || p.created_at?.slice(0, 10) || today();
        const end = p.deadline || today();
        const left = pos(start), width = Math.max(pos(end) - left, 2);
        const pct = p.ticket_count ? Math.round((p.done_count / p.ticket_count) * 100) : 0;
        const ms = milestonesByProject[p.id] || [];
        const tks = ticketsByProject[p.id] || [];
        const open = rmOpen.has(p.id);
        const tkTitle = (t) => `${t.key} · ${String(t.status).replace(/_/g, ' ')}${t.deadline ? (t.start_date ? ` · ${t.start_date} → ${t.deadline}` : ' · due ' + t.deadline) : ' · no deadline — drag to schedule'} · drag to move, edges to resize`;
        return `<div class="rm-proj" data-id="${p.id}">
        <div class="rm-row" data-id="${p.id}">
          <div class="rm-label" title="Drag up/down to reorder"><span class="rm-grip">⠿</span>
            <button class="rm-caret${open ? ' open' : ''}" title="Show tickets" onclick="toggleRoadmapProject(${p.id}, this)">▸</button>
            <div style="min-width:0">
            <div class="n" onclick="openProject(${p.id})">${esc(p.name)}</div><div class="s">${badge(p.status)} ${badge(p.priority)} · ${pct}%</div>
          </div></div>
          <div class="rm-track">
            ${inWindow(today()) ? `<div class="rm-today" style="left:${pos(today())}%"></div>` : ''}
            <div class="rm-bar" data-id="${p.id}" data-start="${start}" data-end="${end}" style="left:${left}%;width:${width}%" title="Drag to move in time · drag the edges to resize">
              <span class="rm-h l"></span><div class="fill" style="width:${pct}%"></div><div class="pct">${pct}%</div><span class="rm-h r"></span>
            </div>
            ${ms.filter((m) => m.due_date && inWindow(m.due_date)).map((m) => `<div class="rm-ms" data-due="${m.due_date}" style="left:${pos(m.due_date)}%;background:${msColor[m.status] || '#9ca3af'}" title="${esc(m.name)} · ${m.due_date} · ${m.status}" onclick="openProject(${p.id})"></div>`).join('')}
          </div>
        </div>
        <div class="rm-sub" data-id="${p.id}"${open ? '' : ' hidden'}>
          <div class="rm-subhead">
            <span class="small muted">${tks.length ? `${tks.length} ticket${tks.length === 1 ? '' : 's'} — drag a pill left/right to change its deadline` : 'No tickets in this project yet'}</span>
            ${tks.some((t) => !t.is_done) ? `<button class="btn sm" onclick="rmDistribute(${p.id})" title="Space the open tickets' deadlines evenly across the project">⇹ Distribute evenly</button>` : ''}
          </div>
          ${tks.map((t) => `<div class="rm-subrow">
            <div class="rm-sublabel small"><span class="muted">${esc(t.key)}</span> <span title="${esc(t.title)}">${esc(t.title.slice(0, 22))}</span></div>
            <div class="rm-subtrack">
              ${inWindow(today()) ? `<div class="rm-today" style="left:${pos(today())}%"></div>` : ''}
              ${(() => {
                const tEnd = t.deadline || start;
                const ranged = t.start_date && t.start_date < tEnd;
                const cls = `rm-tk${ranged ? ' ranged' : ''}${t.is_done ? ' done' : ''}${!t.deadline ? ' nodate' : ''}${isOverdue(t) ? ' late' : ''}`;
                const style = ranged
                  ? `left:${pos(t.start_date)}%;width:${Math.max(pos(tEnd) - pos(t.start_date), 0.5)}%`
                  : `left:${pos(tEnd)}%`;
                return `<div class="${cls}" data-id="${t.id}" data-start="${t.start_date || ''}" data-date="${tEnd}" style="${style}" title="${esc(tkTitle(t))}" onclick="openTicket(${t.id})"><span class="rm-tkh l"></span>${esc(t.key)}<span class="rm-tkh r"></span></div>`;
              })()}
            </div>
          </div>`).join('')}
        </div>
        </div>`;
      }).join('')}
    </div>`}
    <div class="rm-legend">
      <span><span class="dot" style="background:#5e6ad2"></span> Progress</span>
      <span><span class="dot" style="background:#62666d"></span> Milestone planned</span>
      <span><span class="dot" style="background:#f2c94c"></span> In progress</span>
      <span><span class="dot" style="background:#eb5757"></span> At risk</span>
      <span><span class="dot" style="background:#4cb782"></span> Completed</span>
      <span style="color:var(--red)">│ Today</span>
    </div>
  </div>
  <div class="grid two-col" style="margin-top:16px">
    <div class="card">
      <div class="section-title">Milestones</div>
      <table class="data"><thead><tr><th>Project</th><th>Milestone</th><th>Due</th><th>Status</th></tr></thead>
      <tbody>${report.sections[1].rows.map((m) => `<tr><td class="small">${esc(m.project_name)}</td><td>${esc(m.name)}</td><td class="small ${m.due_date && m.due_date < today() && m.status !== 'completed' ? 'overdue-flag' : 'muted'}">${dstr(m.due_date)}</td><td>${badge(m.status)}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="card">
      <div class="section-title">Roadmap health</div>
      ${report.summary.map((s) => `<div class="spread" style="padding:7px 0;border-bottom:1px solid var(--border)"><span class="muted small">${esc(s.label)}</span><b>${esc(String(s.value))}</b></div>`).join('')}
      <p class="small muted" style="margin-top:12px">💡 Ask the <a href="#/ai">AI assistant</a> to "suggest roadmap improvements" for a concrete review of deadlines, at-risk milestones and workload balance.</p>
    </div>
  </div>`;
  if (visible.length) attachRoadmapDnD($('#content').querySelector('.rm-grid'), { spanMs: span, pos, projects, milestones: milestonesByProject, tickets: ticketsByProject, winMin: min, winMax: max, sel });
}

// ---- Roadmap drag interactions ----
// Grab a bar and drag: horizontal movement moves the project in time, vertical
// movement lifts the whole row and reorders it (same floating-clone + slot + FLIP
// visuals as the tickets board). The axis locks on the first few pixels of movement.
// Bar edges resize the project. The label/grip always starts a reorder.
// Milestones follow the project: a move shifts them by the same number of days, a
// resize rescales them proportionally inside the new range. All persisted via PATCH.
let rmCtl = null;
let rmSuppressClick = false;
function attachRoadmapDnD(grid, ctx) {
  rmCtx = ctx;
  if (rmCtl) rmCtl.abort();
  rmCtl = new AbortController();
  const { signal } = rmCtl;
  const MS_DAY = 86400000;
  const spanDays = ctx.spanMs / MS_DAY;
  const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / MS_DAY);
  // proportional milestone position when a project is resized: 40% into the old range → 40% into the new
  const rescaleDue = (due, s0, e0, s1, e1) => {
    const frac = Math.min(Math.max(dayDiff(s0, due) / Math.max(dayDiff(s0, e0), 1), 0), 1);
    return addDays(s1, Math.round(frac * Math.max(dayDiff(s1, e1), 1)));
  };

  let down = null, drag = null;

  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.rm-caret') || e.target.closest('.rm-subhead')) return; // plain buttons, not drags
    const tkh = e.target.closest('.rm-tkh');
    const tk = e.target.closest('.rm-tk');
    const handle = e.target.closest('.rm-h');
    const bar = e.target.closest('.rm-bar');
    const label = e.target.closest('.rm-label');
    if (tk) down = { kind: 'ticket', op: tkh ? (tkh.classList.contains('l') ? 'resize-l' : 'resize-r') : 'move', tk, x: e.clientX, y: e.clientY };
    else if (handle) down = { kind: handle.classList.contains('l') ? 'resize-l' : 'resize-r', bar, x: e.clientX, y: e.clientY };
    else if (bar) down = { kind: 'bar', bar, x: e.clientX, y: e.clientY }; // axis decided on first movement
    else if (label) down = { kind: 'order', row: label.closest('.rm-proj'), x: e.clientX, y: e.clientY };
    else return;
    e.preventDefault();
  }, { signal });

  document.addEventListener('pointermove', (e) => {
    if (!down && !drag) return;
    if (!drag) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) < 5) return; // still a click
      let mode = down.kind;
      if (mode === 'bar') mode = Math.abs(dx) >= Math.abs(dy) ? 'move' : 'order';
      if (mode === 'order' && !down.row) down.row = down.bar.closest('.rm-proj');
      document.body.classList.add('rm-dragging');
      drag = mode === 'order' ? startOrder(down, e) : mode === 'ticket' ? startTicket(down, e) : startTime({ ...down, mode }, e);
      down = null;
    }
    ({ order: moveOrder, ticket: moveTicket }[drag.mode] || moveTime)(drag, e);
  }, { signal });

  document.addEventListener('pointerup', () => {
    down = null;
    if (!drag) return;
    const d = drag; drag = null;
    rmSuppressClick = true;
    setTimeout(() => { rmSuppressClick = false; }, 150);
    document.body.classList.remove('rm-dragging');
    ({ order: endOrder, ticket: endTicket }[d.mode] || endTime)(d);
  }, { signal });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drag) return;
    const d = drag; drag = null;
    document.body.classList.remove('rm-dragging');
    ({ order: cancelOrder, ticket: cancelTicket }[d.mode] || cancelTime)(d);
  }, { signal });

  // swallow the click that fires right after a drag so it doesn't open the project
  grid.addEventListener('click', (e) => { if (rmSuppressClick) { e.stopPropagation(); e.preventDefault(); } }, { signal, capture: true });

  // ----- time axis (move / resize) -----
  function startTime(dn, e) {
    const d = {
      ...dn,
      trackW: dn.bar.parentElement.getBoundingClientRect().width,
      start0: dn.bar.dataset.start, end0: dn.bar.dataset.end,
      left0: dn.bar.style.left, width0: dn.bar.style.width,
      msEls: [...dn.bar.parentElement.querySelectorAll('.rm-ms')].map((el) => ({ el, due: el.dataset.due, left0: el.style.left })),
      ns: null, ne: null,
      tip: document.createElement('div'),
    };
    d.tip.className = 'rm-tip';
    document.body.appendChild(d.tip);
    d.bar.classList.add('rm-bar-drag');
    return d;
  }

  const msNewDue = (d, due) => d.mode === 'move'
    ? addDays(due, dayDiff(d.start0, d.ns))
    : rescaleDue(due, d.start0, d.end0, d.ns, d.ne);

  function moveTime(d, e) {
    const days = Math.round((e.clientX - d.x) / d.trackW * spanDays);
    let ns = d.start0, ne = d.end0;
    if (d.mode === 'move') { ns = addDays(d.start0, days); ne = addDays(d.end0, days); }
    else if (d.mode === 'resize-l') { ns = addDays(d.start0, days); if (ns >= d.end0) ns = addDays(d.end0, -1); }
    else if (d.mode === 'resize-r') { ne = addDays(d.end0, days); if (ne <= d.start0) ne = addDays(d.start0, 1); }
    d.ns = ns; d.ne = ne;
    const left = ctx.pos(ns), width = Math.max(ctx.pos(ne) - left, 0.5);
    d.bar.style.left = left + '%';
    d.bar.style.width = width + '%';
    for (const m of d.msEls) m.el.style.left = ctx.pos(msNewDue(d, m.due)) + '%';
    d.tip.textContent = `${ns} → ${ne} (${dayDiff(ns, ne)}d)${d.msEls.length ? ' · milestones follow' : ''}`;
    d.tip.style.left = (e.clientX + 14) + 'px';
    d.tip.style.top = (e.clientY - 30) + 'px';
  }

  async function endTime(d) {
    d.tip.remove();
    d.bar.classList.remove('rm-bar-drag');
    if (!d.ns || (d.ns === d.start0 && d.ne === d.end0)) return;
    const pid = +d.bar.dataset.id;
    try {
      await api(`/api/projects/${pid}`, { method: 'PATCH', body: { start_date: d.ns, deadline: d.ne } });
      const msList = (ctx.milestones[pid] || []).filter((m) => m.due_date)
        .map((m) => ({ ...m, newDue: msNewDue(d, m.due_date) }))
        .filter((m) => m.newDue !== m.due_date);
      await Promise.all(msList.map((m) => api(`/api/milestones/${m.id}`, { method: 'PATCH', body: { due_date: m.newDue } })));
      // the bar is already where the user dropped it — update state in place instead
      // of re-rendering the page (a full route() made the whole view flicker)
      d.bar.dataset.start = d.ns;
      d.bar.dataset.end = d.ne;
      for (const m of d.msEls) {
        const nd = msNewDue(d, m.due);
        m.el.title = m.el.title.replace(m.due, nd);
        m.el.dataset.due = nd;
      }
      for (const m of msList) {
        const src = ctx.milestones[pid].find((x) => x.id === m.id);
        if (src) src.due_date = m.newDue;
      }
      const proj = ctx.projects.find((x) => x.id === pid);
      if (proj) { proj.start_date = d.ns; proj.deadline = d.ne; }
      const sp = S.projects.find((x) => x.id === pid);
      if (sp) { sp.start_date = d.ns; sp.deadline = d.ne; }
      toast(`Timeline updated: ${d.ns} → ${d.ne}${msList.length ? ` · ${msList.length} milestone${msList.length === 1 ? '' : 's'} ${d.mode === 'move' ? 'moved along' : 'rescaled'}` : ''}`);
      if (ctx.sel !== 'all' && (new Date(d.ne) < ctx.winMin || new Date(d.ns) >= ctx.winMax)) {
        toast(`This project is now outside ${ctx.sel} — it stays visible until you leave, then follows the year filter`);
      }
    } catch (err) {
      toast(err.message, true);
      route(); // restore server truth only when the save failed
    }
  }

  function cancelTime(d) {
    d.tip.remove();
    d.bar.classList.remove('rm-bar-drag');
    d.bar.style.left = d.left0;
    d.bar.style.width = d.width0;
    for (const m of d.msEls) m.el.style.left = m.left0;
  }

  // ----- ticket pills/bars: move to reschedule, drag edges to give a duration -----
  // Tickets have a deadline; an optional start_date turns the pill into a bar.
  // Dragging the left edge of a pill creates the start (stretches it); dragging the
  // left edge back to the deadline removes it again.
  function startTicket(dn, e) {
    const d = {
      mode: 'ticket', op: dn.op || 'move', tk: dn.tk, x: dn.x,
      trackW: dn.tk.parentElement.getBoundingClientRect().width,
      end0: dn.tk.dataset.date, hasStart: !!dn.tk.dataset.start,
      start0: dn.tk.dataset.start || dn.tk.dataset.date,
      left0: dn.tk.style.left, width0: dn.tk.style.width, ranged0: dn.tk.classList.contains('ranged'),
      ns: null, nd: null, tip: document.createElement('div'),
    };
    d.tip.className = 'rm-tip';
    document.body.appendChild(d.tip);
    d.tk.classList.add('rm-tk-drag');
    return d;
  }

  const paintTicket = (el, ns, nd) => {
    if (ns && ns < nd) {
      el.classList.add('ranged');
      el.style.left = ctx.pos(ns) + '%';
      el.style.width = Math.max(ctx.pos(nd) - ctx.pos(ns), 0.5) + '%';
    } else {
      el.classList.remove('ranged');
      el.style.left = ctx.pos(nd) + '%';
      el.style.width = '';
    }
  };

  function moveTicket(d, e) {
    const days = Math.round((e.clientX - d.x) / d.trackW * spanDays);
    let ns = d.hasStart ? d.start0 : null, nd = d.end0;
    if (d.op === 'move') {
      nd = addDays(d.end0, days);
      if (d.hasStart) ns = addDays(d.start0, days);
    } else if (d.op === 'resize-r') {
      nd = addDays(d.end0, days);
      // stretching a pill to the right: its old deadline becomes the start of the range
      ns = d.hasStart ? d.start0 : d.end0;
      if (nd <= ns) {
        if (d.hasStart) nd = addDays(d.start0, 1); // ranged bar can't invert — keep 1 day
        else { ns = null; nd = addDays(d.end0, days); } // pill dragged left just moves
      }
    } else if (d.op === 'resize-l') {
      ns = addDays(d.start0, days);
      if (ns >= nd) ns = null; // dragged the start back onto the deadline → plain pill again
    }
    d.ns = ns; d.nd = nd;
    paintTicket(d.tk, ns, nd);
    d.tip.textContent = ns ? `${ns} → ${nd} (${dayDiff(ns, nd)}d)` : `due ${nd}`;
    d.tip.style.left = (e.clientX + 14) + 'px';
    d.tip.style.top = (e.clientY - 30) + 'px';
  }

  async function endTicket(d) {
    d.tip.remove();
    d.tk.classList.remove('rm-tk-drag');
    const before = { ns: d.hasStart ? d.start0 : null, nd: d.end0 };
    if (d.nd === null || (d.nd === before.nd && d.ns === before.ns)) { cancelTicketPaint(d); return; }
    const tid = +d.tk.dataset.id;
    try {
      await api(`/api/tickets/${tid}`, { method: 'PATCH', body: { deadline: d.nd, start_date: d.ns } });
      const pid = +d.tk.closest('.rm-proj').dataset.id;
      const t = (ctx.tickets[pid] || []).find((x) => x.id === tid);
      if (t) { t.deadline = d.nd; t.start_date = d.ns; }
      d.tk.dataset.date = d.nd;
      d.tk.dataset.start = d.ns || '';
      d.tk.classList.remove('nodate');
      if (t) {
        d.tk.classList.toggle('late', isOverdue(t));
        d.tk.title = `${t.key} · ${String(t.status).replace(/_/g, ' ')} · ${d.ns ? `${d.ns} → ${d.nd}` : 'due ' + d.nd} · drag to move, edges to resize`;
      }
      toast(`${t ? t.key : 'Ticket'} ${d.ns ? `scheduled ${d.ns} → ${d.nd}` : `deadline → ${d.nd}`}`);
    } catch (err) {
      toast(err.message, true);
      cancelTicketPaint(d);
    }
  }

  function cancelTicketPaint(d) {
    d.tk.classList.toggle('ranged', d.ranged0);
    d.tk.style.left = d.left0;
    d.tk.style.width = d.width0;
  }

  function cancelTicket(d) {
    d.tip.remove();
    d.tk.classList.remove('rm-tk-drag');
    cancelTicketPaint(d);
  }

  // ----- vertical axis (reorder projects, tickets-board style) -----
  const flipRows = (mutate, exclude) => {
    const rows = [...grid.querySelectorAll('.rm-proj')].filter((r) => r !== exclude);
    const first = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
    mutate();
    for (const r of rows) {
      const dy = first.get(r) - r.getBoundingClientRect().top;
      if (!dy) continue;
      r.style.transition = 'none';
      r.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        r.style.transition = 'transform .18s cubic-bezier(.2,.7,.3,1)';
        r.style.transform = '';
      });
      clearTimeout(r._flipT);
      r._flipT = setTimeout(() => { r.style.transition = ''; }, 240);
    }
  };

  function startOrder(dn, e) {
    const row = dn.row;
    const r = row.getBoundingClientRect();
    const clone = row.cloneNode(true);
    clone.className = 'rm-proj rm-row-float';
    clone.style.width = r.width + 'px';
    document.body.appendChild(clone);
    row.classList.add('rm-row-slot');
    const d = { mode: 'order', row, clone, left: r.left, oy: e.clientY - r.top, origNext: row.nextElementSibling, lastAfter: undefined };
    positionOrder(d, e);
    return d;
  }
  const positionOrder = (d, e) => { d.clone.style.transform = `translate(${d.left}px, ${e.clientY - d.oy}px)`; };

  function moveOrder(d, e) {
    positionOrder(d, e);
    // insertion point: first project (ignoring the slot) whose midpoint is below the cursor
    const rows = [...grid.querySelectorAll('.rm-proj')].filter((r) => r !== d.row);
    const after = rows.find((r) => { const rr = r.getBoundingClientRect(); return e.clientY < rr.top + rr.height / 2; }) || null;
    if (after === d.lastAfter) return;
    d.lastAfter = after;
    flipRows(() => { if (after) grid.insertBefore(d.row, after); else grid.appendChild(d.row); }, d.row);
  }

  async function endOrder(d) {
    // glide the floating row into its slot before committing
    const r = d.row.getBoundingClientRect();
    d.clone.style.transition = 'transform .15s cubic-bezier(.2,.7,.3,1)';
    d.clone.style.transform = `translate(${r.left}px, ${r.top}px)`;
    await new Promise((res) => setTimeout(res, 160));
    cleanupOrder(d);
    await commitRoadmapOrder(grid, d.row, ctx.projects);
  }

  function cancelOrder(d) {
    flipRows(() => { if (d.origNext) grid.insertBefore(d.row, d.origNext); else grid.appendChild(d.row); }, null);
    cleanupOrder(d);
  }

  function cleanupOrder(d) {
    d.clone.remove();
    d.row.classList.remove('rm-row-slot');
  }
}

// Persist the dragged row's position as sort_order between its new neighbours.
// The first time anyone reorders, every project gets its current position written,
// so the global order is stable from then on.
async function commitRoadmapOrder(grid, row, projects) {
  const rows = [...grid.querySelectorAll('.rm-proj')];
  const idx = rows.indexOf(row);
  const movedId = +row.dataset.id;
  const eff = new Map(projects.map((p, i) => [p.id, p.sort_order ?? (i + 1) * 1000]));
  const orderOf = (r) => eff.get(+r.dataset.id);
  const prev = idx > 0 ? orderOf(rows[idx - 1]) : null;
  const next = idx < rows.length - 1 ? orderOf(rows[idx + 1]) : null;
  let order;
  if (prev != null && next != null) order = (prev + next) / 2;
  else if (prev != null) order = prev + 1000;
  else if (next != null) order = next - 1000;
  else order = 1000;
  if (Math.abs((eff.get(movedId) ?? -1) - order) < 0.001) return; // dropped back where it started
  try {
    const needInit = projects.filter((p) => p.sort_order == null && p.id !== movedId);
    await Promise.all(needInit.map((p) => api(`/api/projects/${p.id}`, { method: 'PATCH', body: { sort_order: eff.get(p.id) } })));
    await api(`/api/projects/${movedId}`, { method: 'PATCH', body: { sort_order: order } });
    // rows are already in their final DOM position — just sync local state, no re-render
    for (const p of needInit) p.sort_order = eff.get(p.id);
    const setLocal = (list) => { const x = list.find((q) => q.id === movedId); if (x) x.sort_order = order; };
    setLocal(projects);
    setLocal(S.projects);
    toast('Roadmap order saved');
  } catch (err) {
    toast(err.message, true);
    route(); // restore server truth only when the save failed
  }
}

window.setRoadmapYear = (y) => {
  localStorage.setItem('tp_roadmap_year', String(y));
  route();
};

// expanded projects on the roadmap (ticket sub-rows), persisted between visits
const rmOpen = new Set((() => {
  try { return JSON.parse(localStorage.getItem('tp_roadmap_open') || '[]'); } catch { return []; }
})());
window.toggleRoadmapProject = (pid, btn) => {
  const sub = document.querySelector(`.rm-sub[data-id="${pid}"]`);
  const open = sub.hidden;
  sub.hidden = !open;
  btn.classList.toggle('open', open);
  if (open) rmOpen.add(pid); else rmOpen.delete(pid);
  localStorage.setItem('tp_roadmap_open', JSON.stringify([...rmOpen]));
};

const rmAddDays = (iso, n) => { const d = new Date(iso + 'T12:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
let rmCtx = null; // set by attachRoadmapDnD; used by rmDistribute

// space the open tickets' deadlines evenly across the project's start → deadline
window.rmDistribute = async function (pid) {
  if (!rmCtx) return;
  const bar = document.querySelector(`.rm-bar[data-id="${pid}"]`);
  if (!bar) return;
  const start = bar.dataset.start, end = bar.dataset.end;
  const tks = (rmCtx.tickets[pid] || []).filter((t) => !t.is_done)
    .sort((a, b) => String(a.deadline || '9999') < String(b.deadline || '9999') ? -1 : 1);
  if (!tks.length) return toast('No open tickets to distribute', true);
  const len = Math.max(Math.round((new Date(end) - new Date(start)) / 86400000), 1);
  const patches = tks.map((t, i) => {
    const nd = rmAddDays(start, tks.length === 1 ? Math.round(len / 2) : Math.round(i * len / (tks.length - 1)));
    // a ticket with a duration keeps it: the whole bar shifts so its deadline lands on the slot
    const dur = t.start_date && t.deadline && t.start_date < t.deadline
      ? Math.round((new Date(t.deadline) - new Date(t.start_date)) / 86400000) : null;
    return { t, nd, ns: dur ? rmAddDays(nd, -dur) : null };
  }).filter(({ t, nd, ns }) => t.deadline !== nd || (t.start_date || null) !== ns);
  if (!patches.length) return toast('Already evenly distributed');
  try {
    await Promise.all(patches.map(({ t, nd, ns }) => api(`/api/tickets/${t.id}`, { method: 'PATCH', body: { deadline: nd, start_date: ns } })));
    for (const { t, nd, ns } of patches) {
      t.deadline = nd; t.start_date = ns;
      const el = document.querySelector(`.rm-tk[data-id="${t.id}"]`);
      if (el) {
        if (ns) {
          el.classList.add('ranged');
          el.style.left = rmCtx.pos(ns) + '%';
          el.style.width = Math.max(rmCtx.pos(nd) - rmCtx.pos(ns), 0.5) + '%';
        } else {
          el.classList.remove('ranged');
          el.style.left = rmCtx.pos(nd) + '%';
          el.style.width = '';
        }
        el.dataset.date = nd;
        el.dataset.start = ns || '';
        el.classList.remove('nodate');
        el.classList.toggle('late', isOverdue(t));
        el.title = `${t.key} · ${String(t.status).replace(/_/g, ' ')} · ${ns ? `${ns} → ${nd}` : 'due ' + nd} · drag to move, edges to resize`;
      }
    }
    toast(`Spread ${patches.length} ticket${patches.length === 1 ? '' : 's'} evenly across the project`);
  } catch (e) { toast(e.message, true); route(); }
};

// ================= TIME =================
let timeTab = localStorage.getItem('tp_time_tab') || 'my';
async function pageTime() {
  const qTab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  if (qTab) timeTab = qTab;
  const isMgr = ['admin', 'manager'].includes(S.currentUser.role);
  if (timeTab === 'approvals' && !isMgr) timeTab = 'my';
  $('#topbarActions').innerHTML = `
    <button class="btn ${timeTab === 'my' ? 'primary' : ''}" onclick="switchTimeTab('my')">🙋 My time</button>
    <button class="btn ${timeTab === 'grid' ? 'primary' : ''}" onclick="switchTimeTab('grid')">📅 Week grid</button>
    <button class="btn ${timeTab === 'calendar' ? 'primary' : ''}" onclick="switchTimeTab('calendar')">🗓️ Calendar</button>
    <button class="btn ${timeTab === 'analytics' ? 'primary' : ''}" onclick="switchTimeTab('analytics')">📈 Analytics</button>
    ${isMgr ? `<button class="btn ${timeTab === 'approvals' ? 'primary' : ''}" onclick="switchTimeTab('approvals')">✅ Approvals</button>` : ''}`;
  if (timeTab === 'analytics') return pageTimeAnalytics();
  if (timeTab === 'grid') return pageTimeGrid();
  if (timeTab === 'calendar') return pageCalendar();
  if (timeTab === 'approvals') return pageApprovals();
  await pageTimeMy();
  // append my heatmap under the My time view (non-blocking)
  api('/api/time-heat').then((heat) => {
    if (timeTab === 'my' && location.hash.startsWith('#/time')) {
      $('#content').insertAdjacentHTML('beforeend', heatmapCard(heat, { style: 'margin-top:14px' }));
    }
  }).catch(() => {});
}

// Monday of the week containing d
const mondayOf = (d) => { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m.toISOString().slice(0, 10); };
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T12:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// ---- Week grid: spreadsheet-style entry, one row per ticket ----
async function pageTimeGrid() {
  if (!S.gridWeek) S.gridWeek = mondayOf(new Date());
  const from = S.gridWeek, to = addDays(from, 6);
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  const [entries, myTickets] = await Promise.all([
    api(`/api/time-entries?user_id=${S.currentUser.id}&from=${from}&to=${to}`),
    api(`/api/tickets?assignee_id=${S.currentUser.id}`),
  ]);
  // rows: my open tickets + anything I logged on this week + a general row
  const rowMap = new Map();
  for (const t of myTickets.filter((t) => !t.is_done)) rowMap.set(t.id, { ticket_id: t.id, key: t.key, title: t.title });
  for (const e of entries) if (e.ticket_id && !rowMap.has(e.ticket_id)) rowMap.set(e.ticket_id, { ticket_id: e.ticket_id, key: e.ticket_key, title: e.ticket_title || '' });
  const rows = [...rowMap.values()];
  rows.push({ ticket_id: null, key: '—', title: 'No ticket / general work' });
  const cell = {}; // `${ticket||0}|${date}` → {total, approved}
  for (const e of entries) {
    const k = `${e.ticket_id || 0}|${e.date}`;
    cell[k] = cell[k] || { total: 0, approved: 0 };
    cell[k].total += e.hours;
    if (e.status === 'approved') cell[k].approved += e.hours;
  }
  const dayTotal = (d) => fmtH(entries.filter((e) => e.date === d).reduce((s, e) => s + e.hours, 0));
  const weekTotal = fmtH(entries.reduce((s, e) => s + e.hours, 0));
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  $('#content').innerHTML = `
    <div class="card" style="overflow-x:auto">
      <div class="spread mb">
        <div class="flex">
          <button class="btn sm" onclick="gridWeekNav(-7)">‹</button>
          <b class="small">Week of ${from}</b>
          <button class="btn sm" onclick="gridWeekNav(7)">›</button>
          <button class="btn sm" onclick="gridWeekNav(0)">Today</button>
        </div>
        <div class="flex">
          <span class="small muted">Week total: <b style="color:var(--text)">${weekTotal}h</b></span>
          <button class="btn sm" onclick="copyLastWeek()" title="Copy all of last week's entries into this week">⧉ Copy last week</button>
        </div>
      </div>
      <table class="data grid-table">
        <thead><tr><th style="min-width:220px">Ticket</th>${days.map((d, i) => `<th style="text-align:center;${i > 4 ? 'opacity:.5' : ''}">${dayNames[i]}<div class="small" style="font-weight:400">${d.slice(5)}</div></th>`).join('')}<th style="text-align:center">Σ</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const rowSum = fmtH(days.reduce((s, d) => s + (cell[`${r.ticket_id || 0}|${d}`]?.total || 0), 0));
            return `<tr>
              <td class="small">${r.ticket_id ? `<b>${esc(r.key)}</b> ${esc(r.title.slice(0, 34))}` : `<span class="muted">${esc(r.title)}</span>`}</td>
              ${days.map((d) => {
                const c = cell[`${r.ticket_id || 0}|${d}`] || { total: 0, approved: 0 };
                const locked = c.approved > 0;
                return `<td style="text-align:center">${locked
                  ? `<span class="small" title="Approved and locked">${fmtH(c.total)} 🔒</span>`
                  : `<input type="number" step="0.25" min="0" max="24" class="grid-cell" value="${c.total || ''}" placeholder="·"
                      onchange="setGridCell(${r.ticket_id || 'null'}, '${d}', this)">`}</td>`;
              }).join('')}
              <td style="text-align:center" class="small"><b>${rowSum || ''}</b></td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr><td class="small muted">Day total</td>${days.map((d) => `<td style="text-align:center" class="small"><b>${dayTotal(d) || ''}</b></td>`).join('')}<td style="text-align:center" class="small"><b>${weekTotal}</b></td></tr></tfoot>
      </table>
      <p class="small muted" style="margin-top:10px">Type hours straight into the cells — changes save immediately. 🔒 = approved by a manager and locked. Entries created here are tagged “Timesheet”.</p>
    </div>`;
}
window.gridWeekNav = function (deltaDays) {
  S.gridWeek = deltaDays === 0 ? mondayOf(new Date()) : addDays(S.gridWeek, deltaDays);
  pageTimeGrid();
};
window.setGridCell = async function (ticketId, date, input) {
  try {
    await api('/api/timesheet/set', { method: 'POST', body: { ticket_id: ticketId, date, hours: parseFloat(input.value) || 0 } });
    toast('Saved');
    pageTimeGrid();
  } catch (e) { toast(e.message, true); pageTimeGrid(); }
};
window.copyLastWeek = async function () {
  if (!confirm('Copy all of last week\'s entries into this week?')) return;
  try {
    const r = await api('/api/timesheet/copy-last-week', { method: 'POST', body: { week_start: S.gridWeek } });
    toast(r.copied ? `Copied ${r.copied} entr${r.copied === 1 ? 'y' : 'ies'} from last week` : 'Nothing new to copy');
    pageTimeGrid();
  } catch (e) { toast(e.message, true); }
};

// ---- Approvals inbox (managers) ----
async function pageApprovals() {
  if (!S.apprWeek) S.apprWeek = mondayOf(new Date());
  const from = S.apprWeek, to = addDays(from, 6);
  const rows = await api(`/api/approvals?from=${from}&to=${to}`);
  $('#content').innerHTML = `
    <div class="card">
      <div class="spread mb">
        <div class="flex">
          <button class="btn sm" onclick="apprWeekNav(-7)">‹</button>
          <b class="small">Week of ${from}</b>
          <button class="btn sm" onclick="apprWeekNav(7)">›</button>
          <button class="btn sm" onclick="apprWeekNav(0)">This week</button>
        </div>
        <span class="small muted">Approving locks the entries; people can no longer edit them.</span>
      </div>
      <table class="data">
        <thead><tr><th>Person</th><th>Submitted</th><th>Approved</th><th>Rejected</th><th>Total</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><span class="flex" style="gap:8px">${avatar(r.name, r.color)}<span class="small">${esc(r.name)}</span></span></td>
          <td class="small">${r.submitted_hours ? `<b>${fmtH(r.submitted_hours)}h</b>` : '<span class="muted">—</span>'}</td>
          <td class="small" style="color:var(--green)">${r.approved_hours ? fmtH(r.approved_hours) + 'h' : '—'}</td>
          <td class="small" style="color:var(--red)">${r.rejected_hours ? fmtH(r.rejected_hours) + 'h' : '—'}</td>
          <td class="small">${fmtH(r.total_hours)}h / ${r.capacity_hours}h</td>
          <td style="text-align:right">
            ${r.submitted_hours ? `<button class="btn sm" style="color:var(--green)" onclick="approveWeek(${r.user_id},'approve')">✓ Approve</button>
            <button class="btn sm danger" onclick="approveWeek(${r.user_id},'reject')">✗ Reject</button>` : ''}
            ${r.approved_hours || r.rejected_hours ? `<button class="btn sm" onclick="approveWeek(${r.user_id},'reopen')" title="Unlock this week for editing">↺ Reopen</button>` : ''}
          </td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
window.apprWeekNav = function (deltaDays) {
  S.apprWeek = deltaDays === 0 ? mondayOf(new Date()) : addDays(S.apprWeek, deltaDays);
  pageApprovals();
};
window.approveWeek = async function (userId, action) {
  try {
    const r = await api('/api/approvals', { method: 'POST', body: { user_id: userId, from: S.apprWeek, to: addDays(S.apprWeek, 6), action } });
    toast(`${action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Reopened'} ${r.changed} entr${r.changed === 1 ? 'y' : 'ies'}`);
    pageApprovals();
  } catch (e) { toast(e.message, true); }
};
window.switchTimeTab = function (tab) {
  timeTab = tab;
  localStorage.setItem('tp_time_tab', tab);
  pageTime();
};

async function pageTimeMy() {
  const me = S.currentUser;
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
  const [entries, myWeek, sugg] = await Promise.all([
    api(`/api/time-entries?user_id=${me.id}`),
    api(`/api/time-entries?user_id=${me.id}&from=${weekStart.toISOString().slice(0, 10)}`),
    api('/api/time-suggestions').catch(() => null),
  ]);
  const weekTotal = myWeek.reduce((s, e) => s + e.hours, 0);
  const tickets = await api('/api/tickets?open_only=1');

  // last 7 days mini-summary
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const perDay = days.map((d) => ({ d, h: myWeek.filter((e) => e.date === d).reduce((s, e) => s + e.hours, 0) }));
  const maxDay = Math.max(...perDay.map((x) => x.h), 8);

  const showSugg = sugg && !sessionStorage.getItem('tp_sugg_dismissed') && (sugg.suggestions.length || sugg.total_logged === 0);
  $('#content').innerHTML = `
    ${showSugg ? `<div class="card mb" style="border-color:var(--amber)">
      <div class="spread"><b class="small">💡 Missing time from ${sugg.date}?</b>
        <button class="btn sm" onclick="sessionStorage.setItem('tp_sugg_dismissed','1');pageTime()">Dismiss</button></div>
      ${sugg.total_logged === 0 ? `<div class="small muted" style="margin-top:6px">You logged <b>no time at all</b> on ${sugg.date}.</div>` : ''}
      ${sugg.suggestions.map((s) => `<div class="spread small" style="margin-top:6px">
        <span>You worked on <b>${esc(s.key)}</b> ${esc(s.title.slice(0, 44))} but logged no time on it.</span>
        <button class="btn sm primary" onclick="prefillLog(${s.ticket_id}, '${sugg.date}')">Log time</button></div>`).join('')}
    </div>` : ''}
    <div class="grid two-col">
      <div class="card">
        <div class="section-title">Log time <span class="small muted">as ${esc(me.name)}</span></div>
        <form class="form-grid" onsubmit="return saveTime(event)">
          <div class="field"><label class="f">Date *</label><input type="date" name="date" value="${today()}" required></div>
          <div class="field">${HM_INPUTS()}</div>
          <div class="field full"><label class="f">Ticket (optional — project is filled in automatically)</label>
            <select name="ticket_id"><option value="">— no ticket / general work —</option>${S.projects.map((p) => {
              const pts = tickets.filter((t) => t.project_id === p.id);
              return pts.length ? `<optgroup label="${esc(p.name)}">${pts.map((t) => `<option value="${t.id}">${esc(t.key)} ${esc(t.title)}</option>`).join('')}</optgroup>` : '';
            }).join('')}</select></div>
          <div class="field"><label class="f">Project (for general work)</label><select name="project_id">${opts(S.projects, 'id', 'name', '', '— none —')}</select></div>
          <div class="field"><label class="f">Category</label><select name="category">${enumOpts(S.meta.timeCategories, 'development')}</select></div>
          <div class="field full"><label class="f">Description</label><input name="description" placeholder="What did you work on?"></div>
          <div class="modal-actions full" style="margin-top:4px"><button class="btn primary">+ Log time</button></div>
        </form>
      </div>
      <div class="card">
        <div class="section-title">My last 7 days <b>${fmtDur(weekTotal)}</b></div>
        ${perDay.map((x) => `<div class="bar-row"><span class="small">${new Date(x.d + 'T12:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric' })}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(x.h / maxDay) * 100}%;background:var(--brand)"></div></div>
          <span class="small ${x.h === 0 && ![0, 6].includes(new Date(x.d + 'T12:00').getDay()) ? 'overdue-flag' : 'muted'}">${x.h ? fmtDur(x.h) : (![0, 6].includes(new Date(x.d + 'T12:00').getDay()) ? 'missing' : '—')}</span></div>`).join('')}
        <p class="small muted" style="margin-top:10px">Weekly capacity: ${me.capacity_hours}h · Workdays without entries are flagged <span class="overdue-flag">missing</span>.</p>
      </div>
    </div>
    <div class="card" style="margin-top:16px;padding:0;overflow:hidden">
      <table class="data">
        <thead><tr><th>Date</th><th>Ticket</th><th>Project</th><th>Category</th><th>Time</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${entries.map((e) => `<tr>
          <td class="small">${e.date}</td>
          <td class="small">${e.ticket_key ? `${esc(e.ticket_key)} <span class="muted">${esc((e.ticket_title || '').slice(0, 34))}</span>` : '—'}</td>
          <td class="small">${esc(e.project_name || '—')}</td>
          <td class="small">${esc(cap(e.category))}</td><td><b>${fmtDur(e.hours)}</b></td>
          <td class="small muted">${esc(e.description || '')}</td>
          <td>${badge(e.status)}</td>
          <td><button class="btn sm danger" onclick="deleteTime(${e.id})" title="Delete entry">✕</button></td></tr>`).join('') ||
          '<tr><td colspan="8"><div class="empty"><div class="big">⏰</div><p>No time logged yet. Use the form above to log your first entry.</p></div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}
// prefill the log form from a smart suggestion
window.prefillLog = function (ticketId, date) {
  const form = document.querySelector('#content form');
  if (!form) return;
  form.date.value = date;
  form.ticket_id.value = String(ticketId);
  form.hours_part.focus();
  toast('Form prefilled — enter the time and save');
};

window.saveTime = async function (e) {
  e.preventDefault();
  const hours = hmValue(e.target);
  if (!hours) { toast('Enter a duration (hours and/or minutes, max 24h)', true); return false; }
  const body = Object.fromEntries(new FormData(e.target));
  delete body.hours_part; delete body.minutes_part;
  body.hours = hours;
  try {
    await api('/api/time-entries', { method: 'POST', body });
    toast(`Logged ${fmtDur(hours)}`);
    pageTime();
  } catch (err) { toast(err.message, true); }
  return false;
};
window.deleteTime = async function (id) {
  if (!confirm('Delete this time entry?')) return;
  await api(`/api/time-entries/${id}`, { method: 'DELETE' });
  toast('Entry deleted'); pageTime();
};

// ---- Linear import ----
// IMP holds the interactive preview: server-analyzed rows plus the user's per-row
// choices (checked, assignee, project). It is rebuilt on every dry run and sent
// back as `overrides` on commit, so what you see in the table is exactly what imports.
let IMP = null;
window.openImportModal = function () {
  IMP = null;
  openModal(`
    <h2><span>⬆ Import tickets (Linear / Jira CSV)</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <p class="small muted mb"><b>Linear:</b> any view → ⌘/Ctrl-K → "Export CSV". <b>Jira:</b> issue search → Export → CSV (all fields).
    Upload the file, then review below: tick the tickets you want, and set assignee &amp; project per ticket — or for all selected at once.
    Tickets are tagged with their source ID, so importing the same file twice never creates duplicates.</p>
    <div class="flex" style="gap:20px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="margin:0"><label class="f">CSV export *</label><input type="file" id="impFile" accept=".csv,text/csv" style="border:none;padding:0"></div>
      <label class="flex small" style="gap:6px;padding-bottom:4px"><input type="checkbox" id="impSkipCanceled" checked style="width:auto" onchange="runImport(true)"> Skip canceled / archived issues</label>
    </div>
    <div id="impPreview"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="impGo" disabled onclick="runImport(false)">Import</button>
    </div>`);
  $('#modal').classList.add('wide');
  $('#impFile').addEventListener('change', () => runImport(true));
};

window.runImport = async function (dryRun) {
  const file = $('#impFile').files[0];
  if (!file) { toast('Pick your Linear CSV export first', true); return; }
  if (!dryRun && !IMP) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('dry_run', dryRun ? '1' : '0');
  fd.append('skip_canceled', $('#impSkipCanceled').checked ? '1' : '0');
  if (!dryRun) {
    // send the user's row-level choices; rows left unchecked are omitted → skipped
    const overrides = {};
    for (const [i, st] of Object.entries(IMP.rows)) {
      if (!st.checked) continue;
      overrides[i] = {
        assignee_id: st.assignee_id ? Number(st.assignee_id) : null,
        ...(st.project.startsWith('id:') ? { project_id: Number(st.project.slice(3)) }
          : st.project.startsWith('new:') ? { project_new: st.project.slice(4) } : {}),
      };
    }
    fd.append('overrides', JSON.stringify(overrides));
  } else {
    $('#impPreview').innerHTML = '<div class="muted small" style="padding:10px 0">Analyzing file…</div>';
  }
  let r;
  try {
    const res = await fetch('/api/import/linear', { method: 'POST', body: fd });
    r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Import failed');
  } catch (e) {
    $('#impPreview').innerHTML = `<div class="card" style="border-color:var(--red);margin-top:10px"><b class="small" style="color:var(--red)">⚠ ${esc(e.message)}</b></div>`;
    $('#impGo').disabled = true;
    return;
  }
  if (!dryRun) {
    toast(`Imported ${r.created.length} tickets ✨`);
    closeModal();
    await refreshBase();
    route();
    return;
  }
  IMP = { preview: r.preview, stats: r.stats, warnings: r.warnings, newProjects: [], rows: {} };
  for (const p of r.preview) {
    if (p.action !== 'import') continue;
    let project = '';
    if (p.project_id) project = 'id:' + p.project_id;
    else if (p.project_name) {
      project = 'new:' + p.project_name;
      if (!IMP.newProjects.some((n) => n.toLowerCase() === p.project_name.toLowerCase())) IMP.newProjects.push(p.project_name);
    }
    IMP.rows[p.index] = { checked: true, assignee_id: p.assignee_id || '', project };
  }
  impRender();
};

const impUserOpts = (sel) => `<option value="">— Unassigned —</option>` +
  S.users.filter((u) => u.active !== 0).map((u) => `<option value="${u.id}" ${String(sel) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
const impProjectOpts = (sel) => `<option value="">— No project —</option>` +
  S.projects.map((p) => `<option value="id:${p.id}" ${sel === 'id:' + p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('') +
  IMP.newProjects.map((n) => `<option value="new:${esc(n)}" ${sel === 'new:' + n ? 'selected' : ''}>➕ ${esc(n)} (new)</option>`).join('') +
  `<option value="__create__">➕ Create new project…</option>`;

function impRow(p) {
  const st = IMP.rows[p.index];
  if (!st) return `<tr style="opacity:.45">
    <td></td><td class="small muted">${esc(p.linear_id)}</td>
    <td class="small">${esc(p.title.slice(0, 38))}</td>
    <td colspan="6" class="small muted">${p.action === 'duplicate' ? 'already imported — will not be duplicated' : esc(p.notes.join(' · ') || 'skipped')}</td>
    <td></td></tr>`;
  return `<tr>
    <td><input type="checkbox" ${st.checked ? 'checked' : ''} onchange="impToggle(${p.index}, this.checked)" style="width:auto"></td>
    <td class="small muted">${esc(p.linear_id)}</td>
    <td class="small" title="${esc(p.title)}"><b>${esc(p.title.slice(0, 38))}</b>${p.notes.length ? `<div class="small muted">${esc(p.notes.join(' · '))}</div>` : ''}</td>
    <td>${badge(p.status)}</td><td>${badge(p.priority)}</td>
    <td class="small muted">${p.estimate_hours ? p.estimate_hours + 'h' : '—'}</td>
    <td class="small muted">${esc(p.deadline || '—')}</td>
    <td class="small muted" title="${esc(p.created_at || '')}">${esc((p.created_at || '').slice(0, 10) || '—')}</td>
    <td><select class="small" style="width:135px;padding:3px 6px" onchange="impRowAss(${p.index}, this.value)">${impUserOpts(st.assignee_id)}</select></td>
    <td><select class="small" style="width:160px;padding:3px 6px" onchange="impRowProj(${p.index}, this)">${impProjectOpts(st.project)}</select></td>
  </tr>`;
}

function impRender() {
  const s = IMP.stats;
  const prevWrap = $('#impTableWrap');
  const scroll = prevWrap ? prevWrap.scrollTop : 0;
  $('#impPreview').innerHTML = `
    <div class="grid kpis" style="margin:12px 0">
      <div class="card kpi" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${s.total}</div><div class="l">Rows in file</div></div>
      <div class="card kpi ok" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${s.importable}</div><div class="l">Ready to import</div></div>
      <div class="card kpi" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${s.duplicates}</div><div class="l">Already imported</div></div>
      <div class="card kpi" style="box-shadow:none"><div class="v" style="font-size:1.2rem">${s.skipped}</div><div class="l">Skipped (canceled)</div></div>
    </div>
    ${s.unmatched_assignees.length ? `<div class="small mb">👤 No matching user for: ${s.unmatched_assignees.map((u) => `<span class="chip">${esc(u)}</span>`).join(' ')} — pick an assignee below, or leave unassigned.</div>` : ''}
    ${IMP.warnings.map((w) => `<div class="small mb" style="color:var(--amber)">⚠ ${esc(w)}</div>`).join('')}
    <div class="flex small" style="gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap">
      <b id="impCount" style="white-space:nowrap"></b>
      <span class="muted" style="white-space:nowrap">Set for all selected:</span>
      <select id="impBulkAss" class="small" style="width:180px;padding:4px 6px" onchange="impBulkAss(this)">
        <option value="">👤 Assign selected to…</option>
        <option value="none">— Unassigned —</option>
        ${S.users.filter((u) => u.active !== 0).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
      </select>
      <select id="impBulkProj" class="small" style="width:200px;padding:4px 6px" onchange="impBulkProj(this)">
        <option value="">📁 Move selected to…</option>
        <option value="none">— No project —</option>
        ${S.projects.map((p) => `<option value="id:${p.id}">${esc(p.name)}</option>`).join('')}
        ${IMP.newProjects.map((n) => `<option value="new:${esc(n)}">➕ ${esc(n)} (new)</option>`).join('')}
        <option value="__create__">➕ Create new project…</option>
      </select>
    </div>
    <div id="impTableWrap" style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
      <table class="data"><thead><tr>
        <th style="width:26px"><input type="checkbox" id="impAll" checked onchange="impToggleAll(this.checked)" style="width:auto" title="Select / deselect all"></th>
        <th>ID</th><th>Title</th><th>Status</th><th>Priority</th><th>Est</th><th>Due</th><th>Created</th><th>Assignee</th><th>Project</th>
      </tr></thead>
      <tbody>${IMP.preview.map(impRow).join('')}</tbody></table>
    </div>`;
  $('#impTableWrap').scrollTop = scroll;
  impUpdateCount();
}

function impRerenderTable() {
  const wrap = $('#impTableWrap');
  const scroll = wrap.scrollTop;
  wrap.querySelector('tbody').innerHTML = IMP.preview.map(impRow).join('');
  wrap.scrollTop = scroll;
  impUpdateCount();
}

function impUpdateCount() {
  const all = Object.values(IMP.rows);
  const n = all.filter((s) => s.checked).length;
  $('#impCount').textContent = `${n} of ${all.length} selected`;
  $('#impAll').checked = n === all.length && n > 0;
  const go = $('#impGo');
  go.disabled = n === 0;
  go.textContent = n ? `Import ${n} ticket${n === 1 ? '' : 's'}` : 'Import';
}

// prompts for a project name; returns a select value ('new:Name', or 'id:N' if it already exists)
function impNewProjectValue() {
  let name = prompt('Name of the new project:');
  name = name && name.trim();
  if (!name) return null;
  const existing = S.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) { toast(`"${existing.name}" already exists — using that project`); return 'id:' + existing.id; }
  if (!IMP.newProjects.some((n) => n.toLowerCase() === name.toLowerCase())) IMP.newProjects.push(name);
  return 'new:' + name;
}

window.impToggle = (i, on) => { IMP.rows[i].checked = on; impUpdateCount(); };
window.impToggleAll = (on) => {
  for (const st of Object.values(IMP.rows)) st.checked = on;
  impRerenderTable();
};
window.impRowAss = (i, v) => { IMP.rows[i].assignee_id = v; };
window.impRowProj = (i, sel) => {
  let v = sel.value;
  if (v === '__create__') {
    v = impNewProjectValue();
    if (!v) { sel.value = IMP.rows[i].project; return; }
  }
  IMP.rows[i].project = v;
  if (v.startsWith('new:')) impRender(); // the new project must appear as an option everywhere
};
window.impBulkAss = (sel) => {
  if (!sel.value) return;
  const v = sel.value === 'none' ? '' : sel.value;
  const hit = Object.values(IMP.rows).filter((st) => st.checked);
  hit.forEach((st) => { st.assignee_id = v; });
  sel.value = '';
  impRerenderTable();
  toast(`Assignee updated on ${hit.length} selected ticket${hit.length === 1 ? '' : 's'}`);
};
window.impBulkProj = (sel) => {
  let v = sel.value;
  if (!v) return;
  if (v === '__create__') {
    v = impNewProjectValue();
    if (!v) { sel.value = ''; return; }
  } else if (v === 'none') v = '';
  const hit = Object.values(IMP.rows).filter((st) => st.checked);
  hit.forEach((st) => { st.project = v; });
  const msg = `Project updated on ${hit.length} selected ticket${hit.length === 1 ? '' : 's'}`;
  impRender(); // full rerender: a created project must appear in every select
  toast(msg);
};

// ---- Calendar: pull meetings from the connected Google Calendar (.ics) feed ----
// RSVP status → compact indicator
const rsvpIcon = (s) => ({ accepted: '✓', declined: '✗', tentative: '?' }[s] || '·');
const rsvpLabel = (s) => ({ accepted: 'Accepted', declined: 'Declined', tentative: 'Tentative', 'needs-action': 'No response' }[s] || 'Invited');
let calWeek = null; // Monday of the week shown; null = current
async function pageCalendar() {
  const mon = calWeek || mondayOf(new Date());
  const to = addDays(mon, 6);
  $('#content').innerHTML = `
    <div class="card">
      <div class="spread mb">
        <div class="flex">
          <button class="btn sm" onclick="calNav(-7)">‹</button>
          <b class="small" style="min-width:210px;text-align:center">${hlWeekLabel(mon)}</b>
          <button class="btn sm" onclick="calNav(7)">›</button>
          <button class="btn sm" onclick="calNav(0)">This week</button>
        </div>
        <a class="btn sm" href="#/settings">⚙ Calendar settings</a>
      </div>
      <div id="calBody"><div class="muted small" style="padding:12px 0">Loading your calendar…</div></div>
    </div>`;
  let r;
  try { r = await api(`/api/calendar/events?from=${mon}&to=${to}`); }
  catch (e) { $('#calBody').innerHTML = `<div class="small" style="color:var(--red)">⚠ ${esc(e.message)}</div>`; return; }
  if (!r.configured) {
    $('#calBody').innerHTML = `<div class="empty" style="padding:24px"><div class="big">🗓️</div>
      <p>You haven't connected your calendar yet. Add your Google Calendar's <b>secret iCal URL</b> in Settings and your meetings show up here — private to you.</p>
      <a class="btn primary" href="#/settings">Connect my calendar</a></div>`;
    return;
  }
  const byDay = {};
  for (const e of r.events) (byDay[e.date] = byDay[e.date] || []).push(e);
  const days = [...Array(7)].map((_, i) => addDays(mon, i));
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('#calBody').innerHTML = `
    ${r.skipped_recurring ? `<div class="small muted mb">↻ ${r.skipped_recurring} recurring event(s) hidden — recurring meetings aren't imported yet.</div>` : ''}
    ${r.events.length ? days.map((d, i) => {
      const evs = byDay[d] || [];
      if (!evs.length) return '';
      return `<div style="margin-bottom:12px">
        <div class="small muted" style="margin-bottom:5px">${dayNames[i]} · ${d}</div>
        ${evs.map((e) => {
          const payload = (o) => JSON.stringify(o).replace(/'/g, '&#39;');
          return `<div class="cal-ev">
          <div style="flex:1;min-width:0"><b class="small">${esc(e.title)}</b>
            <div class="small muted">${e.start}–${e.end} · ${fmtH(e.hours)}h${e.location ? ' · 📍 ' + esc(e.location) : ''}</div>
            ${e.organizer ? `<div class="small muted" style="margin-top:3px">👑 ${esc(e.organizer.name)} <span style="color:var(--faint)">· organizer</span></div>` : ''}
            ${e.guests && e.guests.length ? `<div class="small muted cal-guests">👥 ${e.guests.map((g) => `<span title="${esc(rsvpLabel(g.status))}">${rsvpIcon(g.status)} ${esc(g.name)}</span>`).join(', ')}</div>` : ''}
            ${e.description ? `<div class="cal-desc small muted">${md(e.description)}</div>` : ''}</div>
          <div class="flex" style="gap:6px;align-self:flex-start;flex-shrink:0">
            <button class="btn sm" onclick='calLog(this, ${payload({ date: e.date, hours: e.hours, title: e.title })})'>＋ Log ${fmtH(e.hours)}h</button>
            <button class="btn sm" onclick='calTicket(${payload({ title: e.title, description: e.description, location: e.location, date: e.date, link: e.link })})'>＋ Ticket</button>
          </div>
        </div>`;
        }).join('')}
      </div>`;
    }).join('') || '<div class="muted small" style="padding:12px 0">No meetings this week 🎉</div>'
      : '<div class="muted small" style="padding:12px 0">No meetings this week 🎉</div>'}`;
}
window.calNav = (d) => { calWeek = d === 0 ? null : addDays(calWeek || mondayOf(new Date()), d); pageCalendar(); };
// open the ticket form pre-filled from a calendar event (meeting → action item)
window.calTicket = function (ev) {
  const parts = [];
  if (ev.description) parts.push(ev.description);
  const meta = [`From meeting: ${ev.title}`, `Date: ${ev.date}`];
  if (ev.location) meta.push(`Location: ${ev.location}`);
  parts.push(meta.join(' · '));
  // assign to the person whose calendar this is — the logged-in user
  openTicketForm({ title: ev.title, description: parts.join('\n\n'), link: ev.link || '', assignee_id: S.currentUser.id });
};
window.calLog = async function (btn, ev) {
  btn.disabled = true;
  try {
    await api('/api/time-entries', { method: 'POST', body: {
      user_id: S.currentUser.id, hours: ev.hours, date: ev.date,
      category: 'meetings', description: ev.title,
    } });
    btn.textContent = '✓ Logged';
    btn.classList.add('primary');
    toast(`Logged ${fmtH(ev.hours)}h — ${ev.title}`);
  } catch (e) { toast(e.message, true); btn.disabled = false; }
};

// ---- Time analytics (management view) ----
const hbar = (label, value, max, color = 'var(--brand)', suffix = 'h', extra = '') =>
  `<div class="bar-row"><span class="small" title="${esc(label)}">${esc(String(label).slice(0, 26))}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min((value / (max || 1)) * 100, 100)}%;background:${color}"></div></div>
    <span class="small muted">${fmtH(value)}${suffix}${extra}</span></div>`;

async function pageTimeAnalytics() {
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const saved = S.taFilters || { from: monthAgo.toISOString().slice(0, 10), to: today(), team_id: '', user_id: '', project_id: '' };
  S.taFilters = saved;
  $('#content').innerHTML = `
    <div class="card mb"><div class="filters" style="margin-bottom:0">
      <div><label class="f">From</label><input type="date" id="taFrom" value="${saved.from}"></div>
      <div><label class="f">To</label><input type="date" id="taTo" value="${saved.to}"></div>
      <div><label class="f">Team</label><select id="taTeam">${opts(S.teams, 'id', 'name', saved.team_id, 'All teams')}</select></div>
      <div><label class="f">Person</label><select id="taUser">${opts(S.users, 'id', 'name', saved.user_id, 'Everyone')}</select></div>
      <div><label class="f">Project</label><select id="taProject">${opts(S.projects, 'id', 'name', saved.project_id, 'All projects')}</select></div>
      <div><label class="f">&nbsp;</label><span id="taExports"></span></div>
    </div></div>
    <div id="taOut"><div class="muted" style="padding:20px">Loading…</div></div>`;
  const rerun = () => {
    S.taFilters = { from: $('#taFrom').value, to: $('#taTo').value, team_id: $('#taTeam').value, user_id: $('#taUser').value, project_id: $('#taProject').value };
    renderTimeAnalytics();
  };
  ['taFrom', 'taTo', 'taTeam', 'taUser', 'taProject'].forEach((id) => $('#' + id).addEventListener('change', rerun));
  renderTimeAnalytics();
}

async function renderTimeAnalytics() {
  const f = S.taFilters;
  const params = new URLSearchParams({ from: f.from, to: f.to });
  if (f.team_id) params.set('team_id', f.team_id);
  if (f.user_id) params.set('user_id', f.user_id);
  if (f.project_id) params.set('project_id', f.project_id);
  const a = await api('/api/time-analytics?' + params);

  // Export buttons target the most specific report for the current filters
  let repType = 'time', repParams = new URLSearchParams({ from: f.from, to: f.to });
  if (f.user_id) { repType = 'user'; repParams.set('user_id', f.user_id); }
  else if (f.team_id) { repType = 'team'; repParams.set('team_id', f.team_id); }
  else if (f.project_id) { repType = 'project'; repParams = new URLSearchParams({ project_id: f.project_id }); }
  $('#taExports').innerHTML = `<a class="btn" href="/api/export/excel/${repType}?${repParams}">⬇ Excel</a>
    <a class="btn" href="/api/export/pdf/${repType}?${repParams}">⬇ PDF</a>`;

  if (!a.total_hours) {
    $('#taOut').innerHTML = `<div class="card empty"><div class="big">📈</div><p>No time logged for this selection. Widen the date range or clear a filter.</p></div>`;
    return;
  }
  const maxUser = Math.max(...a.byUser.map((u) => Math.max(u.hours, u.capacity_period)), 1);
  const maxProj = Math.max(...a.byProject.map((p) => p.hours), 1);
  const maxCat = Math.max(...a.byCategory.map((c) => c.hours), 1);
  const maxDay = Math.max(...a.byDay.map((d) => d.hours), 1);
  const maxTicket = Math.max(...a.byTicket.flatMap((t) => [t.logged_hours, t.estimate_hours || 0]), 1);
  const utilColor = (u) => u === null ? 'var(--muted)' : u > 105 ? 'var(--red)' : u < 60 ? 'var(--amber)' : 'var(--green)';

  $('#taOut').innerHTML = `
    <div class="grid kpis">
      <div class="card kpi"><div class="v">${fmtH(a.total_hours)}</div><div class="l">Total hours</div></div>
      <div class="card kpi"><div class="v">${a.byUser.length}</div><div class="l">People logging</div></div>
      <div class="card kpi"><div class="v">${a.workdays}</div><div class="l">Workdays in period</div></div>
      <div class="card kpi"><div class="v">${fmtH(a.total_hours / (a.byUser.length || 1))}</div><div class="l">Avg h / person</div></div>
    </div>
    <div class="grid two-col">
      <div class="card">
        <div class="section-title">People — logged vs capacity</div>
        ${a.byUser.map((u) => `
          <div class="bar-row" style="grid-template-columns:130px 1fr 90px">
            <span class="flex" style="gap:7px">${avatar(u.name, u.color)}<span class="small">${esc(u.name.split(' ')[0])}</span></span>
            <div>
              <div class="bar-track" style="margin-bottom:3px"><div class="bar-fill" style="width:${Math.min((u.hours / maxUser) * 100, 100)}%;background:${esc(u.color)}"></div></div>
              <div class="bar-track" style="height:5px"><div class="bar-fill" style="width:${Math.min((u.capacity_period / maxUser) * 100, 100)}%;background:#3a3c42"></div></div>
            </div>
            <span class="small" style="color:${utilColor(u.utilization)}">${fmtH(u.hours)}h · ${u.utilization === null ? '—' : u.utilization + '%'}</span>
          </div>`).join('')}
        <div class="small muted" style="margin-top:8px">Colored bar = logged · grey bar = capacity for the period · % = utilization (<span style="color:var(--amber)">&lt;60%</span> / <span style="color:var(--green)">60–105%</span> / <span style="color:var(--red)">&gt;105%</span>)</div>
      </div>
      <div class="card">
        <div class="section-title">Task comparison — estimated vs logged</div>
        ${a.byTicket.length ? a.byTicket.map((t) => `
          <div class="bar-row" style="grid-template-columns:170px 1fr 80px">
            <span class="small" title="${esc(t.title)}"><b>${esc(t.key)}</b> ${esc(t.title.slice(0, 20))}${t.title.length > 20 ? '…' : ''}</span>
            <div>
              <div class="bar-track" style="height:6px;margin-bottom:3px"><div class="bar-fill" style="width:${Math.min(((t.estimate_hours || 0) / maxTicket) * 100, 100)}%;background:#94a3b8"></div></div>
              <div class="bar-track" style="height:6px"><div class="bar-fill" style="width:${Math.min((t.logged_hours / maxTicket) * 100, 100)}%;background:${t.logged_hours > (t.estimate_hours || 0) && t.estimate_hours ? 'var(--red)' : 'var(--brand)'}"></div></div>
            </div>
            <span class="small muted">${fmtH(t.estimate_hours || 0)} / <b>${fmtH(t.logged_hours)}</b>h</span>
          </div>`).join('') : '<div class="muted small">No ticket-linked time in this period.</div>'}
        <div class="small muted" style="margin-top:8px">Grey = estimate · colored = logged (<span style="color:var(--red)">red when over estimate</span>) · sorted by logged hours</div>
      </div>
      <div class="card">
        <div class="section-title">Hours by project</div>
        ${a.byProject.map((p, i) => hbar(p.name, p.hours, maxProj, ['#5e6ad2', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'][i % 6])).join('')}
        <div class="section-title" style="margin-top:18px">Hours by category</div>
        ${a.byCategory.map((c) => hbar(cap(c.name), c.hours, maxCat, '#64748b')).join('')}
      </div>
      <div class="card">
        <div class="section-title">Daily trend</div>
        <div style="display:flex;align-items:flex-end;gap:3px;height:140px;padding-top:10px">
          ${a.byDay.map((d) => `<div title="${d.date}: ${fmtH(d.hours)}h" style="flex:1;background:var(--brand);opacity:.85;border-radius:3px 3px 0 0;height:${Math.max((d.hours / maxDay) * 100, 2)}%"></div>`).join('')}
        </div>
        <div class="spread small muted" style="margin-top:6px"><span>${a.byDay[0]?.date || ''}</span><span>${a.byDay[a.byDay.length - 1]?.date || ''}</span></div>
        <p class="small muted" style="margin-top:12px">💡 The Excel/PDF buttons above export exactly this selection — the PDF includes these comparison charts, the Excel a Charts sheet plus filterable raw data.</p>
      </div>
    </div>`;
}

// ================= REPORTS =================
const REPORT_DEFS = [
  { type: 'user', label: '👤 Individual user', needs: ['user', 'range'] },
  { type: 'team', label: '👥 Team', needs: ['team', 'range'] },
  { type: 'project', label: '📁 Project', needs: ['project'] },
  { type: 'tickets', label: '🎫 Tickets', needs: ['project?', 'team?', 'overdue?'] },
  { type: 'roadmap', label: '🗺️ Roadmap', needs: [] },
  { type: 'time', label: '📅 Time period', needs: ['range'] },
  { type: 'missing', label: '🚨 Missing time reports', needs: ['days'] },
  { type: 'workload', label: '⚖️ Workload & capacity', needs: ['range'] },
];
async function pageReports() {
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  $('#content').innerHTML = `
    <div class="card mb">
      <div class="filters" style="margin-bottom:0">
        <div><label class="f">Report type</label><select id="rtype">${REPORT_DEFS.map((r) => `<option value="${r.type}">${r.label}</option>`).join('')}</select></div>
        <div id="r-user" hidden><label class="f">User</label><select id="ruser">${opts(S.users, 'id', 'name', S.currentUser?.id)}</select></div>
        <div id="r-team" hidden><label class="f">Team</label><select id="rteam">${opts(S.teams, 'id', 'name', '')}</select></div>
        <div id="r-project" hidden><label class="f">Project</label><select id="rproject">${opts(S.projects, 'id', 'name', '')}</select></div>
        <div id="r-from" hidden><label class="f">From</label><input type="date" id="rfrom" value="${monthAgo.toISOString().slice(0, 10)}"></div>
        <div id="r-to" hidden><label class="f">To</label><input type="date" id="rto" value="${today()}"></div>
        <div id="r-days" hidden><label class="f">Look-back days</label><input type="number" id="rdays" value="14" min="1" max="60"></div>
        <div id="r-overdue" hidden><label class="f">&nbsp;</label><label class="flex small" style="gap:6px;padding:8px 0"><input type="checkbox" id="roverdue" style="width:auto"> Overdue only</label></div>
        <div><label class="f">&nbsp;</label><button class="btn primary" onclick="runReport()">Generate</button></div>
        <div><label class="f">&nbsp;</label><span><a class="btn" id="dlExcel" href="#">⬇ Excel</a> <a class="btn" id="dlPdf" href="#">⬇ PDF</a></span></div>
      </div>
    </div>
    <div id="reportOut"><div class="card empty"><div class="big">📑</div><p>Pick a report type and click <b>Generate</b> to preview it here.<br>Every report can be downloaded as Excel or PDF.</p></div></div>`;
  const upd = () => {
    const def = REPORT_DEFS.find((r) => r.type === $('#rtype').value);
    const needs = def.needs.map((n) => n.replace('?', ''));
    $('#r-user').hidden = !needs.includes('user');
    $('#r-team').hidden = !needs.includes('team');
    $('#r-project').hidden = !needs.includes('project');
    $('#r-from').hidden = $('#r-to').hidden = !needs.includes('range');
    $('#r-days').hidden = !needs.includes('days');
    $('#r-overdue').hidden = !needs.includes('overdue');
  };
  $('#rtype').addEventListener('change', () => { upd(); runReport(); });
  // every filter regenerates the report immediately — no Generate click needed
  ['ruser', 'rteam', 'rproject', 'rfrom', 'rto', 'rdays', 'roverdue'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', () => runReport());
  });
  upd();
  runReport(); // show analytics immediately instead of an empty state
}
window.runReport = async function () {
  const type = $('#rtype').value;
  const def = REPORT_DEFS.find((r) => r.type === type);
  const needs = def.needs.map((n) => n.replace('?', ''));
  const params = new URLSearchParams();
  if (needs.includes('user')) params.set('user_id', $('#ruser').value);
  if (needs.includes('team') && $('#rteam').value) params.set('team_id', $('#rteam').value);
  if (needs.includes('project') && $('#rproject').value) params.set('project_id', $('#rproject').value);
  if (needs.includes('range')) { params.set('from', $('#rfrom').value); params.set('to', $('#rto').value); }
  if (needs.includes('days')) params.set('days', $('#rdays').value);
  if (needs.includes('overdue') && $('#roverdue').checked) params.set('overdue', '1');
  const qs = params.toString();
  $('#dlExcel').href = `/api/export/excel/${type}${qs ? '?' + qs : ''}`;
  $('#dlPdf').href = `/api/export/pdf/${type}${qs ? '?' + qs : ''}`;
  try {
    const r = await api(`/api/reports/${type}${qs ? '?' + qs : ''}`);
    $('#reportOut').innerHTML = `
      <div class="card mb">
        <div class="section-title">${esc(r.title)}</div>
        <div class="small muted mb">${esc(r.subtitle || '')}</div>
        ${r.description ? `<div class="small muted mb" style="font-style:italic;border-left:2px solid var(--brand);padding-left:10px">${esc(r.description)}</div>` : ''}
        <div class="grid kpis" style="margin-bottom:0">${(r.summary || []).map((s) => `<div class="kpi card" style="box-shadow:none"><div class="v" style="font-size:1.3rem">${esc(String(s.value))}</div><div class="l">${esc(s.label)}</div></div>`).join('')}</div>
      </div>
      ${(r.charts || []).filter((ch) => ch.rows.length).length ? `<div class="grid two-col mb">${r.charts.filter((ch) => ch.rows.length).map((ch) => {
        const max = Math.max(...ch.rows.flatMap((row) => row.values.map(Number)), 1);
        const colors = ['#94a3b8', '#5e6ad2'];
        if (ch.type === 'columns') {
          return `<div class="card"><div class="section-title">${esc(ch.heading)}</div>
            <div style="display:flex;align-items:flex-end;gap:4px;height:130px;padding-top:8px">
              ${ch.rows.map((row) => `<div title="${esc(row.label)}: ${row.values[0]}h" style="flex:1;background:var(--brand);opacity:.85;border-radius:3px 3px 0 0;height:${Math.max((Number(row.values[0]) / max) * 100, 2)}%"></div>`).join('')}
            </div>
            <div class="spread small muted" style="margin-top:6px"><span>${esc(ch.rows[0].label)}</span><span>${esc(ch.rows[ch.rows.length - 1].label)}</span></div>
            ${ch.note ? `<div class="small" style="color:var(--faint);margin-top:8px">${esc(ch.note)}</div>` : ''}
          </div>`;
        }
        return `<div class="card"><div class="section-title">${esc(ch.heading)}</div>
          ${ch.series.length > 1 ? `<div class="small muted" style="margin-bottom:8px">${ch.series.map((s, i) => `<span class="dot" style="background:${colors[i]}"></span> ${esc(s)}&nbsp;&nbsp;`).join('')}</div>` : ''}
          ${ch.rows.slice(0, 15).map((row) => `<div class="bar-row" style="grid-template-columns:160px 1fr 70px">
            <span class="small" title="${esc(row.label)}">${esc(String(row.label).slice(0, 24))}</span>
            <div>${row.values.map((v, i) => `<div class="bar-track" style="height:${ch.series.length > 1 ? 5 : 9}px;margin-bottom:2px"><div class="bar-fill" style="width:${Math.min((Number(v) / max) * 100, 100)}%;background:${colors[i % colors.length]}"></div></div>`).join('')}</div>
            <span class="small muted">${row.values.map(Number).map((v) => fmtH(v)).join(' / ')}h</span>
          </div>`).join('')}
          ${ch.note ? `<div class="small" style="color:var(--faint);margin-top:8px">${esc(ch.note)}</div>` : ''}</div>`;
      }).join('')}</div>` : ''}
      ${r.sections.map((sec) => `<div class="card mb" style="overflow-x:auto">
        <div class="section-title">${esc(sec.heading)}</div>
        <table class="data"><thead><tr>${sec.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${sec.rows.slice(0, 200).map((row) => `<tr>${sec.columns.map((c) => {
          const v = row[c.key];
          if (['status', 'priority'].includes(c.key)) return `<td>${badge(v)}</td>`;
          if (c.key === 'category') return `<td class="small">${esc(cap(String(v ?? '')))}</td>`;
          return `<td class="small">${esc(String(v ?? ''))}</td>`;
        }).join('')}</tr>`).join('') || `<tr><td colspan="${sec.columns.length}" class="muted small">No data</td></tr>`}</tbody></table>
        ${sec.rows.length > 200 ? `<div class="small muted" style="padding-top:8px">Showing 200 of ${sec.rows.length} rows — download Excel/PDF for the full data.</div>` : ''}
      </div>`).join('')}`;
  } catch (e) { toast(e.message, true); }
};

// ================= AI =================
async function pageAI() {
  $('#content').innerHTML = `
    <div class="chat">
      <div class="suggestions">
        ${['Which tickets are overdue?', 'Who is missing time reports?', 'Summarize the Billing Engine project', 'Create a ticket: fix the login page spinner', 'What did team Platform work on last week?', 'Suggest roadmap improvements', 'Generate a workload report']
          .map((s) => `<button onclick="askAI('${s.replace(/'/g, "\\'")}')">${s}</button>`).join('')}
      </div>
      <div class="chat-log" id="chatLog"></div>
      <form class="chat-input" onsubmit="return sendChat(event)">
        <input id="chatBox" placeholder="Ask about tickets, time, workload — or ask me to create a ticket…" autocomplete="off">
        <button class="btn primary">Send</button>
      </form>
    </div>`;
  renderChat();
  if (!S.chat.length) {
    S.chat.push({ role: 'assistant', content: `Hi ${S.currentUser?.name.split(' ')[0]}! 👋 I'm your TimePort assistant. I can create tickets from a description, summarize projects and people's work, find missing time reports, check workload, suggest roadmap improvements, and generate Excel/PDF reports. Try one of the suggestions above.` });
    renderChat();
  }
}
function renderChat(typing = false) {
  const log = $('#chatLog');
  if (!log) return;
  log.innerHTML = S.chat.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.content) : esc(m.content)}</div>`).join('') +
    (typing ? '<div class="typing">Assistant is thinking…</div>' : '');
  log.scrollTop = log.scrollHeight;
}
window.askAI = function (q) { $('#chatBox').value = ''; sendChatText(q); };
window.sendChat = function (e) {
  e.preventDefault();
  const text = $('#chatBox').value.trim();
  if (text) { $('#chatBox').value = ''; sendChatText(text); }
  return false;
};
async function sendChatText(text) {
  S.chat.push({ role: 'user', content: text });
  renderChat(true);
  try {
    const r = await api('/api/ai/chat', { method: 'POST', body: { messages: S.chat.map((m) => ({ role: m.role, content: m.content })), user_id: S.currentUser?.id } });
    S.chat.push({ role: 'assistant', content: r.reply });
    if (r.actions?.some((a) => a.type === 'ticket_created')) toast('Ticket created by AI ✨');
  } catch (e) {
    S.chat.push({ role: 'assistant', content: `Sorry, something went wrong: ${e.message}` });
  }
  renderChat();
}

// ================= INTEGRATIONS =================
const INTEGRATION_CATALOG = [
  {
    id: 'openai', icon: '🤖', color: '#10a37f', name: 'OpenAI',
    desc: 'Power the AI Assistant with OpenAI (GPT). Paste an API key and the assistant immediately answers with your workspace data — creating tickets, summarizing work, finding gaps and generating reports.',
    fields: [
      { k: 'api_key', label: 'API key', type: 'password', ph: 'sk-…' },
      { k: 'model', label: 'Model (optional)', ph: 'gpt-4o (default)' },
    ],
    actions: [{ label: '✨ Open AI Assistant', onclick: "location.hash='#/ai'" }],
    note: 'Live — the assistant uses this key as soon as it is saved. If both OpenAI and Anthropic are connected, the most recently saved one wins.',
  },
  {
    id: 'anthropic', icon: '✳️', color: '#d97757', name: 'Anthropic (Claude)',
    desc: 'Power the AI Assistant with Claude. Paste an API key and the assistant immediately answers with your workspace data — creating tickets, summarizing work, finding gaps and generating reports.',
    fields: [
      { k: 'api_key', label: 'API key', type: 'password', ph: 'sk-ant-…' },
      { k: 'model', label: 'Model (optional)', ph: 'claude-opus-4-8 (default)' },
    ],
    actions: [{ label: '✨ Open AI Assistant', onclick: "location.hash='#/ai'" }],
    note: 'Live — the assistant uses this key as soon as it is saved. Also works via the ANTHROPIC_API_KEY environment variable.',
  },
  {
    id: 'linear', icon: '◣', color: '#5e6ad2', name: 'Linear',
    desc: 'Import issues from Linear. Imported tickets keep their Linear ID, so re-imports never create duplicates, and each ticket links back to Linear.',
    fields: [
      { k: 'api_key', label: 'Personal API key', type: 'password', ph: 'lin_api_…' },
      { k: 'workspace', label: 'Workspace name', ph: 'Acme' },
    ],
    actions: [{ label: '⬆ Import CSV now', onclick: 'openImportModal()' }],
    note: 'CSV import works today. Live API sync (two-way status updates) is a template — the saved key will be used once it ships.',
  },
  {
    id: 'jira', icon: '🟦', color: '#4ea7fc', name: 'Jira',
    desc: 'Bring Jira issues into TimePort. The CSV importer understands Jira exports (Summary, Issue key, Status, Original estimate…).',
    fields: [
      { k: 'site', label: 'Site URL', ph: 'your-team.atlassian.net' },
      { k: 'email', label: 'Account email', ph: 'you@company.com' },
      { k: 'api_token', label: 'API token', type: 'password', ph: 'ATATT…' },
    ],
    actions: [{ label: '⬆ Import CSV now', onclick: 'openImportModal()' }],
    note: 'CSV import works today (Jira → Export issues → CSV). Live API sync is a template — credentials are stored for when it ships.',
  },
  {
    id: 'gmail', icon: '✉️', color: '#eb5757', name: 'Google Mail',
    desc: 'Email-to-ticket: connect a Google account or a shared inbox, and incoming mails become tickets with the thread attached.',
    fields: [
      { k: 'address', label: 'Intake address (planned)', ph: 'tickets@yourcompany.com' },
    ],
    actions: [],
    note: 'Template — the Google OAuth connection is coming soon. You can save the planned intake address already.',
  },
];

async function pageIntegrations() {
  const saved = await api('/api/integrations');
  const byId = Object.fromEntries(saved.map((s) => [s.provider, s]));
  const isMgr = ['admin', 'manager'].includes(S.currentUser.role);
  $('#content').innerHTML = `
    <p class="small muted mb">Connect external tools and import their data into TimePort. Configuration is workspace-wide${isMgr ? '' : ' — ask a manager or admin to connect or change integrations'}.</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">
      ${INTEGRATION_CATALOG.map((it) => {
        const conn = byId[it.id];
        return `<div class="card">
          <div class="spread mb">
            <span class="flex" style="gap:10px">
              <span class="int-icon" style="color:${it.color}">${it.icon}</span>
              <b>${esc(it.name)}</b>
            </span>
            ${conn ? '<span class="badge b-active">Connected</span>' : '<span class="badge b-backlog">Template</span>'}
          </div>
          <p class="small muted" style="margin-bottom:10px">${esc(it.desc)}</p>
          ${conn ? `<div class="small mb" style="background:var(--bg-2);border:1px solid var(--border);border-radius:7px;padding:8px 10px">
            ${Object.entries(conn.config).filter(([, v]) => v).map(([k, v]) => `<div><span class="muted">${esc(k.replace(/_/g, ' '))}:</span> ${esc(String(v))}</div>`).join('') || '<span class="muted">No settings saved yet</span>'}
            <div class="muted" style="margin-top:4px">Set up by ${esc(conn.connected_by || '—')} · ${esc((conn.updated_at || '').slice(0, 10))}</div>
          </div>` : ''}
          <div class="flex" style="flex-wrap:wrap">
            ${isMgr ? `<button class="btn sm ${conn ? '' : 'primary'}" onclick="configureIntegration('${it.id}')">${conn ? '⚙ Settings' : '+ Connect'}</button>` : ''}
            ${it.actions.map((a) => `<button class="btn sm" onclick="${a.onclick}">${a.label}</button>`).join('')}
            ${conn && isMgr ? `<button class="btn sm danger" onclick="disconnectIntegration('${it.id}')">Disconnect</button>` : ''}
          </div>
          <p class="small" style="color:var(--faint);margin-top:10px">${esc(it.note)}</p>
        </div>`;
      }).join('')}
    </div>
    <div class="card" style="margin-top:14px">
      <div class="section-title">More on the way</div>
      <p class="small muted">GitHub (commits & PRs move tickets), Slack (digests + /timeport commands), and Calendar import (meetings → time entries) are on the roadmap. Tell us which one you need first.</p>
    </div>`;
}

window.configureIntegration = async function (providerId) {
  const it = INTEGRATION_CATALOG.find((x) => x.id === providerId);
  const saved = (await api('/api/integrations')).find((s) => s.provider === providerId);
  const cfg = saved ? saved.config : {};
  openModal(`
    <h2><span>${it.icon} ${esc(it.name)} settings</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <form onsubmit="return saveIntegration(event, '${providerId}')">
      ${it.fields.map((f) => `<div class="field">
        <label class="f">${esc(f.label)}</label>
        <input name="${f.k}" type="${f.type || 'text'}" placeholder="${esc(f.ph || '')}"
          value="${f.type === 'password' ? '' : esc(cfg[f.k] || '')}"
          ${f.type === 'password' && cfg[f.k] ? `title="A key is already stored (${esc(cfg[f.k])}) — leave blank to keep it"` : ''}>
        ${f.type === 'password' && cfg[f.k] ? `<div class="small" style="color:var(--faint);margin-top:3px">Stored: ${esc(cfg[f.k])} — leave blank to keep</div>` : ''}
      </div>`).join('')}
      <p class="small muted">${esc(it.note)}</p>
      <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
};
window.saveIntegration = async function (e, providerId) {
  e.preventDefault();
  const config = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/api/integrations/${providerId}`, { method: 'POST', body: { config } });
    toast('Integration saved ✅');
    closeModal();
    pageIntegrations();
  } catch (err) { toast(err.message, true); }
  return false;
};
window.disconnectIntegration = async function (providerId) {
  if (!confirm('Disconnect this integration and remove its stored settings?')) return;
  try {
    await api(`/api/integrations/${providerId}`, { method: 'DELETE' });
    toast('Integration disconnected');
    pageIntegrations();
  } catch (err) { toast(err.message, true); }
};

// ---------- Starred tickets (sidebar) ----------
async function loadStars() {
  try { S.stars = await api('/api/stars'); } catch { S.stars = []; }
  renderStarredNav();
}
function renderStarredNav() {
  const el = $('#starredNav');
  if (!el) return;
  if (!S.stars || !S.stars.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="star-label">★ Starred</div>
    ${S.stars.map((s) => `<a href="#/ticket/${encodeURIComponent(s.key)}" class="star-item ${s.is_done ? 'done' : ''}" title="${esc(s.title)}">
      <span class="star-key">${esc(s.key)}</span><span class="star-title">${esc(s.title)}</span>
      <span class="star-x" onclick="event.preventDefault();event.stopPropagation();toggleStar(${s.ticket_id})" title="Remove from starred">×</span>
    </a>`).join('')}`;
}
window.toggleStar = async function (ticketId) {
  const starred = (S.stars || []).some((s) => s.ticket_id === ticketId);
  try {
    await api(`/api/stars/${ticketId}`, { method: starred ? 'DELETE' : 'POST' });
    await loadStars();
    const btn = $('#starBtn');
    if (btn) {
      const now = S.stars.some((s) => s.ticket_id === ticketId);
      btn.innerHTML = now ? '★ Starred' : '☆ Star';
      btn.classList.toggle('starred', now);
    }
    toast(starred ? 'Removed from starred' : 'Added to starred ★');
  } catch (e) { toast(e.message, true); }
};

// ---------- Timer widget ----------
let timerState = null, timerTick = null;
const timerElapsed = () => Math.max(Math.floor((Date.now() - new Date(timerState.started_utc).getTime()) / 1000), 0);
const fmtClock = (secs) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};
async function refreshTimer() {
  try { timerState = await api('/api/timer'); } catch { timerState = null; }
  renderTimerWidget();
}
function renderTimerWidget() {
  const w = $('#timerWidget');
  clearInterval(timerTick);
  if (!timerState) { w.innerHTML = ''; return; }
  const tick = () => {
    w.innerHTML = `<div class="timer-box">
      <div class="small" style="min-width:0"><span class="timer-dot"></span> <b>${fmtClock(timerElapsed())}</b>
        <a href="#" onclick="openTicket(${timerState.ticket_id});return false" title="${esc(timerState.title || '')}" style="color:var(--muted)">${esc(timerState.key || '')}</a></div>
      <button class="btn sm" onclick="openStopTimer()" title="Stop and log this time">■ Stop</button>
    </div>`;
  };
  tick();
  timerTick = setInterval(tick, 1000);
}
window.startTimer = async function (ticketId) {
  try {
    const r = await api('/api/timer/start', { method: 'POST', body: { ticket_id: ticketId } });
    if (r.stopped) toast(`Previous timer logged: ${fmtDur(r.stopped.hours)}`);
    timerState = r.timer;
    renderTimerWidget();
    toast('Timer started ▶');
    closeModal();
  } catch (e) { toast(e.message, true); }
};
window.openStopTimer = function () {
  if (!timerState) return;
  openModal(`
    <h2><span>■ Stop timer — ${esc(timerState.key || '')}</span><button class="close-x" onclick="closeModal()">✕</button></h2>
    <p class="muted small mb">Running for <b id="stopClock">${fmtClock(timerElapsed())}</b> on “${esc(timerState.title || 'work')}”. Stopping logs this time on today.</p>
    <form class="form-grid" onsubmit="return doStopTimer(event)">
      <div class="field full"><label class="f">What did you do?</label><input name="description" placeholder="e.g. Implemented rating edge cases" autofocus></div>
      <div class="field"><label class="f">Category</label><select name="category">${enumOpts(S.meta.timeCategories, 'development')}</select></div>
      <div class="modal-actions full"><button type="button" class="btn" onclick="closeModal()">Keep running</button><button class="btn primary">Stop & log</button></div>
    </form>`);
  const iv = setInterval(() => { const el = $('#stopClock'); if (el && timerState) el.textContent = fmtClock(timerElapsed()); else clearInterval(iv); }, 1000);
};
window.doStopTimer = async function (e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const entry = await api('/api/timer/stop', { method: 'POST', body: { description: f.get('description'), category: f.get('category') } });
    timerState = null;
    renderTimerWidget();
    toast(`Logged ${fmtDur(entry.hours)} ⏱`);
    closeModal();
    if (location.hash.startsWith('#/time')) pageTime();
  } catch (err) { toast(err.message, true); }
  return false;
};

// ---------- boot ----------
// ================= SETTINGS =================
// Per-user portal preferences, stored as JSON on the user row (users.settings) so
// they follow the account, with a localStorage copy for instant apply on page load.
const SETTING_SIZES = [
  { px: 14, label: 'Small' }, { px: 16, label: 'Medium' }, { px: 17, label: 'Large' }, { px: 19, label: 'Extra large' },
];
const SETTING_ACCENTS = {
  indigo: '#5e6ad2', blue: '#4ea7fc', teal: '#26b5ce', green: '#4cb782',
  amber: '#f2c94c', orange: '#e8945a', pink: '#ec4899', purple: '#b48ef2', red: '#eb5757',
};
const ACCENT_BRIGHT = {
  indigo: '#7c89f2', blue: '#7cbfff', teal: '#4fd0e5', green: '#6fd3a3',
  amber: '#f7dc7e', orange: '#f2ae7b', pink: '#f472b6', purple: '#c9adf7', red: '#f28080',
};
function userSettings() {
  try { return JSON.parse(S.currentUser?.settings || localStorage.getItem('tp_settings') || '{}') || {}; }
  catch { return {}; }
}
function applyUserSettings(s = userSettings()) {
  const html = document.documentElement;
  html.style.fontSize = (s.font_size || 17) + 'px';
  html.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
  const accent = SETTING_ACCENTS[s.accent] ? s.accent : 'indigo';
  const hex = SETTING_ACCENTS[accent];
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  html.style.setProperty('--brand', hex);
  html.style.setProperty('--brand-bright', ACCENT_BRIGHT[accent]);
  html.style.setProperty('--brand-soft', `rgba(${r},${g},${b},.16)`);
}
window.updateSetting = async function (key, value) {
  const s = { ...userSettings(), [key]: value };
  const json = JSON.stringify(s);
  if (S.currentUser) S.currentUser.settings = json;
  localStorage.setItem('tp_settings', json);
  applyUserSettings(s);
  route(); // refresh the page so the active states update
  try { await api(`/api/users/${S.currentUser.id}`, { method: 'PATCH', body: { settings: json } }); }
  catch (e) { toast(e.message, true); }
};

async function pageSettings() {
  $('#topbarActions').innerHTML = '';
  const s = userSettings();
  const size = s.font_size || 17;
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const accent = SETTING_ACCENTS[s.accent] ? s.accent : 'indigo';
  $('#content').innerHTML = `
    <div class="card mb" style="max-width:720px">
      <div class="section-title">Appearance</div>
      <div class="field"><label class="f">UI size</label>
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          ${SETTING_SIZES.map((z) => `<button class="btn ${size === z.px ? 'primary' : ''}" onclick="updateSetting('font_size', ${z.px})">${z.label}</button>`).join('')}
        </div>
        <div class="small muted" style="margin-top:6px">Scales all text and controls across the whole portal.</div>
      </div>
      <div class="field" style="margin-top:16px"><label class="f">Theme</label>
        <div class="flex" style="gap:8px">
          <button class="btn ${theme === 'dark' ? 'primary' : ''}" onclick="updateSetting('theme', 'dark')">🌙 Dark</button>
          <button class="btn ${theme === 'light' ? 'primary' : ''}" onclick="updateSetting('theme', 'light')">☀️ Light</button>
        </div>
      </div>
      <div class="field" style="margin-top:16px"><label class="f">Accent color</label>
        <div class="flex" style="gap:9px;flex-wrap:wrap">
          ${Object.entries(SETTING_ACCENTS).map(([name, hex]) => `
            <button class="accent-swatch ${accent === name ? 'active' : ''}" style="background:${hex}" title="${cap(name)}" onclick="updateSetting('accent', '${name}')"></button>`).join('')}
        </div>
        <div class="small muted" style="margin-top:6px">Used for buttons, links, progress bars and highlights.</div>
      </div>
    </div>
    <div class="card mb" style="max-width:720px">
      <div class="section-title">🗓️ My Google Calendar</div>
      <div id="calSetting"><div class="small muted">Checking connection…</div></div>
    </div>
    <div class="card" style="max-width:720px">
      <div class="section-title">About these settings</div>
      <p class="small muted">Preferences are saved to your account (${esc(S.currentUser.email)}) and follow you on any browser you sign in from. Changes apply immediately.</p>
    </div>`;
  renderCalSetting();
}

// per-user calendar connect UI (secret iCal URL — stored server-side, shown only as connected/not)
async function renderCalSetting() {
  const el = $('#calSetting');
  if (!el) return;
  let connected = false;
  try { connected = (await api('/api/calendar/status')).connected; } catch {}
  el.innerHTML = connected
    ? `<p class="small muted mb">✅ Your calendar is connected. Meetings appear on <a href="#/time?tab=calendar">Time → Calendar</a>, where you can log them or turn them into tickets.</p>
       <button class="btn danger sm" onclick="calDisconnect()">Disconnect calendar</button>`
    : `<p class="small muted mb">Connect your personal Google Calendar to log meetings and create tickets from them. Your calendar is private to you — it is never shared with the workspace.</p>
       <form class="flex" style="gap:8px;flex-wrap:wrap" onsubmit="return calConnect(event)">
         <input name="ics_url" type="password" required placeholder="Secret iCal URL (https://calendar.google.com/calendar/ical/…/basic.ics)" style="flex:1;min-width:280px" autocomplete="off">
         <button class="btn primary">Connect</button>
       </form>
       <p class="small" style="color:var(--faint);margin-top:8px">Google Calendar → Settings → your calendar → "Integrate calendar" → copy the <b>Secret address in iCal format</b>. Read-only.</p>`;
}
window.calConnect = async function (e) {
  e.preventDefault();
  try {
    await api('/api/calendar/connect', { method: 'POST', body: { ics_url: e.target.ics_url.value.trim() } });
    toast('Calendar connected ✅');
    renderCalSetting();
  } catch (err) { toast(err.message, true); }
  return false;
};
window.calDisconnect = async function () {
  try { await api('/api/calendar/connect', { method: 'DELETE' }); toast('Calendar disconnected'); renderCalSetting(); }
  catch (err) { toast(err.message, true); }
};

// ================= QUICK SEARCH (Ctrl+K) =================
// Command palette over tickets / projects / people / pages. Tickets are fetched
// fresh on each open (cheap, local); everything else comes from the S caches.
let qsTickets = null, qsSel = 0, qsItems = [];
window.openQuickSearch = async function () {
  let el = $('#qsOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qsOverlay';
    el.innerHTML = `<div class="qs-box">
      <input id="qsInput" placeholder="Search tickets, projects, people, pages…" autocomplete="off" spellcheck="false">
      <div id="qsResults"></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('pointerdown', (e) => { if (e.target === el) closeQuickSearch(); });
    $('#qsInput').addEventListener('input', () => qsRender($('#qsInput').value));
    $('#qsInput').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); qsMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); qsMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (qsItems[qsSel]) qsItems[qsSel].go(); }
      else if (e.key === 'Escape') closeQuickSearch();
    });
  }
  el.hidden = false;
  const inp = $('#qsInput');
  inp.value = '';
  qsRender('');
  inp.focus();
  try { qsTickets = await api('/api/tickets'); } catch { qsTickets = []; }
  if (!el.hidden) qsRender(inp.value);
};
window.closeQuickSearch = () => { const el = $('#qsOverlay'); if (el) el.hidden = true; };
function qsMove(dir) {
  if (!qsItems.length) return;
  qsSel = (qsSel + dir + qsItems.length) % qsItems.length;
  document.querySelectorAll('.qs-row').forEach((r, i) => r.classList.toggle('active', i === qsSel));
  const act = document.querySelector('.qs-row.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}
function qsRender(q) {
  const ql = q.trim().toLowerCase();
  const hit = (s) => String(s || '').toLowerCase().includes(ql);
  const starts = (s) => String(s || '').toLowerCase().startsWith(ql) ? 0 : 1;
  const groups = [];
  const tickets = (qsTickets || [])
    .filter((t) => !ql || hit(t.key) || hit(t.title) || hit(t.labels))
    .sort((a, b) => starts(a.key) - starts(b.key) || starts(a.title) - starts(b.title))
    .slice(0, ql ? 8 : 4)
    .map((t) => ({ icon: '🎫', k: t.key, label: t.title, sub: t.status, go: () => { closeQuickSearch(); openTicket(t.id); } }));
  const projects = (S.projects || []).filter((p) => !ql || hit(p.name)).slice(0, 5)
    .map((p) => ({ icon: '📁', k: '', label: p.name, sub: p.status, go: () => { closeQuickSearch(); openProject(p.id); } }));
  const people = (S.users || []).filter((u) => !ql || hit(u.name) || hit(u.email)).slice(0, 5)
    .map((u) => ({ icon: '👤', k: '', label: u.name, sub: u.role, go: () => { closeQuickSearch(); location.hash = '#/user/' + u.id; } }));
  const pages = Object.entries(TITLES).filter(([, v]) => !ql || hit(v)).slice(0, ql ? 4 : 10)
    .map(([k, v]) => ({ icon: '📄', k: '', label: v, sub: 'page', go: () => { closeQuickSearch(); location.hash = '#/' + k; } }));
  if (tickets.length) groups.push(['Tickets', tickets]);
  if (projects.length) groups.push(['Projects', projects]);
  if (people.length) groups.push(['People', people]);
  if (pages.length) groups.push(['Pages', pages]);
  qsItems = groups.flatMap(([, list]) => list);
  qsSel = 0;
  let idx = -1;
  $('#qsResults').innerHTML = qsItems.length
    ? groups.map(([name, list]) => `<div class="qs-head">${name}</div>` + list.map((it) => {
        idx++;
        return `<div class="qs-row ${idx === qsSel ? 'active' : ''}" onclick="qsClick(${idx})">
          <span>${it.icon}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.label)}</span>
          <kbd class="qs-kbd">${esc(String(it.sub || '').replace(/_/g, ' '))}</kbd></div>`;
      }).join('')).join('')
    : (qsTickets === null ? '<div class="qs-empty">Loading…</div>' : '<div class="qs-empty">No matches for “' + esc(q) + '”</div>');
}
window.qsClick = (i) => { if (qsItems[i]) qsItems[i].go(); };
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickSearch(); }
});

window.closeModal = closeModal;
(async function boot() {
  applyUserSettings(); // apply cached preferences immediately, before anything renders
  if (location.hash.startsWith('#/join')) return renderJoin();
  try {
    S.currentUser = await api('/api/auth/me');
  } catch {
    return renderLogin();
  }
  try {
    localStorage.setItem('tp_settings', S.currentUser.settings || '{}');
    applyUserSettings(); // re-apply from the account (authoritative)
    await refreshBase();
    renderSidebarUser();
    refreshTimer();
    loadStars();
    route();
  } catch (e) {
    $('#content').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Could not load TimePort: ${esc(e.message)}</p></div>`;
  }
})();

