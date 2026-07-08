// TimePort AI assistant.
// Provider-agnostic manual tool-use loop over database-backed tools. The provider
// and API key come from the Integrations page (OpenAI or Anthropic; most recently
// saved wins), falling back to Anthropic env credentials. With no credentials at
// all, a built-in offline assistant handles the most common queries directly.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { buildReport, REPORT_TYPES, missingTimeReports } = require('./reports');
const { IS_DONE } = require('./status');

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const OPENAI_MODEL = 'gpt-4o';
let client = null, clientKey = null;
let authFailedFor = null; // config signature that last failed auth — don't retry it every message

// Resolve which provider powers the assistant right now
function getAiConfig() {
  try {
    const rows = db.prepare("SELECT provider, config, updated_at FROM integrations WHERE provider IN ('openai','anthropic') AND enabled = 1").all();
    const usable = rows
      .map((r) => ({ provider: r.provider, updated_at: r.updated_at || '', ...JSON.parse(r.config || '{}') }))
      .filter((c) => c.api_key)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    if (usable[0]) return usable[0];
  } catch { /* integrations table problems never break chat — fall through */ }
  return { provider: 'anthropic', api_key: null }; // SDK resolves env / ant profile
}
const cfgSignature = (cfg) => `${cfg.provider}:${cfg.api_key || 'env'}:${cfg.model || ''}`;

function getClient(apiKey) {
  const k = apiKey || 'env';
  if (!client || clientKey !== k) {
    client = new Anthropic(apiKey ? { apiKey } : {});
    clientKey = k;
  }
  return client;
}

// ---------- Tools (shared by the model and used directly by offline mode) ----------
const toolImpls = {
  query_tickets(input) {
    const clauses = [], params = [];
    if (input.project) { clauses.push('p.name LIKE ?'); params.push(`%${input.project}%`); }
    if (input.assignee) { clauses.push('u.name LIKE ?'); params.push(`%${input.assignee}%`); }
    if (input.team) { clauses.push('t.name LIKE ?'); params.push(`%${input.team}%`); }
    if (input.status) { clauses.push('k.status = ?'); params.push(input.status); }
    if (input.priority) { clauses.push('k.priority = ?'); params.push(input.priority); }
    if (input.overdue) clauses.push(`k.deadline < date('now') AND NOT ${IS_DONE('k')}`);
    if (input.open_only) clauses.push(`NOT ${IS_DONE('k')}`);
    const rows = db.prepare(`
      SELECT k.key, k.title, k.status, k.priority, k.estimate_hours, k.deadline, k.labels, k.link, k.description,
        u.name AS assignee, p.name AS project, t.name AS team,
        (SELECT COALESCE(SUM(hours),0) FROM time_entries e WHERE e.ticket_id = k.id) AS logged_hours
      FROM tickets k
      LEFT JOIN users u ON u.id = k.assignee_id
      LEFT JOIN projects p ON p.id = k.project_id
      LEFT JOIN teams t ON t.id = k.team_id
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY k.deadline LIMIT 50`).all(...params);
    return { count: rows.length, tickets: rows };
  },

  query_time(input) {
    const clauses = ['1=1'], params = [];
    if (input.user) { clauses.push('u.name LIKE ?'); params.push(`%${input.user}%`); }
    if (input.team) { clauses.push('t.name LIKE ?'); params.push(`%${input.team}%`); }
    if (input.project) { clauses.push('p.name LIKE ?'); params.push(`%${input.project}%`); }
    if (input.from) { clauses.push('e.date >= ?'); params.push(input.from); }
    if (input.to) { clauses.push('e.date <= ?'); params.push(input.to); }
    const rows = db.prepare(`
      SELECT e.date, e.hours, e.category, e.description, u.name AS user, p.name AS project, k.key AS ticket
      FROM time_entries e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN teams t ON t.id = u.team_id
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN tickets k ON k.id = e.ticket_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC LIMIT 400`).all(...params);
    const total = rows.reduce((s, r) => s + r.hours, 0);
    const byUser = {}, byProject = {}, byCategory = {};
    for (const r of rows) {
      byUser[r.user] = (byUser[r.user] || 0) + r.hours;
      byProject[r.project || '—'] = (byProject[r.project || '—'] || 0) + r.hours;
      byCategory[r.category] = (byCategory[r.category] || 0) + r.hours;
    }
    return { total_hours: total, entry_count: rows.length, by_user: byUser, by_project: byProject, by_category: byCategory, entries: rows.slice(0, 60) };
  },

  get_projects() {
    const projects = db.prepare(`
      SELECT p.id, p.name, p.description, p.status, p.priority, p.start_date, p.deadline,
        u.name AS owner, t.name AS team,
        (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id) AS total_tickets,
        (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id AND ${IS_DONE('k')}) AS done_tickets,
        (SELECT COALESCE(SUM(hours),0) FROM time_entries e WHERE e.project_id = p.id) AS logged_hours
      FROM projects p LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN teams t ON t.id = p.team_id`).all();
    for (const p of projects) {
      p.progress_pct = p.total_tickets ? Math.round((p.done_tickets / p.total_tickets) * 100) : 0;
      p.milestones = db.prepare('SELECT name, due_date, status FROM milestones WHERE project_id = ? ORDER BY sort_order').all(p.id);
    }
    return { projects };
  },

  get_workload() {
    return {
      users: db.prepare(`
        SELECT u.name, u.skills, u.capacity_hours, t.name AS team,
          (SELECT COUNT(*) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS open_tickets,
          (SELECT COALESCE(SUM(k.estimate_hours),0) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS estimated_open_hours,
          (SELECT COALESCE(SUM(e.hours),0) FROM time_entries e WHERE e.user_id = u.id AND e.date >= date('now','-7 days')) AS hours_last_7_days
        FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = 1`).all(),
    };
  },

  missing_reports(input) {
    const days = Math.min(input.days || 7, 60);
    return { window_days: days, missing: missingTimeReports(days).map((u) => ({ name: u.name, missing_days: u.missing_days })) };
  },

  create_project(input, actorId) {
    if (!input.name) return { error: 'name is required' };
    const { capFirst } = require('./text');
    const existing = db.prepare('SELECT id, name FROM projects WHERE name LIKE ?').get(`%${input.name}%`);
    if (existing) return { created: false, id: existing.id, name: existing.name, note: `A project matching "${input.name}" already exists ("${existing.name}") — use it instead of creating a duplicate.` };
    const team = input.team ? db.prepare('SELECT id FROM teams WHERE name LIKE ?').get(`%${input.team}%`) : null;
    const owner = input.owner ? db.prepare('SELECT id FROM users WHERE name LIKE ?').get(`%${input.owner}%`) : null;
    const name = capFirst(input.name);
    const id = db.prepare(`INSERT INTO projects (name, description, owner_id, team_id, start_date, deadline, status, priority, sort_order)
      VALUES (?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM projects))`)
      .run(name, capFirst(input.description || ''), owner ? owner.id : (actorId || null), team ? team.id : null,
        input.start_date || null, input.deadline || null, input.status || 'active', input.priority || 'medium').lastInsertRowid;
    return { created: true, id, name };
  },

  create_ticket(input, actorId) {
    if (!input.title) return { error: 'title is required' };
    const { capFirst, capLabels } = require('./text');
    input.title = capFirst(input.title);
    if (input.description) input.description = capFirst(input.description);
    if (input.labels) input.labels = capLabels(input.labels);
    const proj = input.project ? db.prepare('SELECT id, team_id FROM projects WHERE name LIKE ?').get(`%${input.project}%`) : null;
    const assignee = input.assignee ? db.prepare('SELECT id, team_id FROM users WHERE name LIKE ?').get(`%${input.assignee}%`) : null;
    const last = db.prepare('SELECT key FROM tickets ORDER BY id DESC LIMIT 1').get();
    const nextNum = last ? parseInt(last.key.split('-')[1], 10) + 1 : 101;
    const key = `TP-${nextNum}`;
    const id = db.prepare(`INSERT INTO tickets (key, title, description, project_id, assignee_id, team_id, status, priority, estimate_hours, deadline, labels, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      key, input.title, input.description || '', proj ? proj.id : null, assignee ? assignee.id : null,
      (assignee && assignee.team_id) || (proj && proj.team_id) || null, 'todo', input.priority || 'medium',
      input.estimate_hours || 0, input.deadline || null, input.labels || '', actorId || null).lastInsertRowid;
    db.prepare('INSERT INTO activity (ticket_id, user_id, type, detail) VALUES (?,?,?,?)').run(id, actorId || null, 'created', 'Created by AI assistant');
    const result = { created: true, key, id, title: input.title, project: proj ? input.project : null };
    if (input.project && !proj) {
      result.warning = `Project "${input.project}" does NOT exist — this ticket was created WITHOUT a project. Call create_project first, then tell the user honestly what happened, or recreate the situation correctly.`;
    }
    return result;
  },

  generate_report(input) {
    if (!REPORT_TYPES.includes(input.type)) return { error: `type must be one of ${REPORT_TYPES.join(', ')}` };
    // Which scope filters each report type actually honors — anything else must be
    // rejected loudly, otherwise the report silently covers the whole workspace
    // while the user believes it is filtered.
    const SUPPORTED = {
      user: ['user'], team: ['team'], project: ['project'],
      tickets: ['user', 'team', 'project'],
      roadmap: [], time: [], missing: [], workload: [],
    };
    const unsupported = ['user', 'team', 'project'].filter((k) => input[k] && !SUPPORTED[input.type].includes(k));
    if (unsupported.length) {
      const hints = [];
      if (input.user) hints.push(`for ONE person's workload/effort/hours use type "user" with the user filter`);
      if (input.team) hints.push(`for a team use type "team"`);
      if (input.project) hints.push(`for a project use type "project"`);
      return { error: `The "${input.type}" report cannot be filtered by ${unsupported.join('/')} — it always covers the whole workspace. Instead: ${hints.join('; ')}. Call generate_report again with the right type.` };
    }
    const params = {};
    // Resolve friendly names to ids (the tickets report filters people via assignee_id)
    if (input.user) {
      const u = db.prepare('SELECT id, name FROM users WHERE name LIKE ?').get(`%${input.user}%`);
      if (!u) return { error: `No user matching "${input.user}" found — check the name.` };
      params[input.type === 'tickets' ? 'assignee_id' : 'user_id'] = u.id;
    }
    if (input.team) {
      const t = db.prepare('SELECT id FROM teams WHERE name LIKE ?').get(`%${input.team}%`);
      if (!t) return { error: `No team matching "${input.team}" found — check the name.` };
      params.team_id = t.id;
    }
    if (input.project) {
      const p = db.prepare('SELECT id FROM projects WHERE name LIKE ?').get(`%${input.project}%`);
      if (!p) return { error: `No project matching "${input.project}" found — check the name.` };
      params.project_id = p.id;
    }
    if (input.from) params.from = input.from;
    if (input.to) params.to = input.to;
    if (input.days) params.days = input.days;
    if (input.overdue) params.overdue = '1';
    const report = buildReport(input.type, params);
    const qs = new URLSearchParams(params).toString();
    return {
      title: report.title,
      summary: report.summary,
      excel_url: `/api/export/excel/${input.type}${qs ? '?' + qs : ''}`,
      pdf_url: `/api/export/pdf/${input.type}${qs ? '?' + qs : ''}`,
      note: 'Give the user these download links as markdown links. Use excel_url and pdf_url EXACTLY as provided (relative paths starting with /api/) — never prefix them with sandbox:, http://, or any other scheme, and never alter the query string.',
    };
  },
};

const TOOLS = [
  {
    name: 'query_tickets',
    description: 'Search tickets. Call this when the user asks about tickets, bugs, tasks, what is overdue, blocked, assigned to someone, or the state of work. All filters optional.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (partial match)' },
        assignee: { type: 'string', description: 'Assignee name (partial match)' },
        team: { type: 'string', description: 'Team name (partial match)' },
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        overdue: { type: 'boolean', description: 'Only tickets past their deadline and not done' },
        open_only: { type: 'boolean', description: 'Exclude done tickets' },
      },
    },
  },
  {
    name: 'query_time',
    description: 'Query logged time entries with aggregates (totals by user, project, category). Call this for questions like "what did Team A work on last week" or "how many hours did X log". Dates are YYYY-MM-DD.',
    input_schema: {
      type: 'object',
      properties: {
        user: { type: 'string' }, team: { type: 'string' }, project: { type: 'string' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'get_projects',
    description: 'List all projects with status, deadlines, progress %, logged hours and milestones. Call this for project status, roadmap questions, or roadmap improvement suggestions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workload',
    description: 'Per-person workload: open tickets, estimated open hours, hours logged last 7 days, weekly capacity, and skills. Call this before assigning tickets or answering capacity questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'missing_reports',
    description: 'Find workdays where people have not logged any time. Call this when asked about missing time reports.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Look-back window in days, default 7' } } },
  },
  {
    name: 'create_project',
    description: 'Create a new project. Call this when the user asks for a new project — and ALWAYS call it BEFORE create_ticket when tickets should go into a project that does not exist yet. If a similar project already exists, the result says so instead of creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'What the project is about' },
        team: { type: 'string', description: 'Team name (partial match, optional)' },
        owner: { type: 'string', description: 'Owner name (partial match, optional; defaults to the current user)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        deadline: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        status: { type: 'string', enum: ['planning', 'active'], description: 'Default active' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_ticket',
    description: `Create a new ticket. Call this when the user asks to create a ticket/task/bug. Write a clear, actionable title. Format the description as markdown with EXACTLY this structure:

**Background**
1–2 sentences of context: why this matters / what prompted it.

**What to do**
- concrete step or requirement
- concrete step or requirement

**Acceptance criteria**
- verifiable outcome ("Users can …", "X no longer happens when …")
- verifiable outcome

If the user did not name an assignee, check get_workload first and pick the least-loaded person whose skills match, then mention who you assigned and why.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Detailed description, ideally with acceptance criteria' },
        project: { type: 'string', description: 'Project name (partial match)' },
        assignee: { type: 'string', description: 'Assignee name (partial match)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        estimate_hours: { type: 'number' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        labels: { type: 'string', description: 'Comma-separated labels' },
      },
      required: ['title'],
    },
  },
  {
    name: 'generate_report',
    description: `Generate a report and get Excel + PDF download links. Always share the returned excel_url and pdf_url with the user as markdown links.
Types and the ONLY filters each supports:
- "user": one person's full report (hours, projects, tickets, highlights) — REQUIRES the user filter. Use this whenever the user asks about a single person, including their workload.
- "team": one team — requires the team filter.
- "project": one project — requires the project filter.
- "tickets": ticket list — optional user/team/project filters.
- "workload", "time", "roadmap", "missing": ALWAYS whole-workspace, NO person/team/project filters. Never use these for a single person.`,
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: REPORT_TYPES },
        user: { type: 'string' }, team: { type: 'string' }, project: { type: 'string' },
        from: { type: 'string' }, to: { type: 'string' },
        days: { type: 'integer' }, overdue: { type: 'boolean' },
      },
      required: ['type'],
    },
  },
];

function systemPrompt(currentUser) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the TimePort assistant, embedded in a time reporting and project management platform.
Today's date is ${today}. The person talking to you is ${currentUser ? `${currentUser.name} (${currentUser.role})` : 'unknown'}.

You help with: creating well-written tickets, summarizing project progress and individual work, finding missing time reports, workload and capacity questions, suggesting roadmap improvements, generating Excel/PDF reports, and answering questions about tickets, projects, teams and logged time.

Ground every answer in tool results — never invent tickets, hours, or people. Use the tools to look things up before answering. NEVER claim something was created or changed unless a tool result explicitly confirms it (created: true); if a tool result contains a warning, take it seriously, fix the situation if you can, and tell the user honestly what happened. To put tickets into a brand-new project, call create_project FIRST, then create the tickets with that project name. When you create a ticket, always follow the description template from the create_ticket tool (**Background** / **What to do** / **Acceptance criteria** sections in markdown), then confirm what you created (key, title, assignee, priority). When you generate a report, always include the Excel and PDF download links as markdown links. When suggesting roadmap improvements or detecting unclear tickets, be concrete: name the specific tickets/milestones and what to change. Keep answers short and skimmable — use bullet lists and bold ticket keys. Amounts of hours: round to one decimal.`;
}

// ---------- Online agents (manual tool loop per provider) ----------
async function runAgent(cfg, messages, currentUser) {
  return cfg.provider === 'openai'
    ? runOpenAI(cfg, messages, currentUser)
    : runAnthropic(cfg, messages, currentUser);
}

async function runAnthropic(cfg, messages, currentUser) {
  const anthropic = getClient(cfg.api_key);
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const actions = [];
  let response;
  for (let turn = 0; turn < 8; turn++) {
    response = await anthropic.messages.create({
      model: cfg.model || ANTHROPIC_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: systemPrompt(currentUser),
      tools: TOOLS,
      messages: convo,
    });
    if (response.stop_reason !== 'tool_use') break;
    convo.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        result = toolImpls[block.name](block.input || {}, currentUser && currentUser.id);
        if (block.name === 'create_ticket' && result.created) actions.push({ type: 'ticket_created', key: result.key, id: result.id });
      } catch (e) {
        result = { error: e.message };
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    convo.push({ role: 'user', content: results });
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '(no response)';
  return { reply: text, actions, offline: false };
}

// OpenAI chat completions with function calling — same tools, no SDK needed
const OPENAI_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
async function runOpenAI(cfg, messages, currentUser) {
  const convo = [
    { role: 'system', content: systemPrompt(currentUser) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const actions = [];
  let lastText = '';
  for (let turn = 0; turn < 8; turn++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: JSON.stringify({ model: cfg.model || OPENAI_MODEL, messages: convo, tools: OPENAI_TOOLS }),
      });
    } catch (e) {
      throw Object.assign(new Error('Could not reach the OpenAI API'), { aiKind: 'connection' });
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('OpenAI rejected the API key'), { aiKind: 'auth' });
    if (res.status === 429) throw Object.assign(new Error('OpenAI rate limit'), { aiKind: 'rate' });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = (await res.json()).choices[0].message;
    convo.push(msg);
    lastText = msg.content || lastText;
    if (!msg.tool_calls || !msg.tool_calls.length) break;
    for (const tc of msg.tool_calls) {
      let result;
      try {
        result = toolImpls[tc.function.name](JSON.parse(tc.function.arguments || '{}'), currentUser && currentUser.id);
        if (tc.function.name === 'create_ticket' && result.created) actions.push({ type: 'ticket_created', key: result.key, id: result.id });
      } catch (e) {
        result = { error: e.message };
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { reply: lastText || '(no response)', actions, offline: false };
}

// ---------- Offline fallback ----------
function offlineAgent(messages, currentUser) {
  const q = (messages[messages.length - 1] || {}).content || '';
  const ql = String(q).toLowerCase();
  const fmt = (n) => Math.round(n * 10) / 10;
  let reply;

  if (/overdue|försenad/.test(ql)) {
    const { tickets } = toolImpls.query_tickets({ overdue: true });
    reply = tickets.length
      ? `**${tickets.length} overdue tickets:**\n` + tickets.map((t) => `- **${t.key}** ${t.title} — ${t.assignee || 'Unassigned'}, due ${t.deadline} (${t.priority})`).join('\n')
      : 'No overdue tickets. 🎉';
  } else if (/missing|saknar|not logged|gaps/.test(ql)) {
    const { missing } = toolImpls.missing_reports({ days: 7 });
    reply = missing.length
      ? `**Missing time reports (last 7 days):**\n` + missing.map((m) => `- **${m.name}**: ${m.missing_days.length} day(s) — ${m.missing_days.join(', ')}`).join('\n')
      : 'Everyone has logged time on every workday in the last 7 days. 👏';
  } else if (/workload|capacity|busiest|utilization/.test(ql)) {
    const { users } = toolImpls.get_workload();
    reply = '**Workload (last 7 days):**\n' + users.map((u) => `- **${u.name}** (${u.team || '—'}): ${u.open_tickets} open tickets, ~${fmt(u.estimated_open_hours)}h estimated, ${fmt(u.hours_last_7_days)}h logged`).join('\n');
  } else if (/blocked/.test(ql)) {
    const { tickets } = toolImpls.query_tickets({ status: 'blocked' });
    reply = tickets.length
      ? `**Blocked tickets:**\n` + tickets.map((t) => `- **${t.key}** ${t.title} — ${t.assignee || 'Unassigned'}`).join('\n')
      : 'No blocked tickets.';
  } else if (/report/.test(ql)) {
    reply = 'I can generate these reports (open the **Reports** page for Excel/PDF downloads): individual, team, project, tickets, roadmap, time period, missing time reports, workload & capacity.';
  } else if (/project|roadmap|progress/.test(ql)) {
    const { projects } = toolImpls.get_projects();
    reply = '**Project status:**\n' + projects.map((p) => `- **${p.name}** (${p.status}, ${p.priority}): ${p.progress_pct}% done, ${fmt(p.logged_hours)}h logged, deadline ${p.deadline || '—'}`).join('\n');
  } else if (/team.*(work|hours|last week)|last week/.test(ql)) {
    const from = new Date(); from.setDate(from.getDate() - 7);
    const teamMatch = (ql.match(/team\s+(\w+)/) || [])[1];
    const agg = toolImpls.query_time({ team: teamMatch, from: from.toISOString().slice(0, 10) });
    reply = `**Last 7 days${teamMatch ? ` — team ${teamMatch}` : ''}:** ${fmt(agg.total_hours)}h across ${agg.entry_count} entries.\n**By project:** ` +
      Object.entries(agg.by_project).map(([k, v]) => `${k}: ${fmt(v)}h`).join(', ');
  } else {
    reply = `I'm running in **offline mode** (no AI provider connected), so I can answer common questions directly from the database:\n` +
      `- "Which tickets are overdue?"\n- "Who is missing time reports?"\n- "Show team workload"\n- "Which tickets are blocked?"\n- "Project status" / "roadmap progress"\n- "What did team Platform work on last week?"\n\n` +
      `To unlock the full AI assistant (natural-language ticket creation, summaries, roadmap suggestions), a manager can connect **OpenAI or Anthropic** with an API key on the **Integrations** page.`;
  }
  return { reply, actions: [], offline: true };
}

async function aiChat(messages, userId) {
  const currentUser = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  const cfg = getAiConfig();
  const sig = cfgSignature(cfg);
  if (authFailedFor === sig) return offlineAgent(messages, currentUser); // this exact config already failed auth
  try {
    return await runAgent(cfg, messages, currentUser);
  } catch (e) {
    const isAuth = e.aiKind === 'auth'
      || /authentication method|apiKey or authToken/i.test(e.message || '') // Anthropic SDK with no credentials at all
      || e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError;
    if (isAuth) {
      authFailedFor = sig; // don't retry until the key is changed on the Integrations page
      const r = offlineAgent(messages, currentUser);
      if (cfg.api_key) r.reply = `_(The ${cfg.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key was rejected — check it on the Integrations page.)_\n\n` + r.reply;
      return r;
    }
    if (e.aiKind === 'connection' || e instanceof Anthropic.APIConnectionError) {
      const r = offlineAgent(messages, currentUser);
      r.reply = `_(Could not reach the ${cfg.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API — answering in offline mode.)_\n\n` + r.reply;
      return r;
    }
    if (e.aiKind === 'rate' || e instanceof Anthropic.RateLimitError) {
      return { reply: 'The AI service is rate-limited right now. Please try again in a minute.', actions: [], offline: false };
    }
    throw e;
  }
}

module.exports = { aiChat, toolImpls }; // toolImpls exported for tests
