---
name: add-buchbox
description: Add book ordering at BUCHBOX! Berlin — a Python CLI to search the shop by title/author/ISBN and place pickup orders (never shipping, default branch Greifswalder Straße, payment in store), plus an approval-gated buchbox_order MCP tool so an agent can request an order that an admin must approve. Triggers on "add buchbox", "order books", "buchbox", "Abholbestellung".
---

# Add buchbox — book search and pickup orders

Installs a small Python client for the BUCHBOX! Berlin webshop and wires it into
NanoClaw two ways:

- **Operator CLI** (`scripts/buchbox/buchbox.py`) — search by title, author,
  publisher or ISBN; place a pickup order after a terminal `y/N`.
- **Agent tool** (`buchbox_order`) — an agent can *request* an order. The host
  looks the article up, cards an admin with the real title, price, availability
  and branch, and places the order only after approval. An agent can ask, never
  decide.

Delivery is always pickup, the default branch is Greifswalder Straße 33
(BUCHBOX! Bötzowkiez), and payment happens in the shop — no payment data is ever
sent or stored.

The shop has no API; the client reads HTML. `payload/ENDPOINTS.md` documents
every endpoint, field and selector as of the analysis date, and
`payload/README.md` lists what is fragile and why.

Each step is safe to re-run: file copies overwrite, barrel imports are appended
only when absent, and the venv is reused if it already exists.

## Step 1: Copy the operator CLI

```bash
mkdir -p scripts/buchbox
cp "${CLAUDE_SKILL_DIR}/payload/buchbox.py" scripts/buchbox/buchbox.py
cp "${CLAUDE_SKILL_DIR}/payload/requirements.txt" scripts/buchbox/requirements.txt
cp "${CLAUDE_SKILL_DIR}/payload/README.md" scripts/buchbox/README.md
cp "${CLAUDE_SKILL_DIR}/payload/ENDPOINTS.md" scripts/buchbox/ENDPOINTS.md
cp "${CLAUDE_SKILL_DIR}/payload/test_buchbox.py" scripts/buchbox/test_buchbox.py
chmod +x scripts/buchbox/buchbox.py
```

## Step 2: Create the Python environment

The host module resolves the interpreter as `scripts/buchbox/.venv/bin/python`,
falling back to `$BUCHBOX_PYTHON`, then `python3`. Create the venv so the
resolution is deterministic:

```bash
cd scripts/buchbox && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
```

Keep the environment out of git by appending to `.gitignore` (skip if present):

```
# buchbox CLI (added by /add-buchbox)
scripts/buchbox/.venv/
scripts/buchbox/__pycache__/
```

Run the client's own tests. They drive the CLI against a local stub of the shop,
so they touch no real order and need no network:

```bash
cd scripts/buchbox && ./.venv/bin/python test_buchbox.py
```

All 7 must pass. They assert that a dry run never POSTs, that `--execute`
refuses without a confirmation, that an approved replay sends `store=56` +
`contact_privacy=1` with the honeypot decoy empty, that a missing phone blocks
the order, and that a CAPTCHA or a server validation error aborts with the right
exit code.

Then check the live shop — two throttled GET requests, nothing sent:

```bash
cd scripts/buchbox && ./.venv/bin/python buchbox.py stores
```

The output must list five branches, including `store=56` for Greifswalder
Straße 33. The ID is resolved live, so a different number is fine; a missing
Greifswalder entry is not.

## Step 3: Copy the host module

```bash
mkdir -p src/modules/buchbox
cp "${CLAUDE_SKILL_DIR}"/payload/host/*.ts src/modules/buchbox/
```

This adds `client.ts` (spawns the CLI), `guard.ts` (the catalog entry that holds
every container-originated order), `request.ts` (validation + the approval
card), `apply.ts` (the approved replay), `index.ts` (the registrations) and
`registration.test.ts` (the wiring guard).

## Step 4: Register the host module

Append the import to the modules barrel `src/modules/index.ts`, after the
existing module imports. The approvals module must load first — it already does,
being listed above:

```typescript
import './buchbox/index.js';
```

## Step 5: Copy and register the agent tool

```bash
cp "${CLAUDE_SKILL_DIR}/payload/container/buchbox.ts" container/agent-runner/src/mcp-tools/buchbox.ts
```

Append the import to the MCP tools barrel
`container/agent-runner/src/mcp-tools/index.ts`, next to the other tool imports
and **before** the `../modules/index.js` line:

```typescript
import './buchbox.js';
```

## Step 6: Configure the default orderer

One file serves both callers: the operator CLI reads it directly, and the host
reads it to fill in whatever an agent's `buchbox_order` request omits. An agent
then normally sends only an ISBN, and passes identity fields only when ordering
for somebody else.

It lives outside the repo because it holds personal data:

```bash
mkdir -p ~/.config/buchbox
cat > ~/.config/buchbox/env <<'EOF'
BUCHBOX_FIRST_NAME=
BUCHBOX_LAST_NAME=
BUCHBOX_EMAIL=
BUCHBOX_PHONE=
EOF
chmod 600 ~/.config/buchbox/env
```

Ask the user for the four values and fill them in. Never write them into the
repo, into `.env`, or into any log.

With no default configured, an ISBN-only request is refused rather than sent
anonymously — the host says the default orderer is missing and mints no card.
The host resolves the default **at request time** and writes the resolved
identity into the approval payload, so the card and the eventual order can never
disagree even if this file changes in between.

## Step 7: Verify

```bash
pnpm run build
pnpm exec vitest run src/modules/buchbox/registration.test.ts src/guard/conformance.test.ts
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd scripts/buchbox && ./.venv/bin/python test_buchbox.py
```

The wiring test asserts, through the real production barrels, that the
`buchbox_order` delivery action and its approve continuation are registered and
that the guard holds an agent-originated order and denies a non-agent one. It
goes red if either barrel import is removed.

Rebuild the container image so the agent sees the new tool:

```bash
./container/build.sh
```

Then restart the host (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on
macOS, `systemctl --user restart nanoclaw` on Linux).

## Step 8: Smoke test

Dry run is the default and sends nothing:

```bash
cd scripts/buchbox && ./.venv/bin/python buchbox.py order 978-3-89794-822-8
```

It must print the title, the price, `Lieferart: Abholung`, the Greifswalder
Straße branch and `DRY RUN`. To place the order for real, run it with
`--execute` and answer `y` — do this yourself in a terminal; it spends money.

## How the approval gate works

An agent calling `buchbox_order` writes a system action into `messages_out`. The
host then:

1. validates the request (ISBN, name, e-mail, phone) — malformed requests are
   answered without ever minting a card;
2. runs the CLI as a **dry run** to resolve the real title, price, availability
   and branch;
3. cards an admin with those facts (approvers come from `user_roles`: scoped
   admins for the agent group → global admins → owners);
4. on approve, re-enters the guarded action with the approval row as the grant
   and places the order with `--approved <id>`, which replaces the terminal
   `y/N` that already happened on the card.

The guard holds unconditionally from the container path — there is no setting
that lets an agent order without approval. On deny or on any failure the
requesting agent is notified in its session.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `buchbox CLI not found` | Step 1 didn't run, or the host runs from a different working tree. The module resolves `scripts/buchbox/buchbox.py` relative to its own file. |
| `Fehlende Abhängigkeit: requests` | The venv is missing — re-run step 2, or set `BUCHBOX_PYTHON` to an interpreter that has `requests` and `beautifulsoup4`. |
| Exit code 3, "BOT-SCHUTZ" | The shop served a CAPTCHA or rate-limited. This is not bypassed by design. Wait, then continue in a browser. |
| Exit code 4 with a German message | The shop rejected the form — most often a new required field. The message is the server's own; see the fragility notes in `scripts/buchbox/README.md`. |
| "Keine Filiale enthält 'Greifswalder'" | The branch labels changed. Run `buchbox.py stores` and set `BUCHBOX_STORE_MATCH` to a string that matches the right one. |
| Agent gets "Unknown system action" | Step 4 is missing — the host module isn't registered in `src/modules/index.ts`. |
| Agent doesn't see `buchbox_order` | Step 5 is missing, or the image wasn't rebuilt (`./container/build.sh`). |

## Notes

- `buchbox.de` is a parked third-party domain, not the shop. The client targets
  `buchboxberlin.de`; override with `BUCHBOX_BASE_URL` if that ever moves.
- The client makes one request at a time with a 2 s default gap, never polls and
  never parallelises. `robots.txt` asks for `Crawl-delay: 10` — use `--delay 10`
  for anything bulk.
- A pickup reservation is always 1 copy; the shop's reserve form has no quantity
  field.
