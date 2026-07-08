// Ticket workflow statuses. Six built-in statuses exist everywhere; projects can
// add custom ones (stored in project_statuses). Every custom status has a
// category — 'open' or 'done' — so reporting knows whether tickets in it count
// as completed. The IS_DONE/NOT_DONE SQL fragments encapsulate that check.
const DEFAULT_STATUSES = [
  { key: 'backlog', label: 'Backlog', category: 'open', sort_order: 10 },
  { key: 'todo', label: 'Todo', category: 'open', sort_order: 20 },
  { key: 'in_progress', label: 'In Progress', category: 'open', sort_order: 30 },
  { key: 'in_review', label: 'In Review', category: 'open', sort_order: 40 },
  { key: 'done', label: 'Done', category: 'done', sort_order: 60 },
  { key: 'blocked', label: 'Blocked', category: 'open', sort_order: 70 },
];

// `a` is the tickets table alias in the surrounding query
const IS_DONE = (a = 'k') => `(${a}.status = 'done' OR EXISTS (SELECT 1 FROM project_statuses ps WHERE ps.project_id = ${a}.project_id AND ps.key = ${a}.status AND ps.category = 'done'))`;
const NOT_DONE = (a = 'k') => `NOT ${IS_DONE(a)}`;

const statusSlug = (label) => String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

module.exports = { DEFAULT_STATUSES, IS_DONE, NOT_DONE, statusSlug };
