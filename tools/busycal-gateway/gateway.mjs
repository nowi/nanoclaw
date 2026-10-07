#!/usr/bin/env node
/**
 * nanoclaw-busycal-gateway — loopback HTTP MCP server in front of BusyCal.
 *
 * The BusyCal MCP bridge (Claude Desktop extension, a native macOS stdio
 * binary) can only run on the host. NanoClaw agents live in Linux containers
 * and speak HTTP MCP, so this gateway sits in between:
 *
 *   container ── http://host.docker.internal:8765/mcp ──► gateway ── stdio ──► BusyCalMCPBridge ──► BusyCal
 *
 * It is the enforcement point for *what* the agent may do: only the tools in
 * ALLOWED are listed and callable. Everything else is invisible to the agent
 * and refused if named directly, so the limits hold even if the model is
 * talked into trying.
 *
 * The bridge is not spawned from the extension directly but from a shadow
 * copy with a widened tool contract (recurrence, reschedule_event, get_item) —
 * see bridge-metadata.mjs.
 *
 * Config (env):
 *   BUSYCAL_BRIDGE   path to BusyCalMCPBridge (required)
 *   BUSYCAL_SHADOW_DIR  where the patched bridge copy lives; default ./.bridge
 *   BUSYCAL_PORT     default 8765          BUSYCAL_HOST  default 127.0.0.1
 *   BUSYCAL_TOOLS    comma-separated allowlist; default = the read-only set
 *   BUSYCAL_CREATE_CALENDAR_IDS
 *                    comma-separated BusyCal calendarIDs. When set, the write
 *                    tools (create_event incl. recurrence, update_event,
 *                    reschedule_event, delete_event) are exposed too, pinned to
 *                    these calendars: a create without calendarID goes to the
 *                    first one, any other id is refused, and an edit is only
 *                    forwarded after get_item shows the event lives in one of
 *                    them. Events in these calendars carry their `id` in results.
 */
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { prepareShadowBridge } from './bridge-metadata.mjs';
import { compactResult } from './compact.mjs';

const READ_ONLY_TOOLS = [
  'list_accounts',
  'list_calendars',
  'selected_items',
  'query_items',
  'query_events',
  'query_tasks',
  'query_availability',
  'find_next_available',
];
// Edits of existing events; only ever exposed together with pinned calendars.
const EDIT_TOOLS = ['update_event', 'reschedule_event', 'delete_event'];

const BRIDGE = process.env.BUSYCAL_BRIDGE;
const PORT = Number(process.env.BUSYCAL_PORT || 8765);
const HOST = process.env.BUSYCAL_HOST || '127.0.0.1';
const TIME_ZONE = process.env.BUSYCAL_TZ || 'Europe/Berlin';
const ALLOWED = new Set(
  (process.env.BUSYCAL_TOOLS ? process.env.BUSYCAL_TOOLS.split(',') : READ_ONLY_TOOLS).map((t) => t.trim()).filter(Boolean),
);
const CREATE_CALENDAR_IDS = (process.env.BUSYCAL_CREATE_CALENDAR_IDS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (CREATE_CALENDAR_IDS.length > 0) for (const t of ['create_event', ...EDIT_TOOLS]) ALLOWED.add(t);

if (!BRIDGE) {
  console.error('BUSYCAL_BRIDGE is required');
  process.exit(2);
}

const log = (msg, extra) => console.log(`[${new Date().toISOString()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

// ── upstream: one long-lived stdio session to the bridge ──────────────────
const SHADOW_DIR = process.env.BUSYCAL_SHADOW_DIR || new URL('./.bridge', import.meta.url).pathname;
const shadowBridge = prepareShadowBridge(BRIDGE, SHADOW_DIR);
const upstream = new Client({ name: 'nanoclaw-busycal-gateway', version: '1.0.0' });
await upstream.connect(new StdioClientTransport({ command: shadowBridge, args: [], stderr: 'pipe' }));
const upstreamTools = (await upstream.listTools()).tools;

// Resolve calendar/account titles once: compaction shows names instead of ids,
// and the pinned-calendar messages the agent reads use them too.
const calendarTitles = new Map();
const accountTitles = new Map();
const calendarAccounts = new Map(); // calendarID → account title
{
  const accts = (await upstream.callTool({ name: 'list_accounts', arguments: {} }))?.structuredContent?.result ?? [];
  for (const a of accts) accountTitles.set(a.id, a.title);
  const res = await upstream.callTool({ name: 'list_calendars', arguments: {} });
  const cals = res?.structuredContent?.result ?? [];
  for (const c of cals) {
    calendarTitles.set(c.calendarID, c.title);
    const acct = accountTitles.get(c.accountID);
    if (acct) calendarAccounts.set(c.calendarID, acct);
  }
  for (const id of CREATE_CALENDAR_IDS) {
    const c = cals.find((x) => x.calendarID === id);
    if (!c) log('WARNING: pinned calendar id not found in BusyCal', { id });
    else if (!c.isWritable) log('WARNING: pinned calendar is not writable', { id, title: c.title });
  }
}
const pinnedLabel = CREATE_CALENDAR_IDS.map((id) => `"${calendarTitles.get(id) ?? id}"`).join(', ');
const compactCtx = { calendarTitles, accountTitles, calendarAccounts, timeZone: TIME_ZONE, editableCalendars: new Set(CREATE_CALENDAR_IDS) };

const exposed = upstreamTools
  .filter((t) => ALLOWED.has(t.name))
  .map((t) => {
    if (EDIT_TOOLS.includes(t.name)) {
      return {
        ...t,
        description: `${t.description ?? ''} RESTRICTED: only events in ${pinnedLabel} can be changed; query results carry an \`id\` exactly for those events. Events in other calendars are refused by the gateway.`.trim(),
      };
    }
    if (t.name !== 'create_event' || CREATE_CALENDAR_IDS.length === 0) return t;
    // Tell the agent the rule up front, and remove the illusion of choice.
    const schema = structuredClone(t.inputSchema ?? {});
    if (schema.properties?.calendarID) {
      schema.properties.calendarID.description = `Optional. Only the pinned calendar(s) ${pinnedLabel} are permitted; omit to use ${pinnedLabel.split(', ')[0]}. Any other calendar is refused.`;
    }
    return {
      ...t,
      description: `${t.description ?? ''} RESTRICTED: events are always created in the calendar ${pinnedLabel} (the operator's private calendar); other calendars are refused by the gateway.`.trim(),
      inputSchema: schema,
    };
  });

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** Edits are forwarded only for events that live in a pinned calendar. Returns a refusal, or null to proceed. */
async function checkEditable(name, args) {
  const itemID = typeof args.itemID === 'string' && args.itemID ? args.itemID : typeof args.id === 'string' ? args.id : null;
  if (!itemID) return refuse(`${name} needs the event's \`id\` from query_events or create_event.`);
  const found = await upstream.callTool({ name: 'get_item', arguments: { itemID } });
  if (found.isError) {
    const reason = found.content?.map((c) => c.text).join(' ').replace(/^get_item failed:\s*/, '') || 'unknown error';
    return refuse(`Could not find event '${itemID}': ${reason}. Re-query to get a current \`id\`.`);
  }
  const item = found.structuredContent?.result;
  const calendarID = item?.calendarID;
  if (!calendarID || !CREATE_CALENDAR_IDS.includes(calendarID)) {
    log(`refused ${name} — calendar not permitted`, { title: item?.title, calendar: calendarTitles.get(calendarID) ?? calendarID ?? null });
    return refuse(`Refused: only events in ${pinnedLabel} can be changed. '${item?.title ?? itemID}' is in '${calendarTitles.get(calendarID) ?? calendarID}'.`);
  }
  log(name, { title: item.title, start: item.startDate, scope: args.scope ?? null, calendar: calendarTitles.get(calendarID) ?? calendarID });
  return null;
}
const hidden = upstreamTools.filter((t) => !ALLOWED.has(t.name)).map((t) => t.name);
log('connected to BusyCal bridge', { exposed: exposed.map((t) => t.name), hidden, createCalendars: pinnedLabel || null, timeZone: TIME_ZONE, calendars: calendarTitles.size });

// ── downstream: stateless Streamable HTTP, one Server per request ─────────
function makeServer() {
  const server = new Server({ name: 'BusyCal', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!ALLOWED.has(name)) {
      log('refused tool call', { name });
      return refuse(`Tool '${name}' is not available on this calendar connection.`);
    }
    const args = { ...(req.params.arguments ?? {}) };
    if (name === 'create_event') {
      const requested = typeof args.calendarID === 'string' && args.calendarID.trim() ? args.calendarID.trim() : null;
      if (requested && !CREATE_CALENDAR_IDS.includes(requested)) {
        log('refused create_event — calendar not permitted', { requested, title: calendarTitles.get(requested) ?? null });
        return refuse(
          `Refused: events may only be created in ${pinnedLabel}. Calendar '${calendarTitles.get(requested) ?? requested}' is not permitted. Omit calendarID to use the permitted calendar.`,
        );
      }
      args.calendarID = requested ?? CREATE_CALENDAR_IDS[0];
      log('create_event', { title: args.title, startDate: args.startDate, recurrence: args.recurrence ?? null, calendar: calendarTitles.get(args.calendarID) ?? args.calendarID });
    } else if (EDIT_TOOLS.includes(name)) {
      const refusal = await checkEditable(name, args);
      if (refusal) return refusal;
    } else {
      log('tool call', { name });
    }
    const result = await upstream.callTool({ name, arguments: args });
    const compact = compactResult(name, result, compactCtx);
    const before = JSON.stringify(result).length;
    const after = JSON.stringify(compact).length;
    if (before !== after) log('compacted result', { name, before, after });
    return compact;
  });
  return server;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no server-initiated streams, no sessions to delete.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readJson(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = makeServer();
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log('request failed', { err: String(err) });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'gateway error' }, id: null }));
  }
});

httpServer.listen(PORT, HOST, () => log('listening', { url: `http://${HOST}:${PORT}/mcp` }));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${sig} — shutting down`);
    httpServer.close();
    await upstream.close().catch(() => {});
    process.exit(0);
  });
}
