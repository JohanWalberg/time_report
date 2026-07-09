// TimePort — time reporting & project management platform
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');
const { exportExcel, exportPdf } = require('./lib/exports');
const { buildReport, REPORT_TYPES, missingTimeReports } = require('./lib/reports');
const { DEFAULT_STATUSES, IS_DONE, NOT_DONE, statusSlug } = require('./lib/status');
const { aiChat } = require('./lib/ai');

const app = express();
const PORT = process.env.PORT || 3020;

app.disable('x-powered-by');
app.set('trust proxy', 1); // so req.secure reflects X-Forwarded-Proto behind a TLS proxy
// Baseline security headers (kept CSP-free: the UI relies on inline handlers/styles)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// All user-entered text starts with a capital letter — normalized once, at the API
// boundary, so the app, reports, exports and AI all see consistent data.
const { capFirst, capLabels } = require('./lib/text');
app.use('/api', (req, res, next) => {
  if (req.body && typeof req.body === 'object' && !req.path.startsWith('/ai/')) {
    for (const f of ['name', 'title', 'description', 'body', 'label']) {
      if (typeof req.body[f] === 'string') req.body[f] = capFirst(req.body[f]);
    }
    for (const f of ['labels', 'skills']) {
      if (typeof req.body[f] === 'string') req.body[f] = capLabels(req.body[f]);
    }
  }
  next();
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // persistent-disk mount in prod
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Block script/executable/renderable-HTML extensions — everything else (docs, images,
// archives, PDFs) is fine and served as an attachment download anyway.
const BLOCKED_UPLOAD_EXT = /\.(html?|xhtml|svg|js|mjs|exe|bat|cmd|com|sh|ps1|msi|scr|vbs|jar)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (BLOCKED_UPLOAD_EXT.test(file.originalname)) cb(Object.assign(new Error('That file type is not allowed'), { status: 400 }));
    else cb(null, true);
  },
});

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) {
    console.error(e);
    // Intentional errors (bad(), 401/403) carry a status and a safe message.
    // Anything else is unexpected — don't leak internal/SQLite detail to the client.
    if (e.status) res.status(e.status).json({ error: e.message });
    else res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const { hashPassword, verifyPassword, newToken } = require('./lib/pw');

// ---------- Auth ----------
const SESSION_DAYS = 30;
const parseCookies = (req) => Object.fromEntries(
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((a) => a[0]));
const setSession = (req, res, userId) => {
  const token = newToken();
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(token, userId);
  // Secure only over HTTPS — omitting it on plain-HTTP localhost keeps dev logins working
  const secure = req.secure ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `tp_session=${token}; HttpOnly;${secure} Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax`);
};
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, team_id: u.team_id, color: u.color, capacity_hours: u.capacity_hours, skills: u.skills, settings: u.settings || '{}' };

// Simple in-memory login throttle: max 10 failed attempts per IP+email per 15 min
const loginAttempts = new Map();
const throttleKey = (req, email) => `${req.ip}|${String(email || '').toLowerCase()}`;
function checkLoginRate(req, email) {
  const rec = loginAttempts.get(throttleKey(req, email));
  if (rec && rec.count >= 10 && Date.now() - rec.first < 15 * 60 * 1000) {
    const e = new Error('Too many failed attempts. Wait 15 minutes and try again.'); e.status = 429; throw e;
  }
}
function noteLoginFail(req, email) {
  const k = throttleKey(req, email);
  const rec = loginAttempts.get(k);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) loginAttempts.set(k, { count: 1, first: Date.now() });
  else rec.count++;
}

// First-run setup: while the database has no users, the login page offers a
// "create admin account" form instead. Disabled forever after the first user exists.
const needsSetup = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
app.get('/api/auth/needs-setup', wrap((req, res) => res.json({ needs_setup: needsSetup() })));
app.post('/api/auth/setup', wrap((req, res) => {
  if (!needsSetup()) throw bad('Setup has already been completed — sign in instead');
  const { name, email, password } = req.body;
  if (!name || !name.trim()) throw bad('Your name is required');
  if (!email || !/^\S+@\S+\.\S+$/.test(String(email).trim())) throw bad('A valid email is required');
  if (!password || password.length < 8) throw bad('Password must be at least 8 characters');
  const id = db.prepare('INSERT INTO users (name, email, role, password_hash, color) VALUES (?,?,?,?,?)')
    .run(name.trim(), String(email).trim(), 'admin', hashPassword(password), '#5e6ad2').lastInsertRowid;
  setSession(req, res, id);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { email, password } = req.body;
  checkLoginRate(req, email);
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(String(email || '').trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    noteLoginFail(req, email);
    const e = new Error('Wrong email or password'); e.status = 401; throw e;
  }
  loginAttempts.delete(throttleKey(req, email));
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  setSession(req, res, user.id);
  res.json(publicUser(user));
}));
app.post('/api/auth/logout', wrap((req, res) => {
  const token = parseCookies(req).tp_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'tp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
}));
app.get('/api/auth/invite-info', wrap((req, res) => {
  const inv = db.prepare(`SELECT i.*, t.name AS team_name, u.name AS invited_by FROM invites i
    LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.created_by
    WHERE i.token = ? AND i.accepted_at IS NULL`).get(req.query.token || '');
  if (!inv) throw bad('This invite link is invalid or has already been used');
  res.json({ email: inv.email, role: inv.role, team_name: inv.team_name, invited_by: inv.invited_by });
}));
app.post('/api/auth/join', wrap((req, res) => {
  const { token, name, password } = req.body;
  const inv = db.prepare('SELECT * FROM invites WHERE token = ? AND accepted_at IS NULL').get(token || '');
  if (!inv) throw bad('This invite link is invalid or has already been used');
  if (!name || !name.trim()) throw bad('Your name is required');
  if (!password || password.length < 8) throw bad('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(inv.email)) throw bad('A user with this email already exists — sign in instead');
  const colors = ['#5e6ad2', '#4cb782', '#4ea7fc', '#e8945a', '#b48ef2', '#26b5ce', '#eb5757', '#f2c94c'];
  const id = db.prepare('INSERT INTO users (name, email, role, team_id, password_hash, color) VALUES (?,?,?,?,?,?)')
    .run(name.trim(), inv.email, inv.role, inv.team_id, hashPassword(password), colors[Math.floor(Math.random() * colors.length)]).lastInsertRowid;
  db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ?").run(inv.id);
  setSession(req, res, id);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

// Everything under /api (except /api/auth/*) requires a signed-in user
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  const token = parseCookies(req).tp_session;
  const sess = token && db.prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!sess) return res.status(401).json({ error: 'Not signed in' });
  req.user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(sess.user_id);
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
});
app.get('/api/auth/me', (req, res) => {
  // registered before but declared after the guard on purpose: guard skips /auth/*, so check here
  const token = parseCookies(req).tp_session;
  const sess = token && db.prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  const user = sess && db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(sess.user_id);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json(publicUser(user));
});
const requireRole = (req, ...roles) => {
  if (!roles.includes(req.user.role)) { const e = new Error('You need manager or admin permissions for this'); e.status = 403; throw e; }
};

// ---------- Invites (managers/admins) ----------
app.post('/api/invites', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { email, role = 'member', team_id = null } = req.body;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('A valid email is required');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) AND active = 1').get(email)) throw bad('This person already has an account');
  const token = newToken();
  const id = db.prepare('INSERT INTO invites (token, email, role, team_id, created_by) VALUES (?,?,?,?,?)')
    .run(token, email.trim(), role, team_id || null, req.user.id).lastInsertRowid;
  const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
  res.status(201).json({ ...inv, link: `/#/join?token=${token}` });
}));
app.get('/api/invites', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  res.json(db.prepare(`SELECT i.id, i.email, i.role, i.token, i.created_at, t.name AS team_name FROM invites i
    LEFT JOIN teams t ON t.id = i.team_id WHERE i.accepted_at IS NULL ORDER BY i.created_at DESC`).all()
    .map((i) => ({ ...i, link: `/#/join?token=${i.token}` })));
}));
app.delete('/api/invites/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  db.prepare('DELETE FROM invites WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Meta ----------
app.get('/api/meta', wrap((req, res) => {
  res.json({
    ticketStatuses: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'],
    projectStatuses: ['planning', 'active', 'on_hold', 'completed', 'cancelled'],
    milestoneStatuses: ['planned', 'in_progress', 'completed', 'at_risk'],
    priorities: ['low', 'medium', 'high', 'urgent'],
    timeCategories: ['development', 'design', 'meetings', 'planning', 'support', 'testing', 'documentation', 'other'],
    timeStatuses: ['draft', 'submitted', 'approved', 'rejected'],
    roles: ['admin', 'manager', 'member'],
    reportTypes: REPORT_TYPES,
  });
}));

// ---------- Teams ----------
app.get('/api/teams', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.active = 1) AS member_count
    FROM teams t ORDER BY t.name`).all());
}));
app.post('/api/teams', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { name, description = '', color = '#6366f1' } = req.body;
  if (!name) throw bad('Team name is required');
  const id = db.prepare('INSERT INTO teams (name, description, color) VALUES (?,?,?)').run(name, description, color).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM teams WHERE id = ?').get(id));
}));
app.patch('/api/teams/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  patchRow('teams', req.params.id, req.body, ['name', 'description', 'color']);
  res.json(db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id));
}));
app.delete('/api/teams/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Users ----------
app.get('/api/users', wrap((req, res) => {
  // publicUser mapping — never expose password_hash
  const rows = db.prepare(`
    SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id
    WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows.map((u) => ({ ...publicUser(u), team_name: u.team_name })));
}));
app.post('/api/users', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { name, email, role = 'member', team_id = null, skills = '', capacity_hours = 40, color = '#0ea5e9' } = req.body;
  if (!name || !email) throw bad('Name and email are required');
  const id = db.prepare('INSERT INTO users (name, email, role, team_id, skills, capacity_hours, color) VALUES (?,?,?,?,?,?,?)')
    .run(name, email, role, team_id, skills, capacity_hours, color).lastInsertRowid;
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));
app.patch('/api/users/:id', wrap((req, res) => {
  const isMgr = ['admin', 'manager'].includes(req.user.role);
  const isSelf = String(req.user.id) === String(req.params.id);
  // Members may edit ONLY their own personal preferences — never role/active/email/team.
  const allowed = isMgr ? ['name', 'email', 'role', 'team_id', 'skills', 'capacity_hours', 'color', 'active', 'settings']
    : isSelf ? ['settings', 'color'] : [];
  if (!allowed.length) throw Object.assign(new Error('You can only edit your own settings'), { status: 403 });
  patchRow('users', req.params.id, req.body, allowed);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
}));

// ---------- User profile: personal engagement & involvement breakdown ----------
// ?period=week|month|year (default month) + ?anchor=YYYY-MM-DD (default today) scope
// KPIs, effort chart, work mix, engagement and project hours to the calendar
// week/month/year containing the anchor date — so any past period can be browsed.
app.get('/api/users/:id/profile', wrap((req, res) => {
  const user = db.prepare('SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ? AND u.active = 1').get(req.params.id);
  if (!user) throw bad('User not found');
  const uid = user.id;

  const period = ['week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'month';
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || '') ? new Date(req.query.anchor + 'T12:00') : now;
  let start, end, prevStart; // period = [start, end), prev period = [prevStart, start)
  if (period === 'week') {
    const s = new Date(anchor); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); start = fmt(s);
    const e = new Date(s); e.setDate(e.getDate() + 7); end = fmt(e);
    const p = new Date(s); p.setDate(p.getDate() - 7); prevStart = fmt(p);
  } else if (period === 'month') {
    start = fmt(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    end = fmt(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    prevStart = fmt(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
  } else {
    start = `${anchor.getFullYear()}-01-01`;
    end = `${anchor.getFullYear() + 1}-01-01`;
    prevStart = `${anchor.getFullYear() - 1}-01-01`;
  }

  const hours_period = db.prepare('SELECT COALESCE(SUM(hours),0) h FROM time_entries WHERE user_id = ? AND date >= ? AND date < ?').get(uid, start, end).h;
  const hours_prev = db.prepare('SELECT COALESCE(SUM(hours),0) h FROM time_entries WHERE user_id = ? AND date >= ? AND date < ?').get(uid, prevStart, start).h;
  // workdays in the period (past periods: all of it; current: elapsed so far; future: none)
  let wd = 0; {
    const d = new Date(start + 'T12:00');
    const last = new Date(Math.min(new Date(end + 'T12:00') - 86400000, new Date(fmt(now) + 'T12:00')));
    while (d <= last) { if (d.getDay() !== 0 && d.getDay() !== 6) wd++; d.setDate(d.getDate() + 1); }
  }
  const capacity = (user.capacity_hours / 5) * wd;

  const kpis = {
    hours_period, hours_prev,
    open_tickets: db.prepare(`SELECT COUNT(*) h FROM tickets k WHERE k.assignee_id = ? AND ${NOT_DONE('k')}`).get(uid).h,
    done_period: db.prepare(`SELECT COUNT(*) h FROM tickets k WHERE k.assignee_id = ? AND ${IS_DONE('k')} AND k.updated_at >= ? AND k.updated_at < ?`).get(uid, start, end).h,
    utilization: capacity ? Math.round((hours_period / capacity) * 100) : null,
    avg_hours_day: wd ? Math.round((hours_period / wd) * 10) / 10 : 0,
  };

  // effort chart with adaptive buckets: days for week/month, months for year
  const entries = db.prepare('SELECT date, hours FROM time_entries WHERE user_id = ? AND date >= ? AND date < ?').all(uid, start, end);
  const effort = [];
  if (period === 'year') {
    const byMonth = new Map();
    for (const e of entries) { const k = e.date.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + e.hours); }
    for (let m = 0; m < 12; m++) {
      const k = `${anchor.getFullYear()}-${String(m + 1).padStart(2, '0')}`;
      effort.push({ label: k, hours: Math.round((byMonth.get(k) || 0) * 10) / 10 });
    }
  } else {
    const byDay = new Map();
    for (const e of entries) byDay.set(e.date, (byDay.get(e.date) || 0) + e.hours);
    const days = period === 'week' ? 7 : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    const d = new Date(start + 'T12:00');
    for (let i = 0; i < days; i++) {
      const k = fmt(d);
      effort.push({ label: k, hours: Math.round((byDay.get(k) || 0) * 10) / 10 });
      d.setDate(d.getDate() + 1);
    }
  }

  // projects the user is involved in: hours within the period, assigned/open = current state
  const projHours = db.prepare(`SELECT p.id, p.name, SUM(e.hours) AS hours FROM time_entries e JOIN projects p ON p.id = e.project_id
    WHERE e.user_id = ? AND e.date >= ? AND e.date < ? GROUP BY p.id`).all(uid, start, end);
  const projTickets = db.prepare(`SELECT p.id, p.name,
      COUNT(*) AS assigned, SUM(CASE WHEN ${IS_DONE('k')} THEN 0 ELSE 1 END) AS open
    FROM tickets k JOIN projects p ON p.id = k.project_id WHERE k.assignee_id = ? GROUP BY p.id`).all(uid);
  const projMap = new Map();
  for (const p of projHours) projMap.set(p.id, { id: p.id, name: p.name, hours: Math.round(p.hours * 10) / 10, assigned: 0, open: 0 });
  for (const p of projTickets) {
    if (!projMap.has(p.id)) projMap.set(p.id, { id: p.id, name: p.name, hours: 0, assigned: 0, open: 0 });
    Object.assign(projMap.get(p.id), { assigned: p.assigned, open: p.open });
  }
  const projects = [...projMap.values()].sort((a, b) => b.hours - a.hours);

  const byCategory = db.prepare(`SELECT category AS name, SUM(hours) AS hours FROM time_entries
    WHERE user_id = ? AND date >= ? AND date < ? GROUP BY category ORDER BY hours DESC`).all(uid, start, end);

  const activityCounts = {};
  for (const r of db.prepare('SELECT type, COUNT(*) n FROM activity WHERE user_id = ? AND created_at >= ? AND created_at < ? GROUP BY type').all(uid, start, end)) {
    activityCounts[r.type] = r.n;
  }
  activityCounts.comments = (activityCounts.comment || 0);
  // distinct tickets this user was involved in during the period (any action: comment, create, status, …)
  activityCounts.tickets_touched = db.prepare('SELECT COUNT(DISTINCT ticket_id) h FROM activity WHERE user_id = ? AND created_at >= ? AND created_at < ?').get(uid, start, end).h;

  const assigned = ticketQuery('WHERE k.assignee_id = ?', [uid]);
  const recentActivity = db.prepare(`SELECT a.type, a.detail, a.created_at, k.key AS ticket_key, k.title AS ticket_title
    FROM activity a JOIN tickets k ON k.id = a.ticket_id WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 12`).all(uid);

  // missing workdays, last 14 days
  const logged = new Set(db.prepare("SELECT DISTINCT date FROM time_entries WHERE user_id = ? AND date >= date('now','-14 days')").all(uid).map((r) => r.date));
  const missing_days = [];
  for (let i = 14; i >= 1; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ds = d.toISOString().slice(0, 10);
    if (!logged.has(ds)) missing_days.push(ds);
  }

  res.json({ user: publicUser(user), team_name: user.team_name, period, period_start: start, period_end: end, kpis, effort, projects, byCategory, activityCounts, assigned, recentActivity, missing_days });
}));

// ---------- Projects ----------
app.get('/api/projects', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT p.*, u.name AS owner_name, t.name AS team_name,
      (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id) AS ticket_count,
      (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id AND ${IS_DONE('k')}) AS done_count,
      (SELECT COALESCE(SUM(hours),0) FROM time_entries e WHERE e.project_id = p.id) AS logged_hours
    FROM projects p
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN teams t ON t.id = p.team_id
    ORDER BY (p.sort_order IS NULL), p.sort_order, CASE p.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, p.deadline, p.id`).all());
}));
app.get('/api/projects/:id', wrap((req, res) => {
  const project = db.prepare(`
    SELECT p.*, u.name AS owner_name, t.name AS team_name FROM projects p
    LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN teams t ON t.id = p.team_id
    WHERE p.id = ?`).get(req.params.id);
  if (!project) throw bad('Project not found');
  project.milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order, due_date').all(project.id);
  project.tickets = ticketQuery('WHERE k.project_id = ?', [project.id]);
  res.json(project);
}));
// Batch: milestones + tickets for several projects in one round-trip (roadmap avoids N+1)
app.get('/api/projects-detail', wrap((req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 200);
  res.json(ids.map((id) => ({
    id,
    milestones: db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order, due_date').all(id),
    tickets: ticketQuery('WHERE k.project_id = ?', [id]),
  })));
}));
app.post('/api/projects', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { name, description = '', owner_id = null, team_id = null, start_date = null, deadline = null, status = 'planning', priority = 'medium' } = req.body;
  if (!name) throw bad('Project name is required');
  const id = db.prepare(`INSERT INTO projects (name, description, owner_id, team_id, start_date, deadline, status, priority, sort_order)
    VALUES (?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM projects))`)
    .run(name, description, owner_id, team_id, start_date, deadline, status, priority).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}));
app.patch('/api/projects/:id', wrap((req, res) => {
  patchRow('projects', req.params.id, req.body, ['name', 'description', 'owner_id', 'team_id', 'start_date', 'deadline', 'status', 'priority', 'sort_order']);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
}));
app.delete('/api/projects/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Milestones ----------
app.post('/api/milestones', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { project_id, name, description = '', due_date = null, status = 'planned', sort_order = 0 } = req.body;
  if (!project_id || !name) throw bad('project_id and name are required');
  const id = db.prepare('INSERT INTO milestones (project_id, name, description, due_date, status, sort_order) VALUES (?,?,?,?,?,?)')
    .run(project_id, name, description, due_date, status, sort_order).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id));
}));
app.patch('/api/milestones/:id', wrap((req, res) => {
  // open to any member: roadmap drag shifts milestone dates, and status can be cycled inline
  patchRow('milestones', req.params.id, req.body, ['name', 'description', 'due_date', 'status', 'sort_order']);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id));
}));
app.delete('/api/milestones/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Tickets ----------
function ticketQuery(where = '', params = []) {
  return db.prepare(`
    SELECT k.*, u.name AS assignee_name, u.color AS assignee_color, p.name AS project_name,
      t.name AS team_name, m.name AS milestone_name, c.name AS creator_name,
      ${IS_DONE('k')} AS is_done,
      (SELECT COALESCE(SUM(hours),0) FROM time_entries e WHERE e.ticket_id = k.id) AS logged_hours,
      (SELECT COUNT(*) FROM comments cm WHERE cm.ticket_id = k.id) AS comment_count
    FROM tickets k
    LEFT JOIN users u ON u.id = k.assignee_id
    LEFT JOIN users c ON c.id = k.created_by
    LEFT JOIN projects p ON p.id = k.project_id
    LEFT JOIN teams t ON t.id = k.team_id
    LEFT JOIN milestones m ON m.id = k.milestone_id
    ${where}
    ORDER BY CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, k.deadline`).all(...params);
}
app.get('/api/tickets', wrap((req, res) => {
  const clauses = [], params = [];
  const { project_id, assignee_id, team_id, status, priority, q, overdue } = req.query;
  if (project_id) { clauses.push('k.project_id = ?'); params.push(project_id); }
  if (assignee_id) { clauses.push('k.assignee_id = ?'); params.push(assignee_id); }
  if (team_id) { clauses.push('k.team_id = ?'); params.push(team_id); }
  if (status) { clauses.push('k.status = ?'); params.push(status); }
  if (priority) { clauses.push('k.priority = ?'); params.push(priority); }
  if (q) { clauses.push('(k.title LIKE ? OR k.key LIKE ? OR k.labels LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (overdue === '1') { clauses.push(`k.deadline < date('now') AND NOT ${IS_DONE('k')}`); }
  res.json(ticketQuery(clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params));
}));
app.get('/api/tickets/:id', wrap((req, res) => {
  const ticket = ticketQuery('WHERE k.id = ?', [req.params.id])[0];
  if (!ticket) throw bad('Ticket not found');
  ticket.comments = db.prepare(`
    SELECT cm.*, u.name AS user_name, u.color AS user_color FROM comments cm
    LEFT JOIN users u ON u.id = cm.user_id WHERE cm.ticket_id = ? ORDER BY cm.created_at`).all(ticket.id);
  ticket.activity = db.prepare(`
    SELECT a.*, u.name AS user_name FROM activity a
    LEFT JOIN users u ON u.id = a.user_id WHERE a.ticket_id = ? ORDER BY a.created_at DESC`).all(ticket.id);
  ticket.attachments = db.prepare('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at DESC').all(ticket.id);
  ticket.time_entries = db.prepare(`
    SELECT e.*, u.name AS user_name FROM time_entries e
    LEFT JOIN users u ON u.id = e.user_id WHERE e.ticket_id = ? ORDER BY e.date DESC`).all(ticket.id);
  res.json(ticket);
}));
app.post('/api/tickets', wrap((req, res) => {
  const b = req.body;
  if (!b.title) throw bad('Ticket title is required');
  const last = db.prepare("SELECT key FROM tickets ORDER BY id DESC LIMIT 1").get();
  const nextNum = last ? parseInt(last.key.split('-')[1], 10) + 1 : 101;
  const id = db.prepare(`INSERT INTO tickets (key, title, description, project_id, milestone_id, assignee_id, team_id, status, priority, estimate_hours, deadline, labels, link, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `TP-${nextNum}`, b.title, b.description || '', b.project_id || null, b.milestone_id || null,
    b.assignee_id || null, b.team_id || null, b.status || 'backlog', b.priority || 'medium',
    b.estimate_hours || 0, b.deadline || null, b.labels || '', b.link || '', req.user.id).lastInsertRowid;
  logActivity(id, req.user.id, 'created', 'Ticket created');
  res.status(201).json(ticketQuery('WHERE k.id = ?', [id])[0]);
}));
app.patch('/api/tickets/:id', wrap((req, res) => {
  const before = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!before) throw bad('Ticket not found');
  const fields = ['title', 'description', 'project_id', 'milestone_id', 'assignee_id', 'team_id', 'status', 'priority', 'estimate_hours', 'start_date', 'deadline', 'labels', 'link', 'board_order'];
  patchRow('tickets', req.params.id, req.body, fields);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  const actor = req.user.id;
  const nameOf = (uid) => uid ? (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) || {}).name || '?' : 'Unassigned';
  if (req.body.status !== undefined && req.body.status !== before.status) logActivity(before.id, actor, 'status', `${before.status} → ${req.body.status}`);
  if (req.body.priority !== undefined && req.body.priority !== before.priority) logActivity(before.id, actor, 'priority', `${before.priority} → ${req.body.priority}`);
  if (req.body.assignee_id !== undefined && String(req.body.assignee_id) !== String(before.assignee_id)) logActivity(before.id, actor, 'assignee', `${nameOf(before.assignee_id)} → ${nameOf(req.body.assignee_id)}`);
  if (req.body.deadline !== undefined && req.body.deadline !== before.deadline) logActivity(before.id, actor, 'deadline', `${before.deadline || 'none'} → ${req.body.deadline || 'none'}`);
  if (req.body.project_id !== undefined && String(req.body.project_id || '') !== String(before.project_id || '')) {
    const projName = (pid) => pid ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(pid) || {}).name || '?' : 'No project';
    logActivity(before.id, actor, 'project', `${projName(before.project_id)} → ${projName(req.body.project_id)}`);
  }
  res.json(ticketQuery('WHERE k.id = ?', [req.params.id])[0]);
}));
app.delete('/api/tickets/:id', wrap((req, res) => {
  // deletion is destructive (cascades comments/activity/attachments) — managers, or the ticket's creator
  const t = db.prepare('SELECT created_by FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) throw bad('Ticket not found');
  if (!['admin', 'manager'].includes(req.user.role) && t.created_by !== req.user.id) {
    throw Object.assign(new Error('Only a manager or the ticket creator can delete this ticket'), { status: 403 });
  }
  db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// Comments & attachments
app.post('/api/tickets/:id/comments', wrap((req, res) => {
  const { body } = req.body;
  if (!body) throw bad('Comment body is required');
  const id = db.prepare('INSERT INTO comments (ticket_id, user_id, body) VALUES (?,?,?)').run(req.params.id, req.user.id, body).lastInsertRowid;
  logActivity(req.params.id, req.user.id, 'comment', 'Comment added');
  res.status(201).json(db.prepare(`SELECT cm.*, u.name AS user_name, u.color AS user_color FROM comments cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.id = ?`).get(id));
}));
app.post('/api/tickets/:id/attachments', upload.single('file'), wrap((req, res) => {
  if (!req.file) throw bad('No file uploaded');
  const id = db.prepare('INSERT INTO attachments (ticket_id, filename, stored_name, size, uploaded_by) VALUES (?,?,?,?,?)')
    .run(req.params.id, req.file.originalname, req.file.filename, req.file.size, req.user.id).lastInsertRowid;
  logActivity(req.params.id, req.user.id, 'attachment', `Attached ${req.file.originalname}`);
  res.status(201).json(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}));
app.get('/api/attachments/:id/download', wrap((req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) throw bad('Attachment not found');
  res.download(path.join(UPLOAD_DIR, a.stored_name), a.filename);
}));

// ---------- Workflow statuses (built-in + per-project custom) ----------
app.get('/api/statuses', wrap((req, res) => {
  let customs = [];
  if ('project_id' in req.query) {
    // one project's workflow (empty project_id → defaults only, e.g. tickets without a project)
    if (req.query.project_id) {
      customs = db.prepare('SELECT id, project_id, key, label, category, sort_order FROM project_statuses WHERE project_id = ? ORDER BY sort_order').all(req.query.project_id);
    }
  } else {
    // global board: defaults + custom statuses that currently hold tickets
    customs = db.prepare(`SELECT ps.* FROM project_statuses ps
      WHERE EXISTS (SELECT 1 FROM tickets k WHERE k.project_id = ps.project_id AND k.status = ps.key)
      ORDER BY ps.sort_order`).all();
  }
  const merged = DEFAULT_STATUSES.map((s) => ({ ...s, custom: false }));
  for (const c of customs) if (!merged.some((m) => m.key === c.key)) merged.push({ ...c, custom: true });
  merged.sort((a, b) => a.sort_order - b.sort_order);
  res.json(merged);
}));
app.post('/api/projects/:id/statuses', wrap((req, res) => {
  requireRole(req, 'admin', 'manager'); // adding a column changes the board for everyone
  const { label, category = 'open', after } = req.body;
  if (!label || !label.trim()) throw bad('Status name is required');
  if (!['open', 'done'].includes(category)) throw bad("category must be 'open' or 'done'");
  const key = statusSlug(label);
  if (!key) throw bad('Status name must contain letters or numbers');
  if (DEFAULT_STATUSES.some((s) => s.key === key)) throw bad(`"${label.trim()}" already exists as a built-in status`);
  if (db.prepare('SELECT 1 FROM project_statuses WHERE project_id = ? AND key = ?').get(req.params.id, key)) throw bad('This project already has that status');
  let sort;
  if (after) {
    // insert right after the named status in this project's workflow (sort_order midpoint)
    const merged = [...DEFAULT_STATUSES.map((s) => ({ key: s.key, sort_order: s.sort_order })),
      ...db.prepare('SELECT key, sort_order FROM project_statuses WHERE project_id = ?').all(req.params.id)]
      .sort((a, b) => a.sort_order - b.sort_order);
    const i = merged.findIndex((s) => s.key === after);
    if (i === -1) throw bad(`Unknown status "${after}" to insert after`);
    sort = i + 1 < merged.length ? (merged[i].sort_order + merged[i + 1].sort_order) / 2 : merged[i].sort_order + 10;
  } else {
    const n = db.prepare('SELECT COUNT(*) n FROM project_statuses WHERE project_id = ? AND category = ?').get(req.params.id, category).n;
    sort = (category === 'done' ? 61 : 41) + n * 0.1; // legacy default: open customs between In Review and Done
  }
  const id = db.prepare('INSERT INTO project_statuses (project_id, key, label, category, sort_order) VALUES (?,?,?,?,?)')
    .run(req.params.id, key, label.trim(), category, sort).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM project_statuses WHERE id = ?').get(id));
}));
app.patch('/api/project-statuses/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager'); // reordering columns is a workflow change for everyone
  patchRow('project_statuses', req.params.id, req.body, ['label', 'category', 'sort_order']);
  res.json(db.prepare('SELECT * FROM project_statuses WHERE id = ?').get(req.params.id));
}));
app.delete('/api/project-statuses/:id', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const s = db.prepare('SELECT * FROM project_statuses WHERE id = ?').get(req.params.id);
  if (!s) throw bad('Status not found');
  const inUse = db.prepare('SELECT COUNT(*) n FROM tickets WHERE project_id = ? AND status = ?').get(s.project_id, s.key).n;
  if (inUse) throw bad(`${inUse} ticket(s) still use "${s.label}" — move them to another status first`);
  db.prepare('DELETE FROM project_statuses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Integrations (workspace-level connections; templates for now) ----------
const INTEGRATION_PROVIDERS = ['openai', 'anthropic', 'linear', 'jira', 'gmail']; // calendar is per-user (in Settings), not a shared workspace integration
const SECRET_FIELDS = ['api_key', 'api_token'];
const maskConfig = (config) => {
  const c = { ...config };
  for (const f of SECRET_FIELDS) {
    if (c[f]) c[f] = '••••••••' + String(c[f]).slice(-4);
  }
  return c;
};
app.get('/api/integrations', wrap((req, res) => {
  requireRole(req, 'admin', 'manager'); // config includes (masked) secrets — managers only
  const rows = db.prepare(`SELECT i.*, u.name AS connected_by_name FROM integrations i
    LEFT JOIN users u ON u.id = i.connected_by`).all();
  res.json(rows.map((r) => ({
    provider: r.provider, enabled: !!r.enabled, connected_by: r.connected_by_name,
    updated_at: r.updated_at, config: maskConfig(JSON.parse(r.config || '{}')),
  })));
}));
app.post('/api/integrations/:provider', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const provider = req.params.provider;
  if (!INTEGRATION_PROVIDERS.includes(provider)) throw bad(`Unknown integration '${provider}'`);
  const existing = db.prepare('SELECT * FROM integrations WHERE provider = ?').get(provider);
  const oldConfig = existing ? JSON.parse(existing.config || '{}') : {};
  const incoming = req.body.config || {};
  // blank secret fields mean "keep the stored one"
  const merged = { ...oldConfig };
  for (const [k, v] of Object.entries(incoming)) {
    if (SECRET_FIELDS.includes(k) && (v === '' || v == null)) continue;
    merged[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (existing) {
    db.prepare("UPDATE integrations SET config = ?, enabled = 1, connected_by = ?, updated_at = datetime('now') WHERE provider = ?")
      .run(JSON.stringify(merged), req.user.id, provider);
  } else {
    db.prepare('INSERT INTO integrations (provider, config, connected_by) VALUES (?,?,?)')
      .run(provider, JSON.stringify(merged), req.user.id);
  }
  res.status(201).json({ provider, config: maskConfig(merged) });
}));
app.delete('/api/integrations/:provider', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  db.prepare('DELETE FROM integrations WHERE provider = ?').run(req.params.provider);
  res.json({ ok: true });
}));

// ---------- Google Calendar (per-user secret iCal .ics feed) ----------
// Each user connects their OWN calendar; the URL lives in users.calendar_ics_url and is
// never returned to the client (only a connected yes/no). Read-only; async handlers.
const { parseIcs } = require('./lib/ical');
const isIcsUrl = (u) => /^https:\/\/\S+/i.test(u) && (/\.ics(\?|$)/i.test(u) || /calendar\.google\.com/i.test(u));

app.get('/api/calendar/status', wrap((req, res) => {
  res.json({ connected: !!req.user.calendar_ics_url });
}));
app.post('/api/calendar/connect', wrap((req, res) => {
  const url = String(req.body.ics_url || '').trim();
  if (!isIcsUrl(url)) throw bad('That is not a valid secret iCal (.ics) URL. Copy it from Google Calendar → Settings → your calendar → "Secret address in iCal format".');
  db.prepare('UPDATE users SET calendar_ics_url = ? WHERE id = ?').run(url, req.user.id);
  res.json({ connected: true });
}));
app.delete('/api/calendar/connect', wrap((req, res) => {
  db.prepare('UPDATE users SET calendar_ics_url = NULL WHERE id = ?').run(req.user.id);
  res.json({ connected: false });
}));

app.get('/api/calendar/events', async (req, res) => {
  try {
    const url = (req.user.calendar_ics_url || '').trim();
    if (!url) return res.json({ configured: false, events: [] });
    let text;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return res.status(502).json({ error: `Calendar feed returned ${r.status}. Re-check the secret iCal URL.` });
      text = await r.text();
    } catch { return res.status(502).json({ error: 'Could not reach the calendar feed. Check the URL and try again.' }); }

    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to = req.query.to || from;
    const lo = new Date(from + 'T00:00:00').getTime();
    const hi = new Date(to + 'T23:59:59').getTime();
    const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

    let skippedRecurring = 0;
    const events = [];
    for (const e of parseIcs(text)) {
      if (e.recurring) { skippedRecurring++; continue; } // TODO: expand RRULE occurrences
      if (e.start.allDay) continue; // all-day items aren't billable meetings
      if (e.start.ms < lo || e.start.ms > hi) continue;
      const endMs = e.end ? e.end.ms : e.start.ms;
      const hours = Math.max(Math.round(((endMs - e.start.ms) / 3600000) * 4) / 4, 0);
      // Google often stuffs a long HTML block / video link into DESCRIPTION — cap it
      const desc = (e.description || '').replace(/\s+$/, '').slice(0, 600);
      // best link to the meeting: the event URL, else a Meet link, else a URL in the location
      const loc = (e.location || '').slice(0, 200);
      const link = e.url || e.conference || (/^https?:\/\/\S+$/i.test(loc.trim()) ? loc.trim() : '');
      events.push({ uid: e.uid || `${e.start.ms}`, title: e.summary || '(no title)', description: desc, location: loc, link, date: localDate(e.start.ms), start: hhmm(e.start.ms), end: hhmm(endMs), hours });
    }
    events.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    res.json({ configured: true, events, skipped_recurring: skippedRecurring });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong reading the calendar.' });
  }
});

// ---------- Starred tickets (per user, shown in the sidebar) ----------
app.get('/api/stars', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT s.ticket_id, k.key, k.title, k.status, k.priority, ${IS_DONE('k')} AS is_done
    FROM starred_tickets s JOIN tickets k ON k.id = s.ticket_id
    WHERE s.user_id = ? ORDER BY s.created_at`).all(req.user.id));
}));
app.post('/api/stars/:ticketId', wrap((req, res) => {
  if (!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(req.params.ticketId)) throw bad('Ticket not found');
  db.prepare('INSERT OR IGNORE INTO starred_tickets (user_id, ticket_id) VALUES (?, ?)').run(req.user.id, req.params.ticketId);
  res.status(201).json({ ok: true });
}));
app.delete('/api/stars/:ticketId', wrap((req, res) => {
  db.prepare('DELETE FROM starred_tickets WHERE user_id = ? AND ticket_id = ?').run(req.user.id, req.params.ticketId);
  res.json({ ok: true });
}));

// ---------- Labels (distinct, with usage counts — feeds the label picker) ----------
app.get('/api/labels', wrap((req, res) => {
  const rows = db.prepare("SELECT labels FROM tickets WHERE labels != ''").all();
  const counts = new Map();
  for (const r of rows) {
    for (const l of r.labels.split(',').map((s) => s.trim()).filter(Boolean)) {
      const k = l.toLowerCase();
      if (!counts.has(k)) counts.set(k, { label: l, count: 0 });
      counts.get(k).count++;
    }
  }
  res.json([...counts.values()].sort((a, b) => b.count - a.count));
}));

// ---------- Import (Linear CSV) ----------
const { importLinear } = require('./lib/importer');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/import/linear', importUpload.single('file'), wrap((req, res) => {
  if (!req.file) throw bad('No file uploaded — pick your Linear CSV export first');
  const text = req.file.buffer.toString('utf8');
  let overrides = null; // per-row selections from the interactive preview
  if (req.body.overrides) {
    try { overrides = JSON.parse(req.body.overrides); } catch { throw bad('Invalid import selection data'); }
  }
  const result = importLinear(text, {
    dryRun: req.body.dry_run === '1',
    skipCanceled: req.body.skip_canceled !== '0',
    createProjects: req.body.create_projects !== '0',
    overrides,
  }, req.user.id);
  res.json(result);
}));

// ---------- Time entries ----------
app.get('/api/time-entries', wrap((req, res) => {
  const clauses = [], params = [];
  const { user_id, project_id, ticket_id, team_id, from, to, status } = req.query;
  if (user_id) { clauses.push('e.user_id = ?'); params.push(user_id); }
  if (project_id) { clauses.push('e.project_id = ?'); params.push(project_id); }
  if (ticket_id) { clauses.push('e.ticket_id = ?'); params.push(ticket_id); }
  if (team_id) { clauses.push('u.team_id = ?'); params.push(team_id); }
  if (from) { clauses.push('e.date >= ?'); params.push(from); }
  if (to) { clauses.push('e.date <= ?'); params.push(to); }
  if (status) { clauses.push('e.status = ?'); params.push(status); }
  res.json(db.prepare(`
    SELECT e.*, u.name AS user_name, u.color AS user_color, k.key AS ticket_key, k.title AS ticket_title, p.name AS project_name
    FROM time_entries e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN tickets k ON k.id = e.ticket_id
    LEFT JOIN projects p ON p.id = e.project_id
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY e.date DESC, e.id DESC LIMIT 500`).all(...params));
}));
app.post('/api/time-entries', wrap((req, res) => {
  const { ticket_id = null, project_id = null, category = 'development', date, hours, description = '' } = req.body;
  if (!date || !hours) throw bad('date and hours are required');
  if (hours <= 0 || hours > 24) throw bad('Hours must be between 0 and 24');
  // If a ticket is given but no project, inherit the ticket's project
  let proj = project_id;
  if (ticket_id && !proj) proj = (db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticket_id) || {}).project_id || null;
  const id = db.prepare("INSERT INTO time_entries (user_id, ticket_id, project_id, category, date, hours, description, status) VALUES (?,?,?,?,?,?,?,'submitted')")
    .run(req.user.id, ticket_id, proj, category, date, hours, description).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id));
}));
app.patch('/api/time-entries/:id', wrap((req, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (!entry) throw bad('Entry not found');
  if (entry.user_id !== req.user.id && !['admin', 'manager'].includes(req.user.role)) throw bad('You can only edit your own time');
  if (entry.status === 'approved' && !['admin', 'manager'].includes(req.user.role)) throw bad('This entry is approved and locked — ask a manager to unlock it');
  const body = { ...req.body };
  if (entry.status === 'rejected' && body.status === undefined) body.status = 'submitted'; // editing a rejected entry resubmits it
  patchRow('time_entries', req.params.id, body, ['ticket_id', 'project_id', 'category', 'date', 'hours', 'description', 'status']);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id));
}));
app.delete('/api/time-entries/:id', wrap((req, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (!entry) throw bad('Entry not found');
  if (entry.user_id !== req.user.id && !['admin', 'manager'].includes(req.user.role)) throw bad('You can only delete your own time');
  if (entry.status === 'approved' && !['admin', 'manager'].includes(req.user.role)) throw bad('This entry is approved and locked');
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Timer (one running timer per user) ----------
const timerInfo = (userId) => {
  const t = db.prepare(`SELECT tm.*, k.key, k.title FROM timers tm LEFT JOIN tickets k ON k.id = tm.ticket_id WHERE tm.user_id = ?`).get(userId);
  if (!t) return null;
  return { ...t, started_utc: t.started_at.replace(' ', 'T') + 'Z' };
};
const stopTimerAndLog = (userId, description, category) => {
  const t = timerInfo(userId);
  if (!t) return null;
  const minutes = Math.max(Math.round((Date.now() - new Date(t.started_utc).getTime()) / 60000), 1);
  const hours = Math.round((minutes / 60) * 100) / 100;
  const proj = t.ticket_id ? (db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(t.ticket_id) || {}).project_id : null;
  const id = db.prepare("INSERT INTO time_entries (user_id, ticket_id, project_id, category, date, hours, description, status) VALUES (?,?,?,?,date('now'),?,?,'submitted')")
    .run(userId, t.ticket_id, proj, category || 'development', hours, description || `Timer on ${t.key || 'work'}`).lastInsertRowid;
  db.prepare('DELETE FROM timers WHERE user_id = ?').run(userId);
  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
};
app.get('/api/timer', wrap((req, res) => res.json(timerInfo(req.user.id))));
app.post('/api/timer/start', wrap((req, res) => {
  const { ticket_id } = req.body;
  if (!ticket_id) throw bad('ticket_id is required');
  const stopped = stopTimerAndLog(req.user.id, null, null); // auto-log any running timer first
  db.prepare('INSERT INTO timers (user_id, ticket_id) VALUES (?,?)').run(req.user.id, ticket_id);
  res.status(201).json({ stopped, timer: timerInfo(req.user.id) });
}));
app.post('/api/timer/stop', wrap((req, res) => {
  const entry = stopTimerAndLog(req.user.id, req.body.description, req.body.category);
  if (!entry) throw bad('No timer is running');
  res.json(entry);
}));

// ---------- Timesheet week grid: set the total for one (ticket, day) cell ----------
app.post('/api/timesheet/set', wrap((req, res) => {
  const { ticket_id = null, date, hours } = req.body;
  const target = Math.max(parseFloat(hours) || 0, 0);
  if (!date) throw bad('date is required');
  if (target > 24) throw bad('Max 24 hours per day and ticket');
  const where = ticket_id ? 'ticket_id = ?' : 'ticket_id IS NULL';
  const params = ticket_id ? [req.user.id, date, ticket_id] : [req.user.id, date];
  const entries = db.prepare(`SELECT * FROM time_entries WHERE user_id = ? AND date = ? AND ${where} ORDER BY id DESC`).all(...params);
  const approved = entries.filter((e) => e.status === 'approved').reduce((s, e) => s + e.hours, 0);
  if (target < approved - 0.001) throw bad(`${approved}h on this day are approved and locked — the total can't go below that`);
  const editable = entries.filter((e) => e.status !== 'approved');
  let delta = Math.round((target - approved - editable.reduce((s, e) => s + e.hours, 0)) * 100) / 100;
  const tx = db.transaction(() => {
    if (delta > 0) {
      const proj = ticket_id ? (db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticket_id) || {}).project_id : null;
      db.prepare(`INSERT INTO time_entries (user_id, ticket_id, project_id, category, date, hours, description, status)
        VALUES (?,?,?,?,?,?,'Timesheet','submitted')`).run(req.user.id, ticket_id, proj, ticket_id ? 'development' : 'other', date, delta);
    } else if (delta < 0) {
      let toRemove = -delta;
      for (const e of editable) {
        if (toRemove <= 0.001) break;
        if (e.hours <= toRemove + 0.001) { db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id); toRemove -= e.hours; }
        else { db.prepare('UPDATE time_entries SET hours = ? WHERE id = ?').run(Math.round((e.hours - toRemove) * 100) / 100, e.id); toRemove = 0; }
      }
    }
  });
  tx();
  res.json({ ok: true });
}));

// Copy every entry from the previous week into this week (same weekdays)
app.post('/api/timesheet/copy-last-week', wrap((req, res) => {
  const { week_start } = req.body; // Monday, YYYY-MM-DD
  if (!week_start) throw bad('week_start is required');
  const prev = db.prepare(`SELECT * FROM time_entries WHERE user_id = ? AND date >= date(?, '-7 days') AND date < ?`).all(req.user.id, week_start, week_start);
  let copied = 0;
  const tx = db.transaction(() => {
    for (const e of prev) {
      const target = new Date(e.date + 'T12:00'); target.setDate(target.getDate() + 7);
      const td = target.toISOString().slice(0, 10);
      const dupe = db.prepare(`SELECT 1 FROM time_entries WHERE user_id = ? AND date = ? AND hours = ? AND category = ?
        AND COALESCE(ticket_id,0) = COALESCE(?,0) AND description = ?`).get(req.user.id, td, e.hours, e.category, e.ticket_id, e.description || '');
      if (dupe) continue;
      db.prepare(`INSERT INTO time_entries (user_id, ticket_id, project_id, category, date, hours, description, status)
        VALUES (?,?,?,?,?,?,?,'submitted')`).run(req.user.id, e.ticket_id, e.project_id, e.category, td, e.hours, e.description || '');
      copied++;
    }
  });
  tx();
  res.json({ copied, source_entries: prev.length });
}));

// ---------- Smart suggestions: work you touched but didn't log ----------
app.get('/api/time-suggestions', wrap((req, res) => {
  // last workday before today
  const d = new Date(); d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const day = d.toISOString().slice(0, 10);
  const loggedTickets = new Set(db.prepare('SELECT DISTINCT ticket_id FROM time_entries WHERE user_id = ? AND date = ? AND ticket_id IS NOT NULL')
    .all(req.user.id, day).map((r) => r.ticket_id));
  const total = db.prepare('SELECT COALESCE(SUM(hours),0) h FROM time_entries WHERE user_id = ? AND date = ?').get(req.user.id, day).h;
  const touched = db.prepare(`SELECT DISTINCT k.id, k.key, k.title, a.type FROM activity a JOIN tickets k ON k.id = a.ticket_id
    WHERE a.user_id = ? AND date(a.created_at) = ?`).all(req.user.id, day);
  const suggestions = [];
  const seen = new Set();
  for (const t of touched) {
    if (loggedTickets.has(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    suggestions.push({ ticket_id: t.id, key: t.key, title: t.title, reason: `You worked on this (${t.type}) on ${day} but logged no time on it` });
  }
  res.json({ date: day, total_logged: total, suggestions });
}));

// ---------- Approvals (managers/admins) ----------
app.get('/api/approvals', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { from, to } = req.query;
  if (!from || !to) throw bad('from and to are required');
  res.json(db.prepare(`
    SELECT u.id AS user_id, u.name, u.color, u.capacity_hours,
      COALESCE(SUM(CASE WHEN e.status = 'submitted' THEN e.hours END), 0) AS submitted_hours,
      COALESCE(SUM(CASE WHEN e.status = 'approved' THEN e.hours END), 0) AS approved_hours,
      COALESCE(SUM(CASE WHEN e.status = 'rejected' THEN e.hours END), 0) AS rejected_hours,
      COALESCE(SUM(e.hours), 0) AS total_hours, COUNT(e.id) AS entry_count
    FROM users u LEFT JOIN time_entries e ON e.user_id = u.id AND e.date BETWEEN ? AND ?
    WHERE u.active = 1 GROUP BY u.id ORDER BY u.name`).all(from, to));
}));
app.post('/api/approvals', wrap((req, res) => {
  requireRole(req, 'admin', 'manager');
  const { user_id, from, to, action } = req.body;
  if (!user_id || !from || !to || !['approve', 'reject', 'reopen'].includes(action)) throw bad('user_id, from, to and a valid action are required');
  let result;
  if (action === 'approve') result = db.prepare("UPDATE time_entries SET status = 'approved' WHERE user_id = ? AND date BETWEEN ? AND ? AND status IN ('submitted','rejected','draft')").run(user_id, from, to);
  else if (action === 'reject') result = db.prepare("UPDATE time_entries SET status = 'rejected' WHERE user_id = ? AND date BETWEEN ? AND ? AND status IN ('submitted','draft')").run(user_id, from, to);
  else result = db.prepare("UPDATE time_entries SET status = 'submitted' WHERE user_id = ? AND date BETWEEN ? AND ? AND status IN ('approved','rejected')").run(user_id, from, to);
  res.json({ changed: result.changes });
}));

// ---------- Time analytics (management view: aggregates + task comparison) ----------
app.get('/api/time-analytics', wrap((req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  const clauses = ['e.date BETWEEN ? AND ?'], params = [from, to];
  if (req.query.team_id) { clauses.push('u.team_id = ?'); params.push(req.query.team_id); }
  if (req.query.user_id) { clauses.push('e.user_id = ?'); params.push(req.query.user_id); }
  if (req.query.project_id) { clauses.push('e.project_id = ?'); params.push(req.query.project_id); }
  const where = clauses.join(' AND ');
  const base = `FROM time_entries e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN tickets k ON k.id = e.ticket_id
    WHERE ${where}`;

  let wd = 0;
  { const d = new Date(from), end = new Date(to);
    while (d <= end) { if (d.getDay() !== 0 && d.getDay() !== 6) wd++; d.setDate(d.getDate() + 1); } }

  const byUser = db.prepare(`SELECT u.id, u.name, u.color, u.capacity_hours, SUM(e.hours) AS hours ${base} GROUP BY u.id ORDER BY hours DESC`).all(...params)
    .map((r) => ({ ...r, capacity_period: Math.round((r.capacity_hours / 5) * wd * 10) / 10, utilization: r.capacity_hours ? Math.round((r.hours / ((r.capacity_hours / 5) * wd)) * 100) : null }));
  const byProject = db.prepare(`SELECT COALESCE(p.name,'No project') AS name, SUM(e.hours) AS hours ${base} GROUP BY p.id ORDER BY hours DESC`).all(...params);
  const byCategory = db.prepare(`SELECT e.category AS name, SUM(e.hours) AS hours ${base} GROUP BY e.category ORDER BY hours DESC`).all(...params);
  const byDay = db.prepare(`SELECT e.date, SUM(e.hours) AS hours ${base} GROUP BY e.date ORDER BY e.date`).all(...params);
  const byTicket = db.prepare(`SELECT k.key, k.title, k.status, k.estimate_hours, u2.name AS assignee, SUM(e.hours) AS logged_hours
    ${base.replace('LEFT JOIN tickets k ON k.id = e.ticket_id', 'JOIN tickets k ON k.id = e.ticket_id LEFT JOIN users u2 ON u2.id = k.assignee_id')}
    GROUP BY k.id ORDER BY logged_hours DESC LIMIT 15`).all(...params);
  const total = byUser.reduce((s, r) => s + r.hours, 0);
  res.json({ from, to, workdays: wd, total_hours: total, byUser, byProject, byCategory, byDay, byTicket });
}));

// ---------- Weekly highlights: work handled outside the ticket system ----------
app.get('/api/highlights', wrap((req, res) => {
  const uid = +(req.query.user_id || req.user.id);
  const clauses = ['user_id = ?'], params = [uid];
  if (req.query.week) { clauses.push('week = ?'); params.push(req.query.week); }
  res.json(db.prepare(`SELECT * FROM highlights WHERE ${clauses.join(' AND ')} ORDER BY week DESC, id`).all(...params));
}));
app.post('/api/highlights', wrap((req, res) => {
  const { week, body } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) throw bad('week must be a date (the Monday of the week)');
  if (!body || !String(body).trim()) throw bad('Highlight text is required');
  const id = db.prepare('INSERT INTO highlights (user_id, week, body) VALUES (?,?,?)')
    .run(req.user.id, week, capFirst(String(body).trim())).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM highlights WHERE id = ?').get(id));
}));
app.delete('/api/highlights/:id', wrap((req, res) => {
  const h = db.prepare('SELECT * FROM highlights WHERE id = ?').get(req.params.id);
  if (!h) throw bad('Highlight not found');
  if (h.user_id !== req.user.id && !['admin', 'manager'].includes(req.user.role)) throw bad('You can only remove your own highlights');
  db.prepare('DELETE FROM highlights WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// Daily hours for the calendar heatmap (last ~6 months, one row per day with entries)
app.get('/api/time-heat', wrap((req, res) => {
  const uid = +(req.query.user_id || req.user.id);
  res.json(db.prepare("SELECT date, SUM(hours) AS hours FROM time_entries WHERE user_id = ? AND date >= date('now','-182 days') GROUP BY date").all(uid));
}));

// ---------- Dashboard ----------
app.get('/api/dashboard', wrap((req, res) => {
  const weekAgo = "date('now', '-7 days')";
  const totals = {
    hours_this_week: db.prepare(`SELECT COALESCE(SUM(hours),0) h FROM time_entries WHERE date >= ${weekAgo}`).get().h,
    hours_this_month: db.prepare("SELECT COALESCE(SUM(hours),0) h FROM time_entries WHERE date >= date('now','start of month')").get().h,
    active_projects: db.prepare("SELECT COUNT(*) n FROM projects WHERE status = 'active'").get().n,
    open_tickets: db.prepare(`SELECT COUNT(*) n FROM tickets k WHERE NOT ${IS_DONE('k')}`).get().n,
    overdue_tickets: db.prepare(`SELECT COUNT(*) n FROM tickets k WHERE k.deadline < date('now') AND NOT ${IS_DONE('k')}`).get().n,
    blocked_tickets: db.prepare("SELECT COUNT(*) n FROM tickets WHERE status = 'blocked'").get().n,
    at_risk_milestones: db.prepare("SELECT COUNT(*) n FROM milestones WHERE status = 'at_risk' OR (due_date < date('now') AND status != 'completed')").get().n,
  };
  const teamWorkload = db.prepare(`
    SELECT t.id, t.name, t.color,
      (SELECT COUNT(*) FROM tickets k WHERE k.team_id = t.id AND NOT ${IS_DONE('k')}) AS open_tickets,
      (SELECT COALESCE(SUM(e.hours),0) FROM time_entries e JOIN users u ON u.id = e.user_id WHERE u.team_id = t.id AND e.date >= ${weekAgo}) AS hours_week
    FROM teams t ORDER BY t.name`).all();
  const userWorkload = db.prepare(`
    SELECT u.id, u.name, u.color, u.capacity_hours, t.name AS team_name,
      (SELECT COUNT(*) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS open_tickets,
      (SELECT COALESCE(SUM(k.estimate_hours),0) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS estimated_open_hours,
      (SELECT COALESCE(SUM(e.hours),0) FROM time_entries e WHERE e.user_id = u.id AND e.date >= ${weekAgo}) AS hours_week
    FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = 1 ORDER BY u.name`).all();
  const roadmap = db.prepare(`
    SELECT p.id, p.name, p.deadline, p.status, p.priority,
      (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id) AS total,
      (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id AND ${IS_DONE('k')}) AS done
    FROM projects p WHERE p.status IN ('active','planning') ORDER BY p.deadline`).all();
  const recentActivity = db.prepare(`
    SELECT a.*, u.name AS user_name, k.key AS ticket_key, k.title AS ticket_title
    FROM activity a LEFT JOIN users u ON u.id = a.user_id JOIN tickets k ON k.id = a.ticket_id
    ORDER BY a.created_at DESC LIMIT 12`).all();
  res.json({ totals, teamWorkload, userWorkload, roadmap, recentActivity, missingReports: missingTimeReports(7) });
}));

// ---------- Reports (JSON + exports) ----------
app.get('/api/reports/:type', wrap((req, res) => {
  res.json(buildReport(req.params.type, req.query));
}));
// safe client message: keep intentional (status-carrying) errors, generic-ize the rest
const safeErr = (e) => (e.status ? e.message : 'Something went wrong. Please try again.');
app.get('/api/export/excel/:type', (req, res) => {
  exportExcel(req.params.type, req.query, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(e.status || 500).json({ error: safeErr(e) });
  });
});
app.get('/api/export/pdf/:type', (req, res) => {
  try { exportPdf(req.params.type, req.query, res); } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(e.status || 500).json({ error: safeErr(e) });
  }
});

// ---------- AI agent ----------
app.post('/api/ai/chat', (req, res) => {
  const { messages } = req.body;
  aiChat(messages || [], req.user.id)
    .then((result) => res.json(result))
    .catch((e) => { console.error(e); res.status(e.status || 500).json({ error: safeErr(e) }); });
});

// ---------- helpers ----------
function patchRow(table, id, body, allowed) {
  const sets = [], params = [];
  for (const f of allowed) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f] === '' ? null : body[f]); }
  }
  if (!sets.length) throw bad('No valid fields to update');
  params.push(id);
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
function logActivity(ticketId, userId, type, detail) {
  db.prepare('INSERT INTO activity (ticket_id, user_id, type, detail) VALUES (?,?,?,?)').run(ticketId, userId || null, type, detail);
}
// Final error handler — catches multer errors and anything passed to next(err),
// returning JSON instead of Express's default HTML error page. No internal leak.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  const msg = err.status ? err.message
    : err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 20 MB)'
    : 'Something went wrong. Please try again.';
  res.status(status).json({ error: msg });
});
app.listen(PORT, () => console.log(`TimePort running at http://localhost:${PORT}`));
