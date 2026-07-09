// Minimal iCalendar (.ics) parser — enough to pull calendar events out of a Google
// Calendar "secret address in iCal format" feed. No external dependencies.
// Returns timed VEVENTs; all-day events and (for now) recurring events are reported
// separately rather than expanded.

const unescapeText = (s) => s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

// Parse an iCal DATE or DATE-TIME value into { ms, allDay }.
//  20260709T140000Z  → UTC datetime · 20260709T140000 → floating (treated as local)
//  20260709          → all-day date
function parseDt(value, params) {
  const allDay = params.some((p) => /VALUE=DATE$/i.test(p)) || /^\d{8}$/.test(value);
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0', ss = '0', z] = m;
  const n = (x) => parseInt(x, 10);
  const ms = z
    ? Date.UTC(n(y), n(mo) - 1, n(d), n(hh), n(mm), n(ss))
    : new Date(n(y), n(mo) - 1, n(d), n(hh), n(mm), n(ss)).getTime();
  return { ms, allDay };
}

function parseIcs(text) {
  // RFC 5545 line unfolding: continuation lines begin with a space or tab
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n|\r/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.summary !== undefined && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const [name, ...params] = line.slice(0, idx).split(';');
    const val = line.slice(idx + 1);
    if (name === 'SUMMARY') cur.summary = unescapeText(val);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(val);
    else if (name === 'LOCATION') cur.location = unescapeText(val);
    else if (name === 'UID') cur.uid = val;
    else if (name === 'URL') cur.url = val;                       // link to the event itself
    else if (name === 'X-GOOGLE-CONFERENCE') cur.conference = val; // Google Meet link
    else if (name === 'RRULE') cur.recurring = true;
    else if (name === 'DTSTART') cur.start = parseDt(val, params);
    else if (name === 'DTEND') cur.end = parseDt(val, params);
  }
  return events;
}

module.exports = { parseIcs };
