/**
 * Shadow copy of the BusyCal MCP bridge with a widened tool contract.
 *
 * The bridge (Claude Desktop extension) maps each MCP tool onto a BusyCal
 * automation command using `tool-metadata.json` next to its executable, and
 * forwards only the parameters listed there. BusyCal itself accepts more than
 * that file declares — `createEvent`/`updateEvent` take a `recurrence` record,
 * and there are `rescheduleEvent` and `getItem` commands with no MCP tool —
 * so the extension's metadata is the only thing standing between the agent
 * and recurring events.
 *
 * We copy the signed binary unchanged (its code signature lives in the Mach-O,
 * so a copy still runs without a TCC prompt) into a gateway-owned directory
 * next to a patched `tool-metadata.json`. Additions are only made when absent,
 * so a future extension that ships these natively wins.
 */
import fs from 'node:fs';
import path from 'node:path';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const intList = (description) => ({ type: 'array', items: { type: 'integer' }, description });

export const RECURRENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frequency'],
  properties: {
    frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'integer', minimum: 1, description: 'Repeat every N periods (default 1). interval 2 + weekly = every other week.' },
    count: { type: 'integer', minimum: 1, description: 'Total number of occurrences. Do not combine with until.' },
    until: {
      type: 'string',
      description: 'Last day the series may occur, as a date-only value like `2026-12-30` or an unzoned wall-clock string. Do not combine with count. Omit both for an open-ended series.',
    },
    untilTimeZoneIdentifier: { type: 'string', description: 'IANA time zone for a timed `until`. Requires until.' },
    weekdays: {
      type: 'array',
      description: 'Days the series occurs on, e.g. [{"day":"wednesday"}]. With monthly/yearly, add `week` for positional days: {"day":"monday","week":1} = first Monday, {"day":"friday","week":-1} = last Friday.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day'],
        properties: { day: { type: 'string', enum: DAYS }, week: { type: 'integer' } },
      },
    },
    monthDays: intList('Days of the month (1–31, negative counts from the end: -1 = last day).'),
    months: intList('Months of the year (1–12).'),
    yearDays: intList('Days of the year (1–366, negative counts from the end).'),
    weekNumbers: intList('ISO week numbers (1–53, negative counts from the end).'),
    setPositions: intList('Pick the Nth match from the other rules within each period (e.g. -1 = last).'),
    weekStart: { type: 'string', enum: DAYS },
  },
};

const RECURRENCE_PARAM = {
  name: 'recurrence',
  key: 'recurrence',
  acceptedKeys: [],
  description:
    'Optional repeat rule (BusyCal\'s structured equivalent of an RFC 5545 RRULE). Requires frequency; add interval, weekdays etc. to narrow it, and at most one of count or until to end it. Example for every Wednesday until 30 Dec 2026: {"frequency":"weekly","weekdays":[{"day":"wednesday"}],"until":"2026-12-30"}. Omit for a one-off event. Exception dates are not supported here: create the series, then delete single occurrences with delete_event scope "one".',
  required: false,
  schema: RECURRENCE_SCHEMA,
  transport: null,
};

const UPDATE_RECURRENCE_PARAM = {
  ...RECURRENCE_PARAM,
  description:
    'Optional replacement repeat rule, same shape as create_event.recurrence. Omit to leave the repeat unchanged. Use it to turn a one-off event into a series or to change how a series repeats or ends; with scope "future" the change starts at this occurrence.',
};

function param(name, schema, description, required = false, acceptedKeys = []) {
  return { name, key: name, acceptedKeys, description, required, schema, transport: null };
}

const ITEM_ID = param('itemID', { type: 'string' }, 'Occurrence-level event identifier (`id` from query_events or create_event).', true, ['id']);
const SCOPE = param('scope', { type: 'string', enum: ['one', 'future', 'all'] }, 'Recurrence scope: one (this occurrence), future (this and later occurrences), or all (whole series). Defaults to all.');
const DATE = { type: 'string', format: 'busycal-date' };

const EXTRA_TOOLS = [
  {
    commandName: 'rescheduleEvent',
    toolName: 'reschedule_event',
    title: 'Reschedule BusyCal Event',
    description:
      "Change an event's start and/or end time (unlike move_event, the duration can change). At least one of startDate, endDate or allDay is required; omitted fields stay as they are. Send unzoned wall-clock strings paired with startTimeZoneIdentifier/endTimeZoneIdentifier. A date-only endDate on an all-day event is the inclusive final day. Use scope to control whether the change applies to one occurrence, future occurrences, or the entire series (default all).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: [
      ITEM_ID,
      SCOPE,
      param('startDate', DATE, 'Optional new start date/time (unzoned wall-clock string, or date-only for all-day).'),
      param('endDate', DATE, 'Optional new end date/time (unzoned wall-clock string, or date-only for all-day).'),
      param('allDay', { type: 'boolean' }, 'Optional replacement all-day state.'),
      param('startTimeZoneIdentifier', { type: 'string' }, 'IANA time zone for a timed startDate. Requires startDate.'),
      param('endTimeZoneIdentifier', { type: 'string' }, 'IANA time zone for a timed endDate. Requires endDate.'),
    ],
  },
  {
    commandName: 'getItem',
    toolName: 'get_item',
    title: 'Get BusyCal Item',
    description: 'Return one event or task by its occurrence identifier, in the same shape as query_items.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    parameters: [param('itemID', { type: 'string' }, 'Occurrence-level item identifier.', true, ['id'])],
  },
];

/** Return a patched copy of the bridge's metadata document. Pure — exported for tests. */
export function patchMetadata(doc) {
  const out = structuredClone(doc);
  const byName = new Map(out.tools.map((t) => [t.toolName, t]));
  const addParam = (toolName, p) => {
    const t = byName.get(toolName);
    if (t && !t.parameters.some((x) => x.name === p.name)) t.parameters.push(structuredClone(p));
  };
  addParam('create_event', RECURRENCE_PARAM);
  addParam('update_event', UPDATE_RECURRENCE_PARAM);
  for (const t of EXTRA_TOOLS) {
    if (!byName.has(t.toolName) && !out.tools.some((x) => x.commandName === t.commandName)) out.tools.push(structuredClone(t));
  }
  return out;
}

/**
 * Materialise `<shadowDir>/<bridge binary>` + patched `tool-metadata.json`
 * from the extension's bridge. Re-done on every start so extension updates
 * flow through. Returns the path of the shadow binary to spawn.
 */
export function prepareShadowBridge(bridgePath, shadowDir) {
  const srcDir = path.dirname(bridgePath);
  const metadata = JSON.parse(fs.readFileSync(path.join(srcDir, 'tool-metadata.json'), 'utf8'));
  fs.mkdirSync(shadowDir, { recursive: true });
  const target = path.join(shadowDir, path.basename(bridgePath));
  fs.rmSync(target, { force: true });
  fs.copyFileSync(bridgePath, target);
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(shadowDir, 'tool-metadata.json'), JSON.stringify(patchMetadata(metadata), null, 2));
  return target;
}
