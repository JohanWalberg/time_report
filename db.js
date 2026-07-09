// TimePort database layer — SQLite schema + seed data
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR lets the database + uploads live on a mounted persistent disk in
// production (e.g. Render's disk at /var/data). Defaults to ./data for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'timeport.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

if (process.argv.includes('--reseed') && fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Existing database removed, reseeding...');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#6366f1'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','manager','member')),
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  skills TEXT DEFAULT '',
  capacity_hours REAL NOT NULL DEFAULT 40,
  color TEXT DEFAULT '#0ea5e9',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  start_date TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','on_hold','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  sort_order REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','at_risk')),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  estimate_hours REAL DEFAULT 0,
  deadline TEXT,
  labels TEXT DEFAULT '',
  link TEXT DEFAULT '',
  board_order REAL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'development' CHECK (category IN ('development','design','meetings','planning','support','testing','documentation','other')),
  date TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_user_date ON time_entries(user_id, date);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','manager','member')),
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS starred_tickets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week TEXT NOT NULL,           -- Monday of the week the highlight belongs to (YYYY-MM-DD)
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'open' CHECK (category IN ('open','done')),
  sort_order REAL NOT NULL DEFAULT 45,
  UNIQUE(project_id, key)
);
`);

// Migration: password login. Existing users get the default password "timeport".
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
{
  const { hashPassword } = require('./lib/pw');
  const missing = db.prepare('SELECT id FROM users WHERE password_hash IS NULL').all();
  if (missing.length) {
    const set = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    for (const u of missing) set.run(hashPassword('timeport'), u.id);
    console.log(`Set default password "timeport" for ${missing.length} existing user(s).`);
  }
}

// Migrations for databases created before these columns existed
const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!ticketCols.includes('board_order')) db.exec('ALTER TABLE tickets ADD COLUMN board_order REAL');
if (!ticketCols.includes('link')) db.exec("ALTER TABLE tickets ADD COLUMN link TEXT DEFAULT ''");
if (!ticketCols.includes('start_date')) db.exec('ALTER TABLE tickets ADD COLUMN start_date TEXT'); // optional: gives a ticket duration on the roadmap
if (!userCols.includes('settings')) db.exec("ALTER TABLE users ADD COLUMN settings TEXT DEFAULT '{}'"); // per-user portal preferences (theme, size, accent)
// per-user calendar feed (secret iCal URL) — kept out of publicUser, never sent to the client
if (!userCols.includes('calendar_ics_url')) db.exec('ALTER TABLE users ADD COLUMN calendar_ics_url TEXT');
const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
if (!projectCols.includes('sort_order')) db.exec('ALTER TABLE projects ADD COLUMN sort_order REAL'); // manual roadmap ordering
{
  // Every project always has a sort_order: backfill any NULLs (freshly imported/created
  // rows) in the legacy display order. Keeps roadmap row order independent of deadlines.
  const unsorted = db.prepare(`SELECT id FROM projects WHERE sort_order IS NULL
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, deadline, id`).all();
  if (unsorted.length) {
    let base = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM projects').get().m;
    const set = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
    for (const p of unsorted) set.run(base += 1000, p.id);
  }
}

// Migration: drop the hard-coded CHECK constraint on tickets.status so projects can
// define custom workflow statuses. SQLite can't drop a constraint — rebuild the table.
const ticketsDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get();
if (ticketsDef && ticketsDef.sql.includes("status IN ('backlog'")) {
  console.log('Migrating tickets table: enabling custom statuses...');
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE tickets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
        assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
        estimate_hours REAL DEFAULT 0,
        deadline TEXT,
        labels TEXT DEFAULT '',
        link TEXT DEFAULT '',
        board_order REAL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tickets_new (id, key, title, description, project_id, milestone_id, assignee_id, team_id,
        status, priority, estimate_hours, deadline, labels, link, board_order, created_by, created_at, updated_at)
      SELECT id, key, title, description, project_id, milestone_id, assignee_id, team_id,
        status, priority, estimate_hours, deadline, labels, link, board_order, created_by, created_at, updated_at
      FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_new RENAME TO tickets;
      CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
    `);
  })();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
  console.log('Migration complete.');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity(ticket_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_time_ticket ON time_entries(ticket_id);
CREATE INDEX IF NOT EXISTS idx_time_project ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_highlights_user_week ON highlights(user_id, week);
`);

// Normalization: all stored text starts with a capital letter (idempotent, runs each boot)
{
  const { capFirst, capLabels } = require('./lib/text');
  const capCols = (table, cols) => {
    for (const row of db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table}`).all()) {
      const sets = [], params = [];
      for (const c of cols) {
        const fixed = (c === 'labels' || c === 'skills') ? capLabels(row[c] || '') : capFirst(row[c]);
        if (typeof fixed === 'string' && fixed !== row[c]) { sets.push(`${c} = ?`); params.push(fixed); }
      }
      if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
    }
  };
  const normalize = db.transaction(() => {
    capCols('teams', ['name', 'description']);
    capCols('users', ['name', 'skills']);
    capCols('projects', ['name', 'description']);
    capCols('milestones', ['name', 'description']);
    capCols('tickets', ['title', 'description', 'labels']);
    capCols('comments', ['body']);
    capCols('time_entries', ['description']);
    capCols('project_statuses', ['label']);
  });
  normalize();
}

// ---- Seed ----
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  console.log('Seeding database with demo data...');

  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const daysFromNow = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

  const seedTx = db.transaction(() => {
    const t = db.prepare('INSERT INTO teams (name, description, color) VALUES (?,?,?)');
    const teamPlatform = t.run('Platform', 'Backend services & infrastructure', '#6366f1').lastInsertRowid;
    const teamProduct = t.run('Product', 'Web & mobile product development', '#10b981').lastInsertRowid;
    const teamDesign = t.run('Design', 'UX, UI and brand design', '#f59e0b').lastInsertRowid;

    const { hashPassword } = require('./lib/pw');
    const demoPw = hashPassword('timeport');
    const u = db.prepare('INSERT INTO users (name, email, role, team_id, skills, capacity_hours, color, password_hash) VALUES (?,?,?,?,?,?,?,?)');
    const johan  = u.run('Johan Walberg', 'johan@example.com', 'admin', teamPlatform, 'architecture, node, sql, leadership', 40, '#6366f1', demoPw).lastInsertRowid;
    const maria  = u.run('Maria Lindqvist', 'maria@example.com', 'manager', teamProduct, 'product management, roadmapping, agile', 40, '#10b981', demoPw).lastInsertRowid;
    const erik   = u.run('Erik Sundberg', 'erik@example.com', 'member', teamPlatform, 'go, kubernetes, postgres', 40, '#0ea5e9', demoPw).lastInsertRowid;
    const sara   = u.run('Sara Nilsson', 'sara@example.com', 'member', teamProduct, 'react, typescript, css', 40, '#ec4899', demoPw).lastInsertRowid;
    const anders = u.run('Anders Holm', 'anders@example.com', 'member', teamProduct, 'react-native, ios, android', 32, '#f97316', demoPw).lastInsertRowid;
    const lina   = u.run('Lina Berg', 'lina@example.com', 'manager', teamDesign, 'figma, ux research, design systems', 40, '#f59e0b', demoPw).lastInsertRowid;
    const oskar  = u.run('Oskar Wik', 'oskar@example.com', 'member', teamDesign, 'ui design, illustration, prototyping', 40, '#8b5cf6', demoPw).lastInsertRowid;
    const emma   = u.run('Emma Ström', 'emma@example.com', 'member', teamPlatform, 'python, data pipelines, security', 40, '#14b8a6', demoPw).lastInsertRowid;

    const p = db.prepare('INSERT INTO projects (name, description, owner_id, team_id, start_date, deadline, status, priority) VALUES (?,?,?,?,?,?,?,?)');
    const pPortal  = p.run('Customer Portal 2.0', 'Rebuild of the customer-facing portal with self-service features.', maria, teamProduct, daysFromNow(-45), daysFromNow(40), 'active', 'high').lastInsertRowid;
    const pBilling = p.run('Billing Engine', 'New usage-based billing engine replacing the legacy invoicing system.', johan, teamPlatform, daysFromNow(-60), daysFromNow(20), 'active', 'urgent').lastInsertRowid;
    const pMobile  = p.run('Mobile App v3', 'Native mobile app refresh with offline mode.', maria, teamProduct, daysFromNow(-20), daysFromNow(75), 'active', 'medium').lastInsertRowid;
    const pDesign  = p.run('Design System', 'Shared component library and design tokens.', lina, teamDesign, daysFromNow(-90), daysFromNow(-5), 'active', 'medium').lastInsertRowid;

    const m = db.prepare('INSERT INTO milestones (project_id, name, description, due_date, status, sort_order) VALUES (?,?,?,?,?,?)');
    const msPortalBeta = m.run(pPortal, 'Beta launch', 'Portal beta to 50 pilot customers', daysFromNow(10), 'in_progress', 1).lastInsertRowid;
    const msPortalGA   = m.run(pPortal, 'GA release', 'General availability', daysFromNow(40), 'planned', 2).lastInsertRowid;
    const msBillCore   = m.run(pBilling, 'Core engine complete', 'Rating + invoicing pipeline done', daysFromNow(-3), 'at_risk', 1).lastInsertRowid;
    const msBillMigr   = m.run(pBilling, 'Customer migration', 'All customers moved off legacy', daysFromNow(20), 'planned', 2).lastInsertRowid;
    const msMobileMVP  = m.run(pMobile, 'Offline MVP', 'Offline mode functional on both platforms', daysFromNow(35), 'in_progress', 1).lastInsertRowid;
    const msDSv1       = m.run(pDesign, 'v1.0 release', 'Tokens + 20 core components', daysFromNow(-5), 'at_risk', 1).lastInsertRowid;

    const tk = db.prepare(`INSERT INTO tickets (key, title, description, project_id, milestone_id, assignee_id, team_id, status, priority, estimate_hours, deadline, labels, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now', ?))`);
    let seq = 0;
    const key = () => `TP-${++seq + 100}`;
    const tickets = [
      // [title, desc, project, milestone, assignee, team, status, prio, est, deadline, labels, agedDays]
      ['Portal login with SSO', 'Support SAML and OIDC single sign-on in the new portal.', pPortal, msPortalBeta, sara, teamProduct, 'in_review', 'high', 16, daysFromNow(5), 'auth,frontend', 30],
      ['Self-service subscription management', 'Customers can upgrade/downgrade plans from the portal.', pPortal, msPortalBeta, sara, teamProduct, 'in_progress', 'high', 24, daysFromNow(8), 'frontend,billing', 25],
      ['Portal usage dashboard', 'Charts showing customer usage per product.', pPortal, msPortalBeta, anders, teamProduct, 'todo', 'medium', 20, daysFromNow(9), 'frontend,charts', 20],
      ['Notification preferences page', 'Let users configure email/SMS notifications.', pPortal, msPortalGA, null, teamProduct, 'backlog', 'low', 8, daysFromNow(30), 'frontend', 18],
      ['Portal accessibility audit', 'WCAG 2.2 AA audit and fixes.', pPortal, msPortalGA, oskar, teamDesign, 'todo', 'medium', 12, daysFromNow(25), 'a11y,design', 15],
      ['Fix: session timeout loses form data', 'Draft data should survive re-login.', pPortal, msPortalBeta, sara, teamProduct, 'done', 'high', 6, daysFromNow(-2), 'bug,frontend', 14],
      ['Rating engine for metered usage', 'Compute charges from raw usage events.', pBilling, msBillCore, erik, teamPlatform, 'in_progress', 'urgent', 40, daysFromNow(-1), 'backend,core', 40],
      ['Invoice PDF generation', 'Generate branded invoice PDFs.', pBilling, msBillCore, emma, teamPlatform, 'in_review', 'high', 16, daysFromNow(2), 'backend,pdf', 35],
      ['Tax calculation service integration', 'Integrate with external VAT/GST service.', pBilling, msBillCore, erik, teamPlatform, 'blocked', 'urgent', 12, daysFromNow(-4), 'backend,integration', 28],
      ['Dunning & payment retry flow', 'Automatic retries and reminder emails for failed payments.', pBilling, msBillMigr, emma, teamPlatform, 'todo', 'high', 20, daysFromNow(15), 'backend,email', 22],
      ['Legacy invoice data migration script', 'One-time migration of 4 years of invoices.', pBilling, msBillMigr, johan, teamPlatform, 'todo', 'medium', 24, daysFromNow(18), 'migration,data', 20],
      ['Billing admin UI', 'Internal tool for support to adjust invoices.', pBilling, msBillMigr, sara, teamProduct, 'backlog', 'medium', 30, daysFromNow(19), 'frontend,internal', 12],
      ['Offline data sync engine', 'Conflict-free sync of local changes when back online.', pMobile, msMobileMVP, anders, teamProduct, 'in_progress', 'high', 40, daysFromNow(30), 'mobile,sync', 18],
      ['Push notification revamp', 'Rich push notifications with actions.', pMobile, msMobileMVP, anders, teamProduct, 'todo', 'medium', 12, daysFromNow(33), 'mobile', 16],
      ['Biometric login', 'FaceID/TouchID and Android biometrics.', pMobile, null, null, teamProduct, 'backlog', 'low', 10, daysFromNow(60), 'mobile,auth', 10],
      ['Design tokens: dark mode', 'Complete dark-mode token set.', pDesign, msDSv1, oskar, teamDesign, 'in_progress', 'high', 16, daysFromNow(-6), 'design,tokens', 30],
      ['Component: data table', 'Sortable, filterable data table component.', pDesign, msDSv1, oskar, teamDesign, 'in_review', 'medium', 20, daysFromNow(-8), 'design,component', 26],
      ['Component documentation site', 'Storybook-based docs for all components.', pDesign, msDSv1, lina, teamDesign, 'todo', 'medium', 14, daysFromNow(4), 'docs,design', 21],
      ['Icon library v2', 'Redraw 120 icons on the new grid.', pDesign, null, oskar, teamDesign, 'done', 'low', 24, daysFromNow(-15), 'design,icons', 45],
      ['Empty-state illustrations', 'Illustrations for all empty states in portal.', pDesign, null, oskar, teamDesign, 'done', 'low', 8, daysFromNow(-10), 'design,illustration', 30],
      ['API rate limiting', 'Protect public API with tiered rate limits.', pBilling, null, erik, teamPlatform, 'done', 'medium', 10, daysFromNow(-12), 'backend,security', 35],
      ['Security review of auth flows', 'Pen-test findings remediation.', pPortal, msPortalBeta, emma, teamPlatform, 'in_progress', 'urgent', 14, daysFromNow(3), 'security', 12],
    ];
    const ticketIds = [];
    for (const [title, desc, proj, ms, assignee, team, status, prio, est, deadline, labels, aged] of tickets) {
      ticketIds.push(tk.run(key(), title, desc, proj, ms, assignee, team, status, prio, est, deadline, labels, maria, `-${aged} days`).lastInsertRowid);
    }

    const cm = db.prepare(`INSERT INTO comments (ticket_id, user_id, body, created_at) VALUES (?,?,?,datetime('now', ?))`);
    cm.run(ticketIds[0], maria, 'Pilot customers are asking about Okta support specifically — please verify.', '-6 days');
    cm.run(ticketIds[0], sara, 'Okta verified against their dev tenant. Azure AD next.', '-4 days');
    cm.run(ticketIds[6], johan, 'This is the critical path for the billing deadline. Anything blocking you?', '-5 days');
    cm.run(ticketIds[6], erik, 'Edge cases around proration are trickier than estimated. Might need 8 more hours.', '-4 days');
    cm.run(ticketIds[8], erik, 'Blocked: waiting for sandbox credentials from the tax vendor since last Tuesday.', '-7 days');
    cm.run(ticketIds[8], johan, 'Escalated to vendor account manager.', '-6 days');
    cm.run(ticketIds[15], lina, 'Please align surface colors with the portal team before finalizing.', '-3 days');

    const ac = db.prepare(`INSERT INTO activity (ticket_id, user_id, type, detail, created_at) VALUES (?,?,?,?,datetime('now', ?))`);
    ac.run(ticketIds[0], sara, 'status', 'in_progress → in_review', '-2 days');
    ac.run(ticketIds[5], sara, 'status', 'in_review → done', '-3 days');
    ac.run(ticketIds[8], erik, 'status', 'in_progress → blocked', '-7 days');
    ac.run(ticketIds[8], johan, 'priority', 'high → urgent', '-6 days');
    ac.run(ticketIds[21], maria, 'assignee', 'Unassigned → Emma Ström', '-12 days');

    // Time entries: last ~30 days of realistic logging. Some users have gaps (missing reports).
    const te = db.prepare('INSERT INTO time_entries (user_id, ticket_id, project_id, category, date, hours, description, status) VALUES (?,?,?,?,?,?,?,?)');
    const workdays = [];
    for (let i = 30; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      if (d.getDay() !== 0 && d.getDay() !== 6) workdays.push(iso(d));
    }
    // deterministic pseudo-random
    let s = 42;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const plans = [
      // [user, ticket pool, project, categories, skipProbability]
      [sara,  [ticketIds[0], ticketIds[1], ticketIds[5], ticketIds[11]], pPortal, ['development','testing','meetings'], 0.05],
      [erik,  [ticketIds[6], ticketIds[8], ticketIds[20]], pBilling, ['development','meetings'], 0.08],
      [emma,  [ticketIds[7], ticketIds[9], ticketIds[21]], pBilling, ['development','testing'], 0.10],
      [anders,[ticketIds[12], ticketIds[13], ticketIds[2]], pMobile, ['development','meetings'], 0.30], // often forgets
      [oskar, [ticketIds[15], ticketIds[16], ticketIds[18], ticketIds[4]], pDesign, ['design','meetings'], 0.12],
      [lina,  [ticketIds[17]], pDesign, ['design','planning','meetings'], 0.20],
      [maria, [null], pPortal, ['planning','meetings','other'], 0.15],
      [johan, [ticketIds[10], null], pBilling, ['development','planning','meetings'], 0.25], // busy admin, gaps
    ];
    const descs = {
      development: ['Implementation work', 'Code review & fixes', 'Refactoring and unit tests', 'Bug fixing'],
      design: ['Design iteration in Figma', 'Component specs', 'Design review'],
      meetings: ['Team standup & sync', 'Stakeholder meeting', 'Planning meeting'],
      planning: ['Sprint planning & backlog grooming', 'Roadmap review'],
      testing: ['QA and regression testing', 'Writing e2e tests'],
      other: ['Admin and email', 'Interviews'],
      support: ['Customer support escalations'],
      documentation: ['Writing docs'],
    };
    for (const [user, pool, proj, cats, skipP] of plans) {
      for (const day of workdays) {
        if (rnd() < skipP) continue; // missing time report
        let remaining = 6 + Math.floor(rnd() * 3); // 6-8h
        while (remaining > 0) {
          const h = Math.min(remaining, [2, 3, 4][Math.floor(rnd() * 3)]);
          const cat = pick(cats);
          const ticket = cat === 'development' || cat === 'design' || cat === 'testing' ? pick(pool) : null;
          te.run(user, ticket, proj, cat, day, h, pick(descs[cat]), rnd() < 0.85 ? 'approved' : 'submitted');
          remaining -= h;
        }
      }
    }
  });
  seedTx();
  console.log('Seed complete. All demo users have the password "timeport".');
}
// Demo data is strictly opt-in (npm run seed). A normal server start leaves the
// database empty; the app then shows a first-run "create admin account" screen.
if (process.argv.includes('--reseed')) seed();

module.exports = db;

if (require.main === module) {
  console.log('Database ready at', DB_PATH);
}
