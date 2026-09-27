# Remove buchbox

Reverses every change `/add-buchbox` made.

## Step 1: Unregister the host module

Delete this line from `src/modules/index.ts`:

```typescript
import './buchbox/index.js';
```

Delete the line — do not comment it out.

## Step 2: Unregister the agent tool

Delete this line from `container/agent-runner/src/mcp-tools/index.ts`:

```typescript
import './buchbox.js';
```

## Step 3: Delete the copied files

```bash
rm -rf src/modules/buchbox
rm -f container/agent-runner/src/mcp-tools/buchbox.ts
rm -rf scripts/buchbox
```

`src/modules/buchbox` includes `registration.test.ts`, and `scripts/buchbox`
includes the `.venv`, the README and ENDPOINTS.md — all of it goes.

## Step 4: Revert the .gitignore entry

Delete these three lines from `.gitignore`:

```
# buchbox CLI (added by /add-buchbox)
scripts/buchbox/.venv/
scripts/buchbox/__pycache__/
```

## Step 5: Remove the default orderer

This holds personal data (name, e-mail, phone) and is what both the CLI and the
agent path used as the default orderer, so remove it unless the user wants to
keep it for a later reinstall. Ask first:

```bash
rm -f ~/.config/buchbox/env
rmdir ~/.config/buchbox 2>/dev/null || true
```

Also unset `BUCHBOX_FIRST_NAME`, `BUCHBOX_LAST_NAME`, `BUCHBOX_EMAIL`,
`BUCHBOX_PHONE`, `BUCHBOX_NAME`, `BUCHBOX_BASE_URL`, `BUCHBOX_STORE_MATCH`,
`BUCHBOX_ENV_FILE` and `BUCHBOX_PYTHON` wherever they were set (shell profile,
service unit). The skill does not write them into the repo `.env`.

No npm or pip dependency was added to the project: the CLI's two Python packages
live only inside `scripts/buchbox/.venv`, which step 3 deletes.

## Step 6: Verify

```bash
pnpm run build
pnpm test
./container/build.sh
```

Any `pending_approvals` row with action `buchbox_order` can no longer be
applied — its handler is gone. Resolve or delete such rows before removing:
`ncl approvals list`.
