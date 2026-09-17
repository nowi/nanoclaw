/**
 * Result compaction for the BusyCal gateway.
 *
 * The bridge returns every event twice (text + structuredContent) with ~22
 * fields each — internal ids, Core Data URIs, four time-zone identifiers,
 * full attendee records and multi-KB invitation notes. One day of a busy
 * calendar is ~70 KB ≈ 20K tokens, which blows up the agent's context after
 * a couple of questions. This module rewrites tool results into what an
 * assistant actually needs, with calendar *names* and Europe/Berlin times.
 */

const NOTES_MAX = 240;
const ATTENDEES_MAX = 12;

/** "2026-09-17T08:00:00Z" → "2026-09-17T10:00:00+02:00" in the given zone. */
export function toLocal(iso, timeZone) {
  if (typeof iso !== 'string' || !iso) return iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso; // date-only (all-day)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function person(p) {
  if (!p) return undefined;
  const who = p.person ?? p;
  const name = who.name || who.displayName;
  const email = who.email;
  const base = name && email ? `${name} <${email}>` : name || email;
  if (!base) return undefined;
  return p.status && p.status !== 'accepted' ? `${base} (${p.status})` : base;
}

function clip(text, max) {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function compactEvent(e, calendarTitles, timeZone, calendarAccounts) {
  const out = {
    title: e.title,
    start: toLocal(e.startDate, timeZone),
    end: toLocal(e.endDate, timeZone),
    calendar: calendarTitles.get(e.calendarID) ?? e.calendarID,
  };
  const account = calendarAccounts?.get(e.calendarID);
  if (account) out.account = account;
  if (e.isAllDay) out.allDay = true;
  if (e.showAs && e.showAs !== 'busy') out.showAs = e.showAs;
  if (e.eventStatus && e.eventStatus !== 'confirmed') out.status = e.eventStatus;
  if (e.isRecurring) out.recurring = true;
  const loc = typeof e.location === 'string' ? e.location : e.location?.title || e.location?.address;
  if (loc) out.location = clip(loc, 120);
  const org = person(e.organizer);
  if (org) out.organizer = org;
  if (Array.isArray(e.attendees) && e.attendees.length > 0) {
    const names = e.attendees.map(person).filter(Boolean);
    out.attendees = names.slice(0, ATTENDEES_MAX);
    if (names.length > ATTENDEES_MAX) out.attendees.push(`… +${names.length - ATTENDEES_MAX} more`);
  }
  const notes = clip(e.notes, NOTES_MAX);
  if (notes) out.notes = notes;
  if (Array.isArray(e.alarms) && e.alarms.length > 0) out.alarms = e.alarms;
  return out;
}

export function compactTask(t, calendarTitles, timeZone) {
  const out = { title: t.title, calendar: calendarTitles.get(t.calendarID) ?? t.calendarID };
  if (t.dueDate) out.due = toLocal(t.dueDate, timeZone);
  if (t.isCompleted || t.completed) out.completed = true;
  if (t.priority) out.priority = t.priority;
  const notes = clip(t.notes, NOTES_MAX);
  if (notes) out.notes = notes;
  return out;
}

export function compactCalendar(c, accountTitles) {
  const out = { calendarID: c.calendarID, title: c.title, account: accountTitles.get(c.accountID) ?? c.accountID };
  if (c.isWritable === false) out.readOnly = true;
  if (c.supportsEvents === false) out.events = false;
  if (c.supportsTasks) out.tasks = true;
  if (c.isSubscribed === false) out.hidden = true;
  return out;
}

/**
 * Rewrite a tools/call result. `ctx` = { calendarTitles, accountTitles, calendarAccounts, timeZone }.
 * Unknown shapes pass through untouched (minus the duplicate structuredContent).
 */
export function compactResult(toolName, result, ctx) {
  if (!result || result.isError) return result;
  const payload = result.structuredContent?.result ?? result.structuredContent;
  let compact;
  switch (toolName) {
    case 'query_events':
    case 'selected_items':
      compact = Array.isArray(payload) ? payload.map((e) => compactEvent(e, ctx.calendarTitles, ctx.timeZone, ctx.calendarAccounts)) : payload;
      break;
    case 'query_items':
      compact = Array.isArray(payload)
        ? payload.map((it) => (it.dueDate !== undefined || it.isCompleted !== undefined ? compactTask(it, ctx.calendarTitles, ctx.timeZone) : compactEvent(it, ctx.calendarTitles, ctx.timeZone, ctx.calendarAccounts)))
        : payload;
      break;
    case 'query_tasks':
      compact = Array.isArray(payload) ? payload.map((t) => compactTask(t, ctx.calendarTitles, ctx.timeZone)) : payload;
      break;
    case 'list_calendars':
      compact = Array.isArray(payload) ? payload.map((c) => compactCalendar(c, ctx.accountTitles)) : payload;
      break;
    case 'create_event':
      compact = payload && typeof payload === 'object' && !Array.isArray(payload) ? compactEvent(payload, ctx.calendarTitles, ctx.timeZone, ctx.calendarAccounts) : payload;
      break;
    default:
      compact = payload;
  }
  if (compact === undefined) return result;
  const text = JSON.stringify(compact);
  return { content: [{ type: 'text', text }] };
}
