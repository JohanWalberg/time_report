// Report builders. Every report returns the same generic shape so the Excel
// and PDF exporters can render any report type without per-type code:
// { title, subtitle, generated_at, summary: [{label, value}], sections: [{heading, columns: [{key,label,width?}], rows: [..]}] }
const db = require('../db');
const { IS_DONE } = require('./status');

const REPORT_TYPES = ['user', 'team', 'project', 'tickets', 'roadmap', 'time', 'missing', 'workload'];

const fmtH = (n) => Math.round((n || 0) * 10) / 10;
const today = () => new Date().toISOString().slice(0, 10);

function defaultRange(q) {
  const to = q.to || today();
  const from = q.from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return { from, to };
}

function timeRows(where, params) {
  return db.prepare(`
    SELECT e.date, e.hours, e.category, e.status, e.description,
      u.name AS user_name, k.key AS ticket_key, k.title AS ticket_title, p.name AS project_name
    FROM time_entries e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN tickets k ON k.id = e.ticket_id
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE ${where} ORDER BY e.date DESC`).all(...params);
}

const TIME_COLS = [
  { key: 'date', label: 'Date', width: 12 },
  { key: 'user_name', label: 'User', width: 18 },
  { key: 'project_name', label: 'Project', width: 22 },
  { key: 'ticket_key', label: 'Ticket', width: 10 },
  { key: 'category', label: 'Category', width: 14 },
  { key: 'hours', label: 'Hours', width: 8 },
  { key: 'status', label: 'Status', width: 11 },
  { key: 'description', label: 'Description', width: 40 },
];
const TICKET_COLS = [
  { key: 'key', label: 'Key', width: 10 },
  { key: 'title', label: 'Title', width: 38 },
  { key: 'project_name', label: 'Project', width: 20 },
  { key: 'assignee_name', label: 'Assignee', width: 18 },
  { key: 'status', label: 'Status', width: 12 },
  { key: 'priority', label: 'Priority', width: 10 },
  { key: 'estimate_hours', label: 'Est. h', width: 8 },
  { key: 'logged_hours', label: 'Logged h', width: 10 },
  { key: 'deadline', label: 'Deadline', width: 12 },
  { key: 'link', label: 'Link', width: 34 },
];

function ticketRows(where, params) {
  return db.prepare(`
    SELECT k.key, k.title, k.status, k.priority, k.estimate_hours, k.deadline, k.labels, k.link, ${IS_DONE('k')} AS is_done,
      u.name AS assignee_name, p.name AS project_name, t.name AS team_name,
      (SELECT COALESCE(SUM(hours),0) FROM time_entries e WHERE e.ticket_id = k.id) AS logged_hours
    FROM tickets k
    LEFT JOIN users u ON u.id = k.assignee_id
    LEFT JOIN projects p ON p.id = k.project_id
    LEFT JOIN teams t ON t.id = k.team_id
    ${where}
    ORDER BY CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, k.deadline`).all(...params);
}

const { capFirst, prettyKey } = require('./text');
function groupSum(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = capFirst(keyFn(r) || '—');
    map.set(k, (map.get(k) || 0) + r.hours);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, h]) => ({ group: k, hours: fmtH(h) }));
}

// Charts: rendered as bar charts in the PDF export, as data-bar sheets in Excel,
// and as CSS bars in the web preview. Shape: {heading, series: [names], rows: [{label, values: []}]}
const singleChart = (heading, groups, seriesName = 'Hours') =>
  ({ heading, series: [seriesName], rows: groups.map((g) => ({ label: g.group, values: [g.hours] })) });
// Weekly effort trend — rendered as a column chart (type: 'columns')
function weeklyTrendChart(entries, heading = 'Effort over time — hours per week') {
  const weeks = new Map();
  for (const e of entries) {
    const d = new Date(e.date + 'T12:00');
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = monday.toISOString().slice(0, 10);
    weeks.set(k, (weeks.get(k) || 0) + e.hours);
  }
  const rows = [...weeks.entries()].sort().map(([k, h]) => ({ label: 'w/c ' + k.slice(5), values: [fmtH(h)] }));
  return {
    heading, type: 'columns', series: ['Hours'], rows,
    note: 'Each column is one week (w/c = week commencing) and its height is the total hours logged that week. A rising curve means effort is increasing; dips often mean holidays or missing time reports.',
  };
}

// Where does the effort go? Estimated vs logged hours per workflow status
function statusEffortChart(tickets, heading = 'Effort by status — estimated vs logged hours') {
  const m = new Map();
  for (const t of tickets) {
    const k = prettyKey(t.status);
    const cur = m.get(k) || [0, 0];
    cur[0] += t.estimate_hours || 0;
    cur[1] += t.logged_hours || 0;
    m.set(k, cur);
  }
  return {
    heading, series: ['Estimated h', 'Logged h'],
    rows: [...m.entries()].filter(([, v]) => v[0] || v[1]).sort((a, b) => b[1][1] - a[1][1])
      .map(([k, v]) => ({ label: k, values: [fmtH(v[0]), fmtH(v[1])] })),
    note: 'Where the effort currently sits in the workflow. For the tickets in each status: grey = hours originally estimated, colored = hours actually logged. Large logged bars in early statuses (e.g. in progress) can signal work that is stuck.',
  };
}

// Completed vs in-flight effort — the "how much is actually done" view
function completionChart(tickets, heading = 'Effort done vs remaining — completed vs open tickets') {
  const sum = (list, f) => fmtH(list.reduce((s, t) => s + (f(t) || 0), 0));
  const done = tickets.filter((t) => t.is_done), open = tickets.filter((t) => !t.is_done);
  return {
    heading, series: ['Estimated h', 'Logged h'],
    rows: [
      { label: `Completed (${done.length} tickets)`, values: [sum(done, (t) => t.estimate_hours), sum(done, (t) => t.logged_hours)] },
      { label: `Open (${open.length} tickets)`, values: [sum(open, (t) => t.estimate_hours), sum(open, (t) => t.logged_hours)] },
    ],
    note: 'How much of the work is actually finished. "Completed" covers tickets in a done-type status, "Open" everything still in flight. Grey = estimated hours, colored = hours logged so far. If the open row dwarfs the completed row, most of the effort is still ahead.',
  };
}

const ticketCompareChart = (tickets, heading = 'Task comparison — estimated vs logged hours') => ({
  heading,
  series: ['Estimated h', 'Logged h'],
  rows: tickets
    .filter((t) => (t.estimate_hours || 0) > 0 || (t.logged_hours || 0) > 0)
    .sort((a, b) => (b.logged_hours || 0) - (a.logged_hours || 0))
    .slice(0, 15)
    .map((t) => ({ label: `${t.key} ${t.title.slice(0, 34)}`, values: [fmtH(t.estimate_hours || 0), fmtH(t.logged_hours || 0)] })),
  note: 'One row per ticket, sorted by logged time (top 15). Grey = the original estimate, colored = hours actually logged. A colored bar clearly longer than its grey bar means the task has exceeded its estimate and may need re-planning.',
});

const builders = {
  user(q) {
    const { from, to } = defaultRange(q);
    const user = db.prepare('SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?').get(q.user_id);
    if (!user) throw new Error('user_id is required and must exist');
    const entries = timeRows('e.user_id = ? AND e.date BETWEEN ? AND ?', [user.id, from, to]);
    const tickets = ticketRows('WHERE k.assignee_id = ?', [user.id]);
    const total = entries.reduce((s, e) => s + e.hours, 0);
    const days = new Set(entries.map((e) => e.date)).size;
    // work done outside the ticket system, logged as weekly highlights
    const highlights = db.prepare('SELECT week, body FROM highlights WHERE user_id = ? AND week BETWEEN ? AND ? ORDER BY week DESC, id')
      .all(user.id, from, to).map((h) => ({ week: `Week of ${h.week}`, body: h.body }));
    return {
      title: `Individual report — ${user.name}`,
      description: 'This report shows one person\'s effort: how many hours they logged in the period, where the time went (projects and work categories), and the state of their assigned tickets. Read the weekly trend for workload over time, and the task comparison to spot tickets running over their estimate. Utilization compares logged hours against the person\'s weekly capacity.',
      subtitle: `${user.team_name || 'No team'} · ${from} to ${to}`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Total hours', value: fmtH(total) },
        { label: 'Days with entries', value: days },
        { label: 'Avg hours/day', value: days ? fmtH(total / days) : 0 },
        { label: 'Open tickets', value: tickets.filter((t) => !t.is_done).length },
        { label: 'Weekly capacity', value: user.capacity_hours },
      ],
      charts: [
        weeklyTrendChart(entries, `Effort over time — ${user.name}'s hours per week`),
        completionChart(tickets),
        singleChart('Hours by project', groupSum(entries, (e) => e.project_name)),
        singleChart('Hours by category', groupSum(entries, (e) => e.category)),
        statusEffortChart(tickets),
        ticketCompareChart(tickets, `Task comparison — ${user.name}'s tickets (estimated vs logged)`),
      ],
      sections: [
        ...(highlights.length ? [{ heading: 'Weekly highlights — work outside the ticket system', columns: [{ key: 'week', label: 'Week', width: 18 }, { key: 'body', label: 'Highlight', width: 70 }], rows: highlights }] : []),
        { heading: 'Hours by project', columns: [{ key: 'group', label: 'Project', width: 30 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.project_name) },
        { heading: 'Hours by category', columns: [{ key: 'group', label: 'Category', width: 30 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.category) },
        { heading: 'Assigned tickets', columns: TICKET_COLS, rows: tickets },
        { heading: 'Time log', columns: TIME_COLS, rows: entries },
      ],
    };
  },

  team(q) {
    const { from, to } = defaultRange(q);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(q.team_id);
    if (!team) throw new Error('team_id is required and must exist');
    const members = db.prepare('SELECT * FROM users WHERE team_id = ? AND active = 1').all(team.id);
    const entries = timeRows('u.team_id = ? AND e.date BETWEEN ? AND ?', [team.id, from, to]);
    const tickets = ticketRows('WHERE k.team_id = ?', [team.id]);
    const total = entries.reduce((s, e) => s + e.hours, 0);
    const perMember = members.map((m) => {
      const mine = entries.filter((e) => e.user_name === m.name);
      const h = mine.reduce((s, e) => s + e.hours, 0);
      return {
        name: m.name, hours: fmtH(h),
        open_tickets: tickets.filter((t) => t.assignee_name === m.name && !t.is_done).length,
        capacity: m.capacity_hours,
        utilization: m.capacity_hours ? Math.round((h / ((m.capacity_hours / 5) * workdaysBetween(from, to))) * 100) + '%' : '—',
      };
    });
    return {
      title: `Team report — ${team.name}`,
      description: 'This report shows the combined effort of the team: total hours in the period, how work is spread across members and projects, and the health of the team\'s tickets. Use the hours-by-member chart to spot uneven load, and the effort-by-status chart to see whether work is flowing towards done or piling up mid-workflow.',
      subtitle: `${members.length} members · ${from} to ${to}`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Total hours', value: fmtH(total) },
        { label: 'Members', value: members.length },
        { label: 'Open tickets', value: tickets.filter((t) => !t.is_done).length },
        { label: 'Overdue tickets', value: tickets.filter((t) => t.deadline && t.deadline < today() && !t.is_done).length },
      ],
      charts: [
        weeklyTrendChart(entries, `Effort over time — ${team.name} hours per week`),
        completionChart(tickets),
        singleChart('Hours by member', perMember.map((m) => ({ group: m.name, hours: m.hours }))),
        singleChart('Hours by project', groupSum(entries, (e) => e.project_name)),
        singleChart('Hours by category', groupSum(entries, (e) => e.category)),
        statusEffortChart(tickets),
        ticketCompareChart(tickets, `Task comparison — ${team.name} tickets (estimated vs logged)`),
      ],
      sections: [
        { heading: 'Members', columns: [{ key: 'name', label: 'Member', width: 22 }, { key: 'hours', label: 'Hours', width: 10 }, { key: 'open_tickets', label: 'Open tickets', width: 12 }, { key: 'capacity', label: 'Capacity h/w', width: 12 }, { key: 'utilization', label: 'Utilization', width: 12 }], rows: perMember },
        { heading: 'Hours by project', columns: [{ key: 'group', label: 'Project', width: 30 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.project_name) },
        { heading: 'Team tickets', columns: TICKET_COLS, rows: tickets },
        { heading: 'Time log', columns: TIME_COLS, rows: entries },
      ],
    };
  },

  project(q) {
    const project = db.prepare(`SELECT p.*, u.name AS owner_name, t.name AS team_name FROM projects p
      LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = ?`).get(q.project_id);
    if (!project) throw new Error('project_id is required and must exist');
    const tickets = ticketRows('WHERE k.project_id = ?', [project.id]);
    const entries = timeRows('e.project_id = ?', [project.id]);
    const milestones = db.prepare('SELECT name, due_date, status, description FROM milestones WHERE project_id = ? ORDER BY sort_order').all(project.id);
    const est = tickets.reduce((s, t) => s + (t.estimate_hours || 0), 0);
    const logged = entries.reduce((s, e) => s + e.hours, 0);
    const done = tickets.filter((t) => t.is_done).length;
    return {
      title: `Project report — ${project.name}`,
      description: 'This report shows progress and cost of one project: milestone status, every ticket with estimated vs logged hours, and who spent time on it. Progress % counts tickets in a done-type status. Compare estimated against logged hours to judge whether the remaining work fits the deadline.',
      subtitle: `Owner: ${project.owner_name || '—'} · Team: ${project.team_name || '—'} · Deadline: ${project.deadline || '—'} · Status: ${project.status}`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Progress', value: tickets.length ? Math.round((done / tickets.length) * 100) + '%' : '0%' },
        { label: 'Tickets', value: `${done}/${tickets.length} done` },
        { label: 'Estimated hours', value: fmtH(est) },
        { label: 'Logged hours', value: fmtH(logged) },
        { label: 'Overdue tickets', value: tickets.filter((t) => t.deadline && t.deadline < today() && !t.is_done).length },
      ],
      charts: [
        weeklyTrendChart(entries, `Effort over time — ${project.name} hours per week`),
        completionChart(tickets),
        singleChart('Hours by person', groupSum(entries, (e) => e.user_name)),
        singleChart('Hours by category', groupSum(entries, (e) => e.category)),
        statusEffortChart(tickets),
        ticketCompareChart(tickets, `Task comparison — ${project.name} (estimated vs logged)`),
      ],
      sections: [
        { heading: 'Milestones', columns: [{ key: 'name', label: 'Milestone', width: 28 }, { key: 'due_date', label: 'Due', width: 12 }, { key: 'status', label: 'Status', width: 14 }, { key: 'description', label: 'Description', width: 40 }], rows: milestones },
        { heading: 'Tickets', columns: TICKET_COLS, rows: tickets },
        { heading: 'Hours by person', columns: [{ key: 'group', label: 'Person', width: 25 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.user_name) },
        { heading: 'Time log', columns: TIME_COLS, rows: entries },
      ],
    };
  },

  tickets(q) {
    const clauses = [], params = [];
    if (q.project_id) { clauses.push('k.project_id = ?'); params.push(q.project_id); }
    if (q.team_id) { clauses.push('k.team_id = ?'); params.push(q.team_id); }
    if (q.assignee_id) { clauses.push('k.assignee_id = ?'); params.push(q.assignee_id); }
    if (q.status) { clauses.push('k.status = ?'); params.push(q.status); }
    if (q.overdue === '1') clauses.push(`k.deadline < date('now') AND NOT ${IS_DONE('k')}`);
    const rows = ticketRows(clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params);
    return {
      title: 'Ticket report',
      description: 'A snapshot of the selected tickets: status, priority, assignee, deadline and effort. Grey vs colored bars in the charts compare estimated hours against logged hours — tickets whose colored bar exceeds the grey one have gone over their estimate.',
      subtitle: q.overdue === '1' ? 'Overdue tickets only' : 'All tickets matching filters',
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Tickets', value: rows.length },
        { label: 'Open', value: rows.filter((t) => !t.is_done).length },
        { label: 'Blocked', value: rows.filter((t) => t.status === 'blocked').length },
        { label: 'Total estimated h', value: fmtH(rows.reduce((s, t) => s + (t.estimate_hours || 0), 0)) },
        { label: 'Total logged h', value: fmtH(rows.reduce((s, t) => s + (t.logged_hours || 0), 0)) },
      ],
      charts: [completionChart(rows), statusEffortChart(rows), ticketCompareChart(rows)],
      sections: [{ heading: 'Tickets', columns: TICKET_COLS, rows }],
    };
  },

  roadmap() {
    const projects = db.prepare(`
      SELECT p.id, p.name, p.status, p.priority, p.start_date, p.deadline, u.name AS owner_name,
        (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id) AS total,
        (SELECT COUNT(*) FROM tickets k WHERE k.project_id = p.id AND ${IS_DONE('k')}) AS done
      FROM projects p LEFT JOIN users u ON u.id = p.owner_id
      WHERE p.status NOT IN ('cancelled') ORDER BY p.deadline`).all();
    const rows = projects.map((p) => ({
      name: p.name, owner_name: p.owner_name, status: p.status, priority: p.priority,
      start_date: p.start_date, deadline: p.deadline,
      progress: p.total ? Math.round((p.done / p.total) * 100) + '%' : '0%',
    }));
    const milestones = db.prepare(`
      SELECT m.name, m.due_date, m.status, p.name AS project_name FROM milestones m
      JOIN projects p ON p.id = m.project_id ORDER BY m.due_date`).all();
    return {
      title: 'Roadmap report',
      description: 'The high-level plan: every project with owner, timeline and progress, plus all milestones with due dates and status. Milestones marked at risk or past their due date need attention first.',
      subtitle: 'All projects and milestones',
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Projects', value: projects.length },
        { label: 'At-risk milestones', value: milestones.filter((m) => m.status === 'at_risk').length },
        { label: 'Milestones overdue', value: milestones.filter((m) => m.due_date && m.due_date < today() && m.status !== 'completed').length },
      ],
      sections: [
        { heading: 'Projects', columns: [{ key: 'name', label: 'Project', width: 26 }, { key: 'owner_name', label: 'Owner', width: 18 }, { key: 'status', label: 'Status', width: 12 }, { key: 'priority', label: 'Priority', width: 10 }, { key: 'start_date', label: 'Start', width: 12 }, { key: 'deadline', label: 'Deadline', width: 12 }, { key: 'progress', label: 'Progress', width: 10 }], rows },
        { heading: 'Milestones', columns: [{ key: 'project_name', label: 'Project', width: 26 }, { key: 'name', label: 'Milestone', width: 28 }, { key: 'due_date', label: 'Due', width: 12 }, { key: 'status', label: 'Status', width: 14 }], rows: milestones },
      ],
    };
  },

  time(q) {
    const { from, to } = defaultRange(q);
    const entries = timeRows('e.date BETWEEN ? AND ?', [from, to]);
    return {
      title: 'Time period report',
      description: 'All time logged in the selected period, regardless of person or project. The weekly trend shows the overall effort curve; the breakdowns show who logged the hours, on which projects, and what kind of work it was.',
      subtitle: `${from} to ${to}`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'Total hours', value: fmtH(entries.reduce((s, e) => s + e.hours, 0)) },
        { label: 'Entries', value: entries.length },
        { label: 'People logging', value: new Set(entries.map((e) => e.user_name)).size },
      ],
      charts: [
        weeklyTrendChart(entries),
        singleChart('Hours by person', groupSum(entries, (e) => e.user_name)),
        singleChart('Hours by project', groupSum(entries, (e) => e.project_name)),
        singleChart('Hours by category', groupSum(entries, (e) => e.category)),
      ],
      sections: [
        { heading: 'Hours by person', columns: [{ key: 'group', label: 'Person', width: 25 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.user_name) },
        { heading: 'Hours by project', columns: [{ key: 'group', label: 'Project', width: 30 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.project_name) },
        { heading: 'Hours by category', columns: [{ key: 'group', label: 'Category', width: 30 }, { key: 'hours', label: 'Hours', width: 10 }], rows: groupSum(entries, (e) => e.category) },
        { heading: 'Time log', columns: TIME_COLS, rows: entries },
      ],
    };
  },

  missing(q) {
    const days = Math.min(parseInt(q.days || '14', 10), 60);
    const data = missingTimeReports(days);
    const rows = data.map((u) => ({ name: u.name, missing_count: u.missing_days.length, days: u.missing_days.join(', ') }));
    return {
      title: 'Missing time reports',
      description: 'Workdays (Mon-Fri) in the look-back window where a person logged no time at all. Gaps usually mean forgotten reporting rather than absence — follow up before month-end invoicing.',
      subtitle: `Workdays without any logged time, last ${days} days`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'People with gaps', value: rows.length },
        { label: 'Total missing days', value: rows.reduce((s, r) => s + r.missing_count, 0) },
      ],
      sections: [{ heading: 'Missing reports', columns: [{ key: 'name', label: 'Person', width: 22 }, { key: 'missing_count', label: 'Missing days', width: 12 }, { key: 'days', label: 'Dates', width: 70 }], rows }],
    };
  },

  workload(q) {
    const { from, to } = defaultRange(q);
    const wd = workdaysBetween(from, to);
    const users = db.prepare(`
      SELECT u.id, u.name, u.capacity_hours, t.name AS team_name,
        (SELECT COUNT(*) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS open_tickets,
        (SELECT COALESCE(SUM(k.estimate_hours),0) FROM tickets k WHERE k.assignee_id = u.id AND NOT ${IS_DONE('k')}) AS est_open,
        (SELECT COALESCE(SUM(e.hours),0) FROM time_entries e WHERE e.user_id = u.id AND e.date BETWEEN ? AND ?) AS logged
      FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = 1 ORDER BY u.name`).all(from, to);
    const rows = users.map((u) => {
      const capPeriod = (u.capacity_hours / 5) * wd;
      return {
        name: u.name, team_name: u.team_name, open_tickets: u.open_tickets,
        est_open_hours: fmtH(u.est_open), logged_hours: fmtH(u.logged),
        capacity_hours: fmtH(capPeriod),
        utilization: capPeriod ? Math.round((u.logged / capPeriod) * 100) + '%' : '—',
        remaining_load_weeks: u.capacity_hours ? fmtH(u.est_open / u.capacity_hours) : '—',
      };
    });
    return {
      title: 'Workload & capacity report',
      description: 'Compares each person\'s logged hours against their capacity for the period (capacity = weekly hours scaled to the workdays in range). Utilization far below 100% can mean under-reporting or free capacity; far above means overload. Backlog (weeks) estimates how long each person\'s open estimated work would take at full capacity.',
      subtitle: `${from} to ${to} (${wd} workdays)`,
      generated_at: new Date().toISOString(),
      summary: [
        { label: 'People', value: rows.length },
        { label: 'Total open estimated h', value: fmtH(users.reduce((s, u) => s + u.est_open, 0)) },
        { label: 'Total logged h', value: fmtH(users.reduce((s, u) => s + u.logged, 0)) },
      ],
      charts: [{
        heading: 'Capacity vs logged hours per person',
        series: ['Capacity h', 'Logged h'],
        rows: rows.map((r) => ({ label: r.name, values: [r.capacity_hours, r.logged_hours] })),
        note: 'Grey = the hours this person could work in the period (weekly capacity scaled to the workdays in range). Colored = hours actually logged. A colored bar much shorter than the grey one means free capacity or unreported time; longer means overload.',
      }, {
        heading: 'Open estimated hours per person (remaining backlog)',
        series: ['Estimated open h'],
        rows: rows.map((r) => ({ label: r.name, values: [r.est_open_hours] })),
        note: 'The sum of estimates on each person\'s open tickets — the work already on their plate. Compare against weekly capacity to judge how many weeks of backlog each person carries.',
      }],
      sections: [{
        heading: 'Workload per person',
        columns: [
          { key: 'name', label: 'Person', width: 20 }, { key: 'team_name', label: 'Team', width: 14 },
          { key: 'open_tickets', label: 'Open tickets', width: 12 }, { key: 'est_open_hours', label: 'Est. open h', width: 12 },
          { key: 'logged_hours', label: 'Logged h', width: 10 }, { key: 'capacity_hours', label: 'Capacity h', width: 11 },
          { key: 'utilization', label: 'Utilization', width: 11 }, { key: 'remaining_load_weeks', label: 'Backlog (weeks)', width: 14 },
        ],
        rows,
      }],
    };
  },
};

// Workdays in the last N days with no time entry, per user
function missingTimeReports(days) {
  const users = db.prepare('SELECT id, name, color FROM users WHERE active = 1').all();
  const result = [];
  for (const u of users) {
    const logged = new Set(db.prepare(`SELECT DISTINCT date FROM time_entries WHERE user_id = ? AND date >= date('now', ?)`).all(u.id, `-${days} days`).map((r) => r.date));
    const missing = [];
    for (let i = days; i >= 1; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const ds = d.toISOString().slice(0, 10);
      if (!logged.has(ds)) missing.push(ds);
    }
    if (missing.length) result.push({ ...u, missing_days: missing });
  }
  return result;
}

function workdaysBetween(from, to) {
  let n = 0;
  const d = new Date(from), end = new Date(to);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(n, 1);
}

function buildReport(type, query) {
  const builder = builders[type];
  if (!builder) { const e = new Error(`Unknown report type '${type}'. Valid: ${REPORT_TYPES.join(', ')}`); e.status = 400; throw e; }
  return builder(query || {});
}

module.exports = { buildReport, REPORT_TYPES, missingTimeReports };
