---
name: dev-api
description: Query, test, and interact with the einkflow dev server REST API at dev.einkflow.com. Use when asked to call the dev API, check feed items, test adhoc transforms, submit URLs, or interact with the dev backend.
allowed-tools: Bash(curl:*), Bash(python3:*)
---

# Dev Server API

Query the einkflow dev server REST API.

## Connection Details

- **Base URL**: `https://dev.einkflow.com`
- **Auth**: Personal Access Token (PAT) via Bearer header
- **Token file**: `~/.einkflow-pat-token` (persists the PAT)

## Usage

### Step 1: Read the PAT from disk

```bash
TOKEN=$(cat ~/.einkflow-pat-token)
```

### Step 2: Use the token for API requests

```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://dev.einkflow.com/api/v1/<endpoint>" | python3 -m json.tool
```

**Important:** PAT tokens do not expire (unless revoked by the user). No refresh flow is needed — just read the token from `~/.einkflow-pat-token` and use it directly. If a request returns 401, the token may have been revoked — ask the user to provide a new PAT.

No port-forward is needed — the API is publicly accessible via the Kubernetes ingress at `dev.einkflow.com`.

## Auth Endpoints — `/api/v1/auth`
- `POST /api/v1/auth/login` — Login (body: `{email, password}`) -> `{accessToken, refreshToken, expiresIn, userId, email, role}`
- `POST /api/v1/auth/refresh` — Refresh token (body: `{refreshToken}`) -> new `{accessToken, refreshToken, ...}`
- `POST /api/v1/auth/logout` — Logout (body: `{refreshToken}`)

## OpenAPI / Swagger

- Swagger UI: `GET /swagger-ui.html`
- Raw OpenAPI spec: `GET /api-docs`

## Complete API Reference

Endpoints are under `/api/v1/` and `/api/v2/`. All JSON responses use an `ApiResponse<T>` envelope with `data`, `meta`, and optional `pagination`. Default page size: 20, max: 100. **For content submission, prefer `/api/v2/submit`** which supports both sync and async delivery.

### Users — `/api/v1/users`
- `GET /api/v1/users` — List all users
- `GET /api/v1/users/{id}?includeStats=false` — Get user by ID (optionally include stats)
- `PATCH /api/v1/users/{id}` — Partial update (body: `{email?, role?}`)
- `DELETE /api/v1/users/{id}` — Delete -> 204

### Sources — `/api/v1/sources`
- `GET /api/v1/sources?userId=` — List sources (optionally filter by user)
- `GET /api/v1/sources/{id}` — Get source by ID
- `PATCH /api/v1/sources/{id}` — Partial update
- `DELETE /api/v1/sources/{id}` — Delete -> 204

### Feed Items — `/api/v1/feed-items`
- `GET /api/v1/feed-items?userId=1&page=0&size=20` — Paginated feed items (newest first)
- `GET /api/v1/feed-items/{id}` — Get feed item by ID
- `GET /api/v1/feed-items/favorites?userId=1` — List favorites (non-paginated)
- `PATCH /api/v1/feed-items/{id}` — Partial update (e.g. toggle favorite)
- `DELETE /api/v1/feed-items/{id}` — Delete -> 204

### Processed Items — `/api/v1/processed-items`
- `GET /api/v1/processed-items?userId=1&feedItemId=&page=0&size=20` — Paginated (optionally filter by feedItemId)
- `GET /api/v1/processed-items/{id}` — Get by ID
- `GET /api/v1/processed-items/by-content-id/{contentId}` — Get by MinIO content ID
- `GET /api/v1/processed-items/{id}/download` — Download EPUB/PDF binary
- `GET /api/v1/processed-items/{id}/html` — Download simplified HTML
- `PATCH /api/v1/processed-items/{id}` — Partial update (uploadPath only)
- `DELETE /api/v1/processed-items/{id}` — Delete -> 204

### Magazines — `/api/v1/magazines`
- `GET /api/v1/magazines?userId=1&page=0&size=20` — Paginated magazines
- `GET /api/v1/magazines/{id}` — Get magazine by ID
- `PATCH /api/v1/magazines/{id}` — Partial update (name?, deliverySchedule?)
- `DELETE /api/v1/magazines/{id}` — Delete -> 204
- `GET /api/v1/magazines/{id}/feed-items` — List feed items in magazine
- `POST /api/v1/magazines/{id}/feed-items` — Add feed items (body: `{feedItemIds: [Long]}`)
- `DELETE /api/v1/magazines/{id}/feed-items/{magazineFeedItemId}` — Remove feed item -> 204

### Deliveries — `/api/v1/deliveries` (read-only)
- `GET /api/v1/deliveries?magazineId=&page=0&size=20` — Paginated deliveries for a magazine
- `GET /api/v1/deliveries/{id}` — Get delivery by ID

### Highlights — `/api/v1/highlights`
- `GET /api/v1/highlights?userId=1&page=0&size=20` — Paginated highlights
- `GET /api/v1/highlights/{id}` — Get by ID
- `GET /api/v1/highlights/by-content-id/{contentId}` — Get by content ID
- `PATCH /api/v1/highlights/{id}` — Partial update (note only)
- `DELETE /api/v1/highlights/{id}` — Delete -> 204

### Notes — `/api/v1/notes`
- `GET /api/v1/notes?userId=1&page=0&size=20` — Paginated notes
- `GET /api/v1/notes/{id}` — Get by ID
- `PATCH /api/v1/notes/{id}` — Partial update (text only)
- `DELETE /api/v1/notes/{id}` — Delete -> 204
- Note types: `TEXT`, `DOCUMENT`, `EMAIL`, `OCR`

### Jobs — `/api/v1/jobs`
- `GET /api/v1/jobs?userId=1&page=0&size=20` — Paginated jobs
- `GET /api/v1/jobs/{id}` — Get by ID
- `PATCH /api/v1/jobs/{id}` — Partial update (enabled?)
- `POST /api/v1/jobs/{id}/run` — Trigger job immediately -> 202
- `DELETE /api/v1/jobs/{id}` — Delete -> 204
- Job types: `BLUESKY_FAVORITES`, `BLUESKY_FEED`, `BLUESKY_TIMELINE`, `HACKER_NEWS`, `HIGHLIGHTS`, `DROPBOX_OCR`, `MCP_AGENT`, `GENERIC_*`

### Address Books & Contacts — `/api/v1/address-books`
- `GET /api/v1/address-books?userId=1` — List address books (non-paginated)
- `GET /api/v1/address-books/{id}` — Get address book by ID
- `GET /api/v1/address-books/{addressBookId}/contacts?page=0&size=20` — Paginated contacts
- `GET /api/v1/address-books/{addressBookId}/contacts/{contactId}` — Get contact
- `POST /api/v1/address-books/{addressBookId}/contacts` — Create contact -> 201
- `PATCH /api/v1/address-books/{addressBookId}/contacts/{contactId}` — Update contact
- `DELETE /api/v1/address-books/{addressBookId}/contacts/{contactId}` — Delete -> 204

### Search — `/api/v1/search`
- `GET /api/v1/search?userId=1&query=&type=ALL&page=0&size=20` — Unified search
- Types: `FEED_ITEM`, `PROCESSED_ITEM`, `HIGHLIGHT`, `NOTE`, `ALL`
- Results include: type, id, title, snippet (200 chars), url, createdAt, updatedAt

### Stats — `/api/v1/stats`
- `GET /api/v1/stats/overview?userId=1` — Counts: feedItems, magazines, processedItems, highlights, notes
- `GET /api/v1/stats/activity?userId=1&period=MONTH` — Activity time-series (WEEK/MONTH/YEAR)
- `GET /api/v1/stats/content-types?userId=1` — Processed items by content type
- `GET /api/v1/stats/sources?userId=1` — Feed items by source

### Batch — `/api/v1/batch` (max 100 IDs)
- `POST /api/v1/batch/feed-items/delete?userId=1` — Bulk delete (body: `{ids: [Long]}`)
- `POST /api/v1/batch/feed-items/favorite?userId=1` — Bulk favorite (body: `{ids: [Long], favorite: Boolean}`)
- `POST /api/v1/batch/processed-items/delete?userId=1` — Bulk delete
- `POST /api/v1/batch/highlights/delete?userId=1` — Bulk delete
- `POST /api/v1/batch/notes/delete?userId=1` — Bulk delete

### Unified Submit — `/api/v2/submit` (PREFERRED for submissions)
- `POST /api/v2/submit` — Unified endpoint supporting both sync download and async Dropbox delivery
  - Body: `{items: [{type, value, title?}], deliveryMode: "SYNC"|"ASYNC", outputFormats?, deliverAsMagazine?, magazineName?, title?, tags?, includeHtml?}`
  - Item types: `URL`, `TEXT`, `HTML`
  - `deliveryMode: "SYNC"` — returns EPUB/PDF bytes in response (`application/epub+zip` or `application/zip`), 204 if none
  - `deliveryMode: "ASYNC"` — queues for background processing and Dropbox delivery, returns 202 with `{correlationId, itemCount, deliveryMode, outputFormats, status}`
  - Default `outputFormats`: EPUB only (SYNC), EPUB + PDF_A5 (ASYNC)
  - **Use ASYNC mode when the user wants files delivered to Dropbox**

### Adhoc Transform — `/api/v1/adhoc` (sync-only, legacy)
- `POST /api/v1/adhoc/transform` — Transform URLs/text/HTML to EPUB (body: `{userId, items: [{type, value, title?}], includeHtml?}`)
  - Item types: `URL`, `TEXT`, `HTML`
  - Response: `application/epub+zip` (single), `application/zip` (multiple), 204 if none
  - Note: Does NOT deliver to Dropbox. Use `/api/v2/submit` with `deliveryMode: "ASYNC"` instead.
- `POST /api/v1/adhoc/ocr` — OCR images to EPUB (multipart: `images` files + `userId`)

### Submit — `/api/v1/submit` (DEPRECATED, use v2)
- `POST /api/v1/submit` — Submit URLs for async processing and Dropbox delivery (body: `{urls: [String], title?, tags?, deliverAsMagazine?, outputFormats?}`)
  - Returns 202 with `{correlationId, urlCount, deliverAsMagazine, outputFormats, status}`

### Email Webhook — `/api/emails` (not under /api/v1/)
- `POST /api/emails/inbound` — SendGrid Inbound Parse webhook (multipart/form-data)

## Troubleshooting

If the API returns **502/504**, the einkflow pod likely has a stale DB connection pool:

```bash
# Check pod status
kubectl get pods

# Check recent logs for JDBC/HikariPool errors
kubectl logs deploy/einkflow-deployment --tail=30

# Restart the pod to reset connections
kubectl rollout restart deploy/einkflow-deployment
kubectl rollout status deploy/einkflow-deployment --timeout=120s
```

Wait ~30s after rollout completes before retrying — the app needs time to finish Flyway migrations and start Tomcat.
