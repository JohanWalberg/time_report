// Linear CSV import. Parses Linear's issue export (CSV) and maps rows to
// TimePort tickets. Supports dry-run preview and is idempotent: each imported
// ticket is tagged with a `linear:<ID>` label used to skip duplicates on re-import.
const db = require('../db');
const { capFirst } = require('./text');

// Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes)
function parseCsv(text) {
  text = text.replace(/^﻿/, ''); // strip BOM
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

const STATUS_MAP = {
  backlog: 'backlog', triage: 'backlog',
  todo: 'todo', 'to do': 'todo', planned: 'todo',
  'in progress': 'in_progress', started: 'in_progress', doing: 'in_progress',
  'in review': 'in_review', review: 'in_review', 'in test': 'in_review', qa: 'in_review',
  done: 'done', completed: 'done', merged: 'done', released: 'done',
  blocked: 'blocked', 'on hold': 'blocked',
  canceled: '__skip__', cancelled: '__skip__', duplicate: '__skip__',
};
const PRIORITY_MAP = {
  urgent: 'urgent', high: 'high', medium: 'medium', low: 'low',
  'no priority': 'medium', none: 'medium', '': 'medium',
  1: 'urgent', 2: 'high', 3: 'medium', 4: 'low', 0: 'medium',
};

// Export timestamps ("Created"/"Updated" columns, present in both Linear and Jira
// exports) → SQLite datetime, so imported tickets keep their original history.
const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
};

function importLinear(csvText, options = {}, actorId = null) {
  const opts = {
    skipCanceled: options.skipCanceled !== false,       // skip Canceled/Duplicate/Archived rows
    createProjects: options.createProjects !== false,   // auto-create unknown projects
    ...options,
  };
  const rows = parseCsv(csvText);
  if (!rows.length) throw Object.assign(new Error('The file contains no data rows'), { status: 400 });
  // Jira CSV exports use different column names — alias them onto the Linear shape
  for (const r of rows) {
    if (r.title === undefined && r.summary !== undefined) r.title = r.summary;
    if (!r.id && r['issue key']) r.id = r['issue key'];
    if (!r.status && r['status category']) r.status = r['status category'];
    if (!r.project && r['project name']) r.project = r['project name'];
    if (!r['due date'] && r['due']) r['due date'] = r['due'];
    if (!r.estimate && r['original estimate']) r.estimate = String((parseFloat(r['original estimate']) || 0) / 3600); // Jira stores seconds
  }
  if (rows[0].title === undefined) {
    throw Object.assign(new Error('This does not look like a Linear or Jira export — no "Title" (Linear) or "Summary" (Jira) column found. Export your issues as CSV and upload that file.'), { status: 400 });
  }

  const users = db.prepare('SELECT id, name, email, team_id FROM users WHERE active = 1').all();
  const teams = db.prepare('SELECT id, name FROM teams').all();
  const projects = db.prepare('SELECT id, name, team_id FROM projects').all();
  const findUser = (name) => name && users.find((u) =>
    u.name.toLowerCase() === name.toLowerCase() || u.email.toLowerCase() === name.toLowerCase() ||
    u.name.toLowerCase().startsWith(name.toLowerCase().split('@')[0].replace(/[._]/g, ' ')));
  const findTeam = (name) => name && teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const existingLinearIds = new Set(
    db.prepare("SELECT labels FROM tickets WHERE labels LIKE '%linear:%'").all()
      .flatMap((r) => (r.labels || '').split(',').map((l) => l.trim()).filter((l) => l.startsWith('linear:'))));

  const preview = [];
  const warnings = new Set();
  const stats = { total: rows.length, importable: 0, duplicates: 0, skipped_status: 0, new_projects: new Set(), unmatched_assignees: new Set() };

  for (const r of rows) {
    const linearId = r.id || '';
    const item = {
      linear_id: linearId,
      title: capFirst(r.title || '(no title)'),
      description: capFirst(r.description || ''),
      status: STATUS_MAP[(r.status || '').toLowerCase()] ?? 'todo',
      priority: PRIORITY_MAP[(r.priority || '').toLowerCase()] || 'medium',
      estimate_hours: parseFloat(r.estimate) || 0,
      deadline: (r['due date'] || '').slice(0, 10) || null,
      link: r.url || r.link || '',
      labels: (r.labels || '').split(',').map((l) => l.trim()).filter(Boolean).map((l) => l.includes(':') ? l : capFirst(l)),
      project_name: capFirst(r.project || ''),
      assignee_name: r.assignee || '',
      team_name: r.team || '',
      created_at: parseDate(r.created),
      updated_at: parseDate(r.updated) || parseDate(r.created),
      action: 'import',
      notes: [],
    };
    if (r.archived) { item.status = '__skip__'; }
    if (item.status === '__skip__') {
      if (opts.skipCanceled) { item.action = 'skip'; item.notes.push('canceled/archived in Linear'); stats.skipped_status++; }
      else { item.status = 'done'; item.notes.push('canceled in Linear → imported as done'); }
    }
    if (linearId && existingLinearIds.has('linear:' + linearId)) {
      item.action = 'duplicate'; item.notes.push('already imported'); stats.duplicates++;
    }
    if (item.action === 'import') {
      stats.importable++;
      const matchedUser = findUser(item.assignee_name);
      item.assignee_id = matchedUser ? matchedUser.id : null;
      if (item.assignee_name && !matchedUser) {
        stats.unmatched_assignees.add(item.assignee_name);
        item.notes.push(`assignee "${item.assignee_name}" not found → unassigned`);
      }
      const matchedProj = projects.find((p) => p.name.toLowerCase() === item.project_name.toLowerCase());
      item.project_id = matchedProj ? matchedProj.id : null;
      if (item.project_name && !matchedProj) {
        if (opts.createProjects) { stats.new_projects.add(item.project_name); item.notes.push(`project "${item.project_name}" will be created`); }
        else item.notes.push(`project "${item.project_name}" not found → no project`);
      }
      if (item.team_name && !findTeam(item.team_name)) warnings.add(`Team "${item.team_name}" does not exist in TimePort — tickets keep no team. Create the team first if you want it linked.`);
    }
    item.index = preview.length; // row key used by preview overrides
    preview.push(item);
  }

  const result = {
    stats: {
      total: stats.total,
      importable: stats.importable,
      duplicates: stats.duplicates,
      skipped: stats.skipped_status,
      new_projects: [...stats.new_projects],
      unmatched_assignees: [...stats.unmatched_assignees],
    },
    warnings: [...warnings],
    preview,
  };
  if (options.dryRun) return result;

  // ---- commit ----
  // opts.overrides comes from the interactive preview: { [row index]: { assignee_id, project_id, project_new } }.
  // When present it is authoritative — rows without an entry were deselected and are skipped,
  // and assignee/project come from the override instead of CSV matching.
  const overrides = opts.overrides || null;
  const created = [];
  const tx = db.transaction(() => {
    const projByName = new Map(projects.map((p) => [p.name.toLowerCase(), p]));
    const projById = new Map(projects.map((p) => [p.id, p]));
    const createProject = (name, teamName) => {
      const team = findTeam(teamName);
      const pid = db.prepare(`INSERT INTO projects (name, description, team_id, status, priority, sort_order)
        VALUES (?,?,?,'active','medium', (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM projects))`)
        .run(name, 'Imported from Linear', team ? team.id : null).lastInsertRowid;
      const p = { id: pid, name, team_id: team ? team.id : null };
      projByName.set(name.toLowerCase(), p);
      projById.set(pid, p);
      return p;
    };
    for (const item of preview) {
      if (item.action !== 'import') continue;
      const ov = overrides ? overrides[item.index] : undefined;
      if (overrides && !ov) continue; // deselected in the preview
      let proj, assignee;
      if (ov) {
        proj = ov.project_new
          ? (projByName.get(String(ov.project_new).toLowerCase()) || createProject(capFirst(String(ov.project_new).trim()), item.team_name))
          : (ov.project_id ? projById.get(Number(ov.project_id)) || null : null);
        assignee = ov.assignee_id ? users.find((u) => u.id === Number(ov.assignee_id)) || null : null;
      } else {
        proj = projByName.get(item.project_name.toLowerCase()) || null;
        if (!proj && item.project_name && opts.createProjects) proj = createProject(item.project_name, item.team_name);
        assignee = findUser(item.assignee_name);
      }
      const team = findTeam(item.team_name);
      const last = db.prepare('SELECT key FROM tickets ORDER BY id DESC LIMIT 1').get();
      const key = `TP-${last ? parseInt(last.key.split('-')[1], 10) + 1 : 101}`;
      const labels = [...item.labels, item.linear_id ? 'linear:' + item.linear_id : null].filter(Boolean).join(',');
      const id = db.prepare(`INSERT INTO tickets (key, title, description, project_id, assignee_id, team_id, status, priority, estimate_hours, deadline, labels, link, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`).run(
        key, item.title, item.description, proj ? proj.id : null, assignee ? assignee.id : null,
        team ? team.id : (assignee ? assignee.team_id : null), item.status, item.priority,
        item.estimate_hours, item.deadline, labels, item.link, actorId, item.created_at, item.updated_at).lastInsertRowid;
      db.prepare(`INSERT INTO activity (ticket_id, user_id, type, detail, created_at) VALUES (?,?,?,?, COALESCE(?, datetime('now')))`)
        .run(id, actorId, 'created', `Imported from Linear${item.linear_id ? ' (' + item.linear_id + ')' : ''}`, item.created_at);
      created.push({ key, title: item.title, linear_id: item.linear_id });
    }
  });
  tx();
  result.created = created;
  return result;
}

module.exports = { importLinear, parseCsv };
