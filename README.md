# ⏱️ TimePort

A self-contained time reporting & project management platform with an AI assistant.
Node.js + Express + SQLite (better-sqlite3) backend, zero-build vanilla-JS frontend,
Excel/PDF export, Linear CSV import, and an Anthropic-powered AI agent.

## Quick start

Requires **Node.js 18+** (better-sqlite3 ships prebuilt binaries for current LTS versions).

```
npm install
npm start          # → http://localhost:3020
```

The database starts **empty**: on first visit the app shows a one-time setup screen
where you create the admin account, then you invite the rest of the team from inside
the app. Set `PORT` to change the port.

Optional — demo data for local development:

```
npm run seed       # wipe the database and fill it with demo teams/projects/tickets
```

Seeding never happens automatically, so a deployed instance always starts clean.
All seeded demo users have the password **`timeport`** (e.g. `maria@example.com`).

Optional — enable the full AI assistant:

```
set ANTHROPIC_API_KEY=sk-ant-...   (then restart)
```

Without a key, the assistant runs in **offline mode** and still answers the most common
questions (overdue tickets, missing reports, workload, project status) directly from the database.

## Deploying to production (Render)

The app stores everything — the SQLite database and uploaded files — under a data
directory, so production needs a **persistent disk**; otherwise a redeploy wipes all data.
The included [`render.yaml`](render.yaml) blueprint handles this:

1. Render dashboard → **New → Blueprint** → point it at this repo.
2. It provisions a **Starter** web service (persistent disks aren't available on Free)
   with a 1 GB disk mounted at `/var/data`, and sets `DATA_DIR=/var/data` so the
   database and uploads live on the disk.
3. On first load, open the site and complete the one-time admin setup, then invite your team.

Notes:
- **`DATA_DIR`** (env var) — where the SQLite file and `uploads/` live. Defaults to `./data`
  locally; set to the mounted disk path in production.
- **Single instance only** — SQLite is one file on one disk, so don't enable horizontal
  scaling. Fine for a single-team workload.
- **AI**: set `ANTHROPIC_API_KEY` in the Render dashboard, or connect OpenAI/Anthropic on
  the in-app Integrations page (stored in the database, so it persists on the disk).
- HTTPS + `trust proxy` are already configured, so session cookies get the `Secure` flag
  automatically behind Render's TLS proxy.

---

## Modules & pages

| Page | What it does |
|---|---|
| **Dashboard** | KPIs (hours this week/month, active projects, open/overdue/blocked tickets), roadmap progress bars, missing time reports, individual + team workload, recent activity feed |
| **Projects** | Card grid with progress; detail view with milestones (click → to advance status), tickets, edit/delete, per-project custom ticket statuses, per-project Excel/PDF export |
| **Tickets** | Kanban board with drag-&-drop status changes **and** list view; filters (search, project, assignee, team, priority, label, overdue); ticket detail with comments, activity history, time log, attachments, inline status/assignee/priority/deadline editing; ⭐ star tickets to pin them in the sidebar |
| **Roadmap** | Interactive Gantt timeline with a year selector (All time / per year): one bar per project (fill = % done), milestone diamonds colored by status, red "today" line. Drag a bar to move the project in time, drag its edges to change start/deadline, drag the project label up/down to reorder — all persisted. Milestone table + roadmap health panel |
| **Time** | Two views: **My time** — quick-log form (ticket picker grouped by project), personal 7-day view with missing-day flags, entry table; **Analytics** (for management, deep-linkable via `#/time?tab=analytics`) — filter by period/team/person/project and see logged-vs-capacity per person with utilization %, task comparison (estimated vs logged per ticket, red when over estimate), hours by project/category, daily trend, and export buttons that target exactly the current selection |
| **Reports** | 8 report types with live preview and one-click **Excel + PDF** download |
| **AI Assistant** | Chat with suggestion chips; creates tickets, summarizes work, finds gaps, generates report links |

## Authentication & permissions

The workspace requires sign-in: session cookies (httpOnly, 30 days), scrypt-hashed
passwords, and an auth guard on every API route. While the database has no users,
the login page shows a **first-run setup** form that creates the admin account;
after that, new accounts are created only through invites.

**Invites:** managers/admins click **+ Invite** in the sidebar → enter email, role
and team → get a one-time link (`/#/join?token=…`) to send to the person, who picks
their own name and password. Pending invites can be copied again or revoked.

Enforced roles: managers/admins can invite people, manage integrations, and
approve/reject/reopen time; members can only edit/delete their own time entries,
and approved entries are locked for them. Every ticket action (create, status
change, comment, upload) is attributed to the signed-in user.

## Smart time capture

- **Timer** — ▶ Start timer on any ticket; a live clock runs in the sidebar; ■ Stop
  asks what you did and logs the exact duration. Starting a new timer auto-logs the old one.
- **Week grid** (Time → Week grid) — spreadsheet view, your tickets × Mon–Sun; type
  hours into cells, saved instantly; 🔒 marks approved/locked cells; ⧉ Copy last week
  duplicates the previous week's entries.
- **Smart suggestions** — if you changed/commented tickets yesterday but logged no
  time on them (or logged nothing at all), a banner on Time offers one-click prefill.
- **Approvals** (Time → Approvals, managers) — per person per week: approve (locks),
  reject (sends back for fixing; editing a rejected entry resubmits it), or reopen.

## Custom ticket statuses

Six built-in statuses (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`)
exist everywhere; each project can add its own (e.g. "QA", "Shipped"). Every custom
status has a **category** — `open` or `done` — so boards, dashboards, roadmap progress
and reports all know whether tickets in it count as completed.

## Import & integrations

- **Linear CSV import** (`POST /api/import/linear`) — upload Linear's issue export
  (Jira's CSV export is recognized too). Original created/updated timestamps from the
  export are preserved on the imported tickets. The upload opens an **interactive preview**:
  every row is listed with its mapped status, priority, estimate, deadline and creation date, and you
  choose exactly what happens — tick/untick rows (select all, then deselect), set the
  assignee and project per ticket or for all selected at once, and create new projects
  on the fly. Idempotent: imported tickets are tagged with a `linear:<ID>` label that
  skips duplicates on re-import.
- **Integrations page** — workspace-level connection settings for Linear, Jira and
  Gmail (config templates; secrets are stored server-side and masked in API
  responses). Managing integrations requires the manager/admin role.
- **Google Calendar (per-user)** — each user connects their **own** calendar in
  **Settings** by pasting its secret iCal (.ics) URL (stored server-side, never
  returned to the client). Their meetings then appear on **Time → Calendar**, where
  each can be logged as a "meetings" time entry or turned into a ticket (pre-filled
  with the meeting's title, notes, link, and the user as assignee). Read-only;
  recurring events aren't expanded yet.

## User flows

- **Log time**: Time → pick date/hours → optionally pick a ticket (project auto-fills) → Log. Missing workdays are flagged in your 7-day view and on the manager dashboard.
- **Run a sprint**: Tickets board → drag cards between columns (activity is recorded) → click a card to comment, attach files, adjust deadline/assignee inline.
- **Plan**: Projects → New project → open it → add milestones → add tickets. Roadmap shows the whole picture with at-risk milestones in red.
- **Report**: Reports → choose type + filters → Generate (preview) → download Excel or PDF. Or ask the AI: *"generate a workload report"* — it returns download links.
- **AI ticket**: AI Assistant → *"Create a ticket: the login page spinner never stops on Safari"* → the agent writes a title/description with acceptance criteria, checks team workload + skills, assigns the best-fit least-loaded person, and confirms the created key.

## Database models (SQLite, `data/timeport.db`)

```
teams(id, name, description, color)
users(id, name, email, role[admin|manager|member], team_id, skills, capacity_hours, color, active)
projects(id, name, description, owner_id, team_id, start_date, deadline,
         status[planning|active|on_hold|completed|cancelled], priority, created_at)
milestones(id, project_id, name, description, due_date,
           status[planned|in_progress|completed|at_risk], sort_order)
tickets(id, key TP-###, title, description, project_id, milestone_id, assignee_id, team_id,
        status[built-in or per-project custom], priority[low|medium|high|urgent],
        estimate_hours, deadline, labels, created_by, created_at, updated_at)
project_statuses(id, project_id, key, label, category[open|done], color, sort_order)
comments(id, ticket_id, user_id, body, created_at)
activity(id, ticket_id, user_id, type[created|status|priority|assignee|deadline|comment|attachment], detail, created_at)
attachments(id, ticket_id, filename, stored_name, size, uploaded_by, created_at)   -- files in data/uploads/
time_entries(id, user_id, ticket_id, project_id,
             category[development|design|meetings|planning|support|testing|documentation|other],
             date, hours(0–24), description, status[draft|submitted|approved|rejected], created_at)
timers(id, user_id, ticket_id, started_at)
sessions(id, token, user_id, created_at, expires_at)
invites(id, token, email, role, team_id, invited_by, created_at, used_at)
integrations(id, provider[linear|jira|gmail|gcal], config JSON, enabled, connected_by, updated_at)
starred_tickets(user_id, ticket_id, created_at)
```

Status/assignee/priority/deadline changes on tickets are automatically written to `activity`.

## REST API

All routes except `/api/auth/*` require a session cookie.

```
POST /api/auth/setup                   first-run admin creation (only while no users exist)
POST /api/auth/login /api/auth/logout /api/auth/join
GET  /api/auth/me /api/auth/invite-info /api/auth/needs-setup
CRUD /api/invites                      (manager/admin)
GET  /api/meta                         enums for the UI
CRUD /api/teams /api/users /api/projects /api/milestones /api/tickets /api/time-entries
GET  /api/users/:id/profile            user profile + stats
GET  /api/projects/:id                 project + milestones + tickets
GET  /api/tickets?project_id&assignee_id&team_id&status&priority&q&overdue=1
GET  /api/tickets/:id                  ticket + comments + activity + attachments + time
POST /api/tickets/:id/comments         add comment
POST /api/tickets/:id/attachments      multipart upload (20 MB max)
GET  /api/attachments/:id/download
GET  /api/statuses                     built-in + custom statuses per project
POST /api/projects/:id/statuses        add custom status; DELETE /api/project-statuses/:id
GET  /api/labels                       distinct labels with usage counts
GET/POST/DELETE /api/stars[/:ticketId] starred tickets (per user)
CRUD /api/integrations/:provider       (manager/admin; secrets masked on read)
POST /api/import/linear                Linear CSV upload (dry_run=1 for preview)
GET/POST /api/timer /api/timer/start /api/timer/stop
POST /api/timesheet/set /api/timesheet/copy-last-week
GET  /api/time-suggestions
GET/POST /api/approvals                (manager/admin)
GET  /api/time-analytics
GET  /api/dashboard                    all dashboard aggregates
GET  /api/reports/:type                report JSON (types below)
GET  /api/export/excel/:type?…         same params → .xlsx
GET  /api/export/pdf/:type?…           same params → .pdf
POST /api/ai/chat                      { messages } → { reply, actions, offline }
```

## Reports & export logic

Report types: `user`, `team`, `project`, `tickets`, `roadmap`, `time`, `missing`, `workload`.

Every report is built once in `lib/reports.js` as a **generic shape**
(`title / subtitle / summary cards / charts / sections of columns+rows`). The Excel exporter
(`exceljs`) renders each section as a styled worksheet (frozen header, autofilter,
brand colors) plus a Summary sheet and a **Charts sheet** with in-cell data bars;
the PDF exporter (`pdfkit`) renders branded summary cards, **vector bar charts**
(hours per person/project/category, estimated-vs-logged per task) and zebra-striped
tables with page numbers. Adding a new report type automatically makes it exportable
in both formats — no exporter changes needed.

The PDF **project** and **user** reports are the "full detail" reports: milestones,
every ticket with status/assignee/deadline, all logged time, and summaries.

## AI agent behavior (`lib/ai.js`)

- Providers: **Anthropic** (`claude-opus-4-8` with adaptive thinking, via the official `@anthropic-ai/sdk`)
  or **OpenAI** (`gpt-4o` via the chat-completions API) — connect either with an API key on the
  Integrations page (manager/admin); the most recently saved provider wins.
- Manual tool-use loop (max 8 rounds) over 8 database-backed tools:
  `query_tickets`, `query_time`, `get_projects`, `get_workload`, `missing_reports`,
  `create_project`, `create_ticket`, `generate_report`.
- The system prompt injects today's date and the signed-in user, and instructs the agent to
  ground every answer in tool results, assign tickets by skills + lowest load, and always
  return Excel/PDF links as markdown when generating reports.
- Typed error handling: auth failures switch permanently to offline mode for the session;
  connection failures answer offline with a notice; rate limits return a friendly retry message.
- Credentials resolve from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.

## Project structure

```
server.js        Express app: auth, all REST routes, uploads, exports
db.js            schema, migrations, demo seed (npm run seed)
lib/ai.js        AI agent (tool loop, offline fallback)
lib/reports.js   report builders (generic report shape)
lib/exports.js   Excel + PDF renderers
lib/importer.js  Linear CSV import (parser, dry-run, dedup)
lib/status.js    built-in + custom ticket status logic
lib/pw.js        scrypt password hashing, session tokens
lib/text.js      text normalization helpers
public/          zero-build frontend (index.html, app.js, styles.css)
data/            SQLite database + uploaded files (created at runtime, not committed)
```
