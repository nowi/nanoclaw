# buchboxberlin.de — protocol notes

Analysis date: **2026-09-27**. Everything below was observed against the live
site with an ordinary browser user agent. No protection was bypassed.

## The domain in the brief is wrong

`buchbox.de` (and `www.buchbox.de`) is **not** the bookshop. It is a parked
third-party domain that `302`s every path to `https://www.inspiration.de`, an
unrelated Polymer/AdSense placeholder page.

The real shop of BUCHBOX! Berlin is **`https://buchboxberlin.de`**.

## Platform

Drupal 7 running the white-label bookshop distribution `bhwp`
("Buchhandelsweb 2"), site instance `30103.buchhandelsweb2.de`. Catalogue data
and cover images come from the wholesaler Umbreit (`medien.umbreitkatalog.de`).
Shop pages are rendered by the `bonuswebshopframe` module.

Consequences worth knowing:

- Forms are Drupal forms: `form_id`, `form_build_id`, and a Honeypot module
  pair (`honeypot_time` + an always-empty decoy field named `Link`).
- `/nojs/` endpoints are ctools modal endpoints. Despite the name they answer
  with a **ctools AJAX command array** (JSON), and the real markup sits in the
  `output` field of the `modal_display` command.
- Session cookie: `SSESS<md5>`, set on first GET. A plain
  `requests.Session()` is enough; no login is needed for anything below.

## Session / CSRF / bot protection

| Mechanism | Where | How the client deals with it |
|---|---|---|
| `SSESS<md5>` session cookie | every response | held by `requests.Session` |
| `form_build_id` | every Drupal form | read from the live form, echoed back |
| `form_id` | every Drupal form | read from the live form, echoed back |
| `honeypot_time` | search + reserve forms | echoed back, and the client **waits out** the minimum fill time rather than defeating it |
| `Link` (decoy input) | search + reserve forms | left empty, which is what a browser does |
| `robots.txt` `Crawl-delay: 10` | site root | client throttles to one request at a time, default 2 s apart, no parallelism, no polling |

No CAPTCHA was encountered anywhere in the search or pickup-order flow. The
client aborts (exit code 3) if one ever appears, or on `401/403/429/503`.

## Search

The search form POSTs to `/shop`, but that POST only **redirects to a plain GET**:

```
POST /shop  (form_id=bonuswebshopframe_frontpage)
  → 302 /shop/search?ean=9783897948228
  → 302 /shop/item/9783897948228            (exact single hit)
  → 302 /shop/item/9783897948228/<slug>
```

So the client skips the POST entirely and calls the GET directly — which also
means **the honeypot is irrelevant for searching**:

```
GET /shop/search?titel=<term>
GET /shop/search?ean=<isbn13>
GET /shop/search?autor=<name>
GET /shop/search?verlag=<publisher>
GET /shop/search?wg=<category-id>&page=<n>
```

Note `/shop?titel=…` (without `/search`) ignores query parameters — it must be
`/shop/search`.

Recognised filters: `titel`, `autor`, `verlag`, `ean`, `mediaType`, `wg`,
`lang`, `preisVon`, `preisBis`, `jahrVon`, `jahrBis`, `sortOrder`, `page`
(0-based).

An exact ISBN hit redirects straight to the item page; the client detects
`/shop/item/` in the final URL and parses a detail page instead of a list.

### Result list selectors

- container `#bonuswebshopframe-search`
- one tile per hit: `div.bonuswebhighlights-item` (the class name is reused
  from a highlights carousel — it *is* the result tile here)
- title `.info-container .title`, author `.autor`, price `.price`
- ISBN: from the `/shop/item/(\d{13})` href
- total count: free text `"1 - 24 von 153 Artikeln"`
- **availability is not in the list** — only on the detail page

## Detail page

```
GET /shop/item/<ean>            → 302 to /shop/item/<ean>/<slug>
```

Schema.org microdata carries the machine-readable bits:

| Field | Source |
|---|---|
| price | `meta[itemprop=price]` (+ `priceCurrency`) |
| ISBN | `meta[itemprop=gtin13]` |
| availability | `link[itemprop=availability]` → `schema.org/InStock` |
| availability (human) | `.bonuswebshop-search-detail-availability-text`, e.g. "In 1-2 Werktagen im Laden" |
| title / subtitle | `h1` / `#bonuswebshop-search-detail-info-utitel` |
| author / publisher | `#bonuswebshop-search-detail-info-autor` / `-verlag` |
| category / date | `-info-wg` / `-info-erscheinungsDatum` |
| binding | `title` attribute of `.image-media-box span[title]` |

Two action links sit on the page:

- `/cart/add/nojs/<ean>` — ordinary cart
- `/reserve/nojs/<ean>` — **"Abholbestellung"** (pickup order)

## Why the client uses `/reserve/`, not the cart

The cart path is a dead end for this use case:

```
GET  /cart/add/nojs/<ean>     → adds to the session cart (returns a full page)
GET  /cart                    → form bonuswebshopframe_cart_extras_form
                                (quantity per EAN, giftwrap_<ean>, cart_message)
POST /cart  op="Zur Kasse"    → 302 back to /cart
```

"Zur Kasse" bounces back to `/cart` for an anonymous session: **the cart
checkout requires an account**, and it is where shipping and payment selection
live.

The `/reserve/` flow needs **no login, no account and no payment data** and has
delivery method and branch built in — it is exactly "Abholung + Filiale, Zahlung
vor Ort". That is why `order` uses it. Quantity is not a field there, so a
reservation is always 1 copy.

## The pickup order (`/reserve/`)

```
GET  /reserve/nojs/<ean>   → ctools JSON, modal title "Abholbestellung"
POST /reserve/nojs/<ean>   → ctools JSON
```

Form `bonuswebshopframe_reserve_form` fields:

| Field | Required | Notes |
|---|---|---|
| `store` | yes | radio; `0` is the "please choose" placeholder |
| `name` | yes | "Vor- und Nachname" — one field, not two |
| `email` | yes | pickup notification goes here |
| `phone` | no (shop) | the client requires it anyway, so the branch can call |
| `contact_privacy` | yes | `1` = privacy policy accepted |
| `ean` | — | hidden, prefilled |
| `form_build_id`, `form_id` | — | echoed from the GET |
| `honeypot_time` | — | echoed from the GET; minimum fill time enforced |
| `Link` | — | decoy, must stay empty |
| `op` | — | `Senden` |

### Branch IDs (observed 2026-09-27)

| `store` | Branch |
|---|---|
| 53 | BUCHBOX! Kastanienallee — Kastanienallee 97, 10435 Berlin |
| 54 | BUCHBOX! Helmikiez — Lettestraße 5, 10437 Berlin |
| 55 | BUCHBOX! Boxikiez — Grünberger Straße 68, 10245 Berlin |
| **56** | **BUCHBOX! Bötzowkiez — Greifswalder Straße 33, 10405 Berlin** |
| 175 | Love Story of Berlin — Kastanienallee 88, 10435 Berlin |

These IDs are per-install Drupal node references and can change. **The client
never hardcodes 56** — it parses the radio labels from the live form and matches
on the street name, aborting if the match is absent or ambiguous. `56` is kept
only as a plausibility anchor that prints a notice when it drifts.

### Responses

Both success and failure return HTTP 200 with a ctools JSON array. Distinguish
by content:

- **Validation failure** — `modal_display` whose output contains a
  `div.messages.error` block plus the re-rendered form. Server messages are
  German, e.g. `Das Feld Vor- und Nachname ist erforderlich.`,
  `Bitte wählen Sie einen Abholort`.
- **Success** — no error block and the reserve form is *not* present again.

The client treats "form re-rendered" as *not sent* and says so, rather than
claiming a success it cannot prove.
