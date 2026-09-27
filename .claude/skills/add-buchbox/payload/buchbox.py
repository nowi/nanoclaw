#!/usr/bin/env python3
"""buchbox — CLI zum Suchen und Abholbestellen von Büchern bei BUCHBOX! Berlin.

Lieferart ist immer Abholung, Filiale standardmäßig Greifswalder Straße.
Es werden keine Zahlungsdaten übertragen oder gespeichert — bezahlt wird vor Ort.

Exit-Codes:
  0  Erfolg
  1  Fehler
  2  Benutzungsfehler
  3  Bot-Schutz / CAPTCHA erkannt — Abbruch (wird nicht umgangen)
  4  Server-Validierungsfehler
  5  Vom Benutzer abgebrochen
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError as exc:  # pragma: no cover
    sys.exit(f"Fehlende Abhängigkeit: {exc.name}. Installiere: pip install -r requirements.txt")

# buchbox.de ist eine geparkte Fremddomain (leitet auf inspiration.de um).
# Der echte Shop von BUCHBOX! Berlin läuft auf buchboxberlin.de.
DEFAULT_BASE_URL = "https://buchboxberlin.de"
DEFAULT_STORE_MATCH = "Greifswalder"
# Nur als Plausibilitätsanker: zum Zeitpunkt der Analyse war Bötzowkiez
# (Greifswalder Straße 33) store=56. Die ID wird trotzdem immer live
# aus dem Formular aufgelöst, niemals fest verdrahtet.
KNOWN_GREIFSWALDER_STORE_ID = "56"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

CAPTCHA_MARKERS = (
    "g-recaptcha", "recaptcha", "hcaptcha", "h-captcha", "cf-turnstile",
    "turnstile", "captcha", "cf-challenge", "challenge-platform",
    "Attention Required! | Cloudflare", "Just a moment...",
)

ENV_KEYS = (
    "BUCHBOX_NAME", "BUCHBOX_FIRST_NAME", "BUCHBOX_LAST_NAME",
    "BUCHBOX_EMAIL", "BUCHBOX_PHONE",
    "BUCHBOX_BASE_URL", "BUCHBOX_STORE_MATCH",
)


class BotProtection(RuntimeError):
    """Ein CAPTCHA oder eine Bot-Challenge wurde erkannt."""


class ServerValidation(RuntimeError):
    def __init__(self, messages: list[str]):
        super().__init__("; ".join(messages) or "Unbekannter Validierungsfehler")
        self.messages = messages


# --------------------------------------------------------------------------- #
# Konfiguration
# --------------------------------------------------------------------------- #

def load_env_file(explicit: str | None) -> dict[str, str]:
    """Liest KEY=VALUE aus einer .env-Datei. Echte Umgebungsvariablen haben Vorrang."""
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    elif os.environ.get("BUCHBOX_ENV_FILE"):
        candidates.append(Path(os.environ["BUCHBOX_ENV_FILE"]).expanduser())
    else:
        candidates.append(Path.home() / ".config" / "buchbox" / "env")
        candidates.append(Path.cwd() / ".env")

    values: dict[str, str] = {}
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key in ENV_KEYS and key not in values:
                values[key] = val
        break  # erste gefundene Datei gewinnt
    return values


def resolve_setting(key: str, env_file: dict[str, str], default: str = "") -> str:
    return os.environ.get(key) or env_file.get(key) or default


def mask_email(email: str) -> str:
    if "@" not in email:
        return "***" if email else "(nicht gesetzt)"
    local, _, domain = email.partition("@")
    head = local[:1] if local else ""
    return f"{head}{'*' * max(len(local) - 1, 2)}@{domain}"


def mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if not digits:
        return "(leer)"
    return f"{'*' * max(len(digits) - 4, 0)}{digits[-4:]}"


def mask_name(name: str) -> str:
    parts = [p for p in name.split() if p]
    if not parts:
        return "(nicht gesetzt)"
    return " ".join([parts[0]] + [f"{p[0]}." for p in parts[1:]])


@dataclass
class Identity:
    """Wer bestellt. CLI-Parameter schlagen Umgebungsvariablen, die schlagen die .env."""
    name: str = ""
    email: str = ""
    phone: str = ""

    @property
    def missing(self) -> list[str]:
        """Pflichtfelder vor dem Absenden.

        Der Shop markiert nur Name + E-Mail als Pflicht; die Telefonnummer
        wird hier zusätzlich verlangt, damit die Filiale zur Abholung
        rückfragen kann.
        """
        out = []
        if not self.name.strip():
            out.append("Vor- und Nachname (--first-name/--last-name oder BUCHBOX_NAME)")
        if not self.email.strip():
            out.append("E-Mail (--email oder BUCHBOX_EMAIL)")
        if not self.phone.strip():
            out.append("Telefon (--phone oder BUCHBOX_PHONE)")
        return out


def resolve_identity(args, cfg: dict[str, str]) -> Identity:
    first = (getattr(args, "first_name", None) or resolve_setting("BUCHBOX_FIRST_NAME", cfg)).strip()
    last = (getattr(args, "last_name", None) or resolve_setting("BUCHBOX_LAST_NAME", cfg)).strip()
    name = (getattr(args, "name", None) or "").strip()
    if not name:
        name = " ".join(p for p in (first, last) if p)
    if not name:
        name = resolve_setting("BUCHBOX_NAME", cfg).strip()
    return Identity(
        name=name,
        email=(getattr(args, "email", None) or resolve_setting("BUCHBOX_EMAIL", cfg)).strip(),
        phone=(getattr(args, "phone", None) or resolve_setting("BUCHBOX_PHONE", cfg)).strip(),
    )


# --------------------------------------------------------------------------- #
# HTTP-Client
# --------------------------------------------------------------------------- #

@dataclass
class Client:
    base_url: str = DEFAULT_BASE_URL
    delay: float = 2.0
    timeout: float = 30.0
    verbose: bool = False
    session: requests.Session = field(default_factory=requests.Session)
    _last_request: float = 0.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "de-DE,de;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })

    def _throttle(self) -> None:
        """Ein Request zur Zeit, mit Mindestabstand. Kein Polling, keine Parallelität."""
        wait = self.delay - (time.monotonic() - self._last_request)
        if self._last_request and wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def request(self, method: str, path: str, **kw) -> requests.Response:
        self._throttle()
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        if self.verbose:
            print(f"[http] {method} {url}", file=sys.stderr)
        resp = self.session.request(method, url, timeout=self.timeout, **kw)
        self._guard(resp)
        return resp

    def get(self, path: str, **kw) -> requests.Response:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw) -> requests.Response:
        return self.request("POST", path, **kw)

    def _guard(self, resp: requests.Response) -> None:
        """Bricht ab, wenn Bot-Schutz oder Rate-Limiting auftaucht. Niemals umgehen."""
        if resp.status_code in (401, 403, 429, 503):
            retry = resp.headers.get("Retry-After", "")
            raise BotProtection(
                f"HTTP {resp.status_code} auf {resp.url}"
                + (f" (Retry-After: {retry})" if retry else "")
                + " — der Shop blockt automatisierte Zugriffe. Abbruch."
            )
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype and "json" not in ctype:
            return
        body = resp.text
        low = body.lower()
        for marker in CAPTCHA_MARKERS:
            if marker.lower() in low:
                raise BotProtection(
                    f"Bot-Schutz/CAPTCHA erkannt ('{marker}') auf {resp.url}. "
                    "Bitte im Browser fortfahren — es wird nichts umgangen."
                )


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

def _text(node) -> str:
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip() if node else ""


def parse_price(raw: str) -> tuple[float | None, str]:
    if not raw:
        return None, ""
    m = re.search(r"(\d+(?:[.,]\d{1,2})?)", raw.replace(".", ""))
    if not m:
        return None, raw.strip()
    return float(m.group(1).replace(",", ".")), raw.strip()


def ctools_html(resp: requests.Response) -> str:
    """ctools /nojs/-Endpunkte antworten mit einem JSON-Command-Array."""
    try:
        cmds = json.loads(resp.text)
    except (json.JSONDecodeError, ValueError):
        return resp.text
    if not isinstance(cmds, list):
        return resp.text
    return "".join(c.get("output", "") for c in cmds
                   if isinstance(c, dict) and isinstance(c.get("output"), str))


def server_messages(soup: BeautifulSoup) -> list[str]:
    out: list[str] = []
    for node in soup.select("div.messages, div.alert, .messages--error, .error"):
        txt = _text(node)
        if not txt:
            continue
        txt = re.sub(r"^[×x]\s*", "", txt).strip()
        txt = re.sub(r"^(Fehlermeldung|Statusmeldung|Warnung)\s*", "", txt).strip()
        if txt and txt not in out:
            out.append(txt)
    return out


def is_error_message(text: str) -> bool:
    lowered = text.lower()
    return any(k in lowered for k in (
        "erforderlich", "fehler", "ungültig", "bitte wähle", "bitte wählen",
        "abgelaufen", "nicht korrekt", "zu schnell",
    ))


ISBN_RE = re.compile(r"[\dxX]")


def normalise_isbn(raw: str) -> str:
    """ISBN-10/13 mit oder ohne Bindestriche → EAN-13 (Ziffern)."""
    digits = "".join(ISBN_RE.findall(raw or "")).upper()
    if len(digits) == 13 and digits.isdigit():
        return digits
    if len(digits) == 10:
        core = "978" + digits[:9]
        check = (10 - sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(core)) % 10) % 10
        return core + str(check)
    return digits


@dataclass
class Book:
    ean: str = ""
    title: str = ""
    subtitle: str = ""
    author: str = ""
    publisher: str = ""
    category: str = ""
    published: str = ""
    binding: str = ""
    price: float | None = None
    price_text: str = ""
    availability: str = ""
    availability_schema: str = ""
    url: str = ""
    #: True when the shop says "Erscheint am <date>" — not published yet.
    is_preorder: bool = False
    #: False when the shop offers no Abholbestellung for this article.
    pickup_available: bool = True

    @property
    def release_note(self) -> str:
        """One human line about publication state, or empty."""
        if self.is_preorder and self.published:
            return f"Vorbestellung — erscheint am {self.published}"
        if self.is_preorder:
            return "Vorbestellung — Erscheinungsdatum unbekannt"
        return ""

    @property
    def price_display(self) -> str:
        return self.price_text or (f"{self.price:.2f} €".replace(".", ",") if self.price is not None else "—")


def parse_detail(html: str, url: str = "") -> Book:
    soup = BeautifulSoup(html, "html.parser")
    root = soup.find(id="bonuswebshop-search-detail") or soup
    book = Book(url=url)

    def meta(prop: str) -> str:
        node = soup.find("meta", attrs={"itemprop": prop})
        return (node.get("content") or "").strip() if node else ""

    book.ean = meta("gtin13")
    if not book.ean and url:
        m = re.search(r"/shop/item/(\d{10,13})", url)
        book.ean = m.group(1) if m else ""

    h1 = root.find("h1")
    book.title = _text(h1)
    book.subtitle = _text(root.find(id="bonuswebshop-search-detail-info-utitel"))
    book.author = _text(root.find(id="bonuswebshop-search-detail-info-autor"))
    book.publisher = _text(root.find(id="bonuswebshop-search-detail-info-verlag"))
    book.category = _text(root.find(id="bonuswebshop-search-detail-info-wg"))
    published = _text(root.find(id="bonuswebshop-search-detail-info-erscheinungsDatum"))
    # "Erscheint am <date>" = not out yet; "Erschienen am <date>" = published.
    book.is_preorder = published.startswith("Erscheint")
    book.published = re.sub(r"^(?:Erschienen|Erscheint)\s+am\s*", "", published).strip()
    # The shop comments the Abholbestellung button out for articles it will not
    # hold for pickup (unpublished titles, e-books). An absent anchor is the
    # authoritative signal — note that schema.org availability reports InStock
    # even for a title that is months away, so it must NOT be used here.
    action = soup.find(id="bonuswebshop-search-detail-add-to-cart") or soup
    book.pickup_available = action.select_one("a.btn-reserve") is not None

    icon = root.select_one(".image-media-box span[title]")
    if icon:
        book.binding = re.sub(r"^\s*-\s*", "", icon.get("title") or "").strip()

    price_raw = meta("price")
    if price_raw:
        try:
            book.price = float(price_raw)
        except ValueError:
            book.price = None
    offer = soup.find(id="bonuswebshop-search-detail-add-to-cart-content")
    if offer:
        _, book.price_text = parse_price(_text(offer))
    if book.price is None and book.price_text:
        book.price, _ = parse_price(book.price_text)

    avail_link = soup.find("link", attrs={"itemprop": "availability"})
    if avail_link:
        book.availability_schema = (avail_link.get("href") or "").rsplit("/", 1)[-1]
    book.availability = _text(soup.select_one(".bonuswebshop-search-detail-availability-text"))
    if not book.availability and book.availability_schema:
        book.availability = book.availability_schema
    return book


def parse_result_tiles(html: str, base_url: str) -> tuple[list[Book], int | None]:
    soup = BeautifulSoup(html, "html.parser")
    container = soup.find(id="bonuswebshopframe-search") or soup
    books: list[Book] = []
    for tile in container.select("div.bonuswebhighlights-item"):
        link = tile.find("a", href=re.compile(r"^/shop/item/"))
        if not link:
            continue
        href = link.get("href", "")
        m = re.search(r"/shop/item/(\d{10,13})", href)
        book = Book(ean=m.group(1) if m else "", url=f"{base_url}{href}")
        book.title = _text(tile.select_one(".info-container .title"))
        book.author = _text(tile.select_one(".autor"))
        book.price, book.price_text = parse_price(_text(tile.select_one(".price")))
        book.pickup_available = tile.select_one("a.btn-reserve") is not None
        icon = tile.select_one(".bonuswebshop-search-result-icon span[title]")
        if icon:
            book.binding = re.sub(r"^\s*-\s*", "", icon.get("title") or "").strip()
        if book.ean:
            books.append(book)

    total = None
    m = re.search(r"von\s+([\d.]+)\s+Artikel", soup.get_text(" ", strip=True))
    if m:
        total = int(m.group(1).replace(".", ""))
    return books, total


@dataclass
class Store:
    store_id: str
    name: str
    address: str

    @property
    def label(self) -> str:
        return f"{self.name}, {self.address}" if self.address else self.name


@dataclass
class ReserveForm:
    action: str
    fields: dict[str, str]
    stores: list[Store]
    fetched_at: float


def parse_reserve_form(html: str, ean: str) -> ReserveForm:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", id="bonuswebshopframe-reserve-form")
    if form is None:
        form = soup.find("form", attrs={"id": re.compile("reserve")})
    if form is None:
        raise RuntimeError(
            "Abholbestellungs-Formular nicht gefunden — die Seitenstruktur hat sich geändert."
        )

    fields: dict[str, str] = {}
    stores: list[Store] = []
    for el in form.find_all(["input", "select", "textarea"]):
        name = el.get("name")
        if not name:
            continue
        etype = (el.get("type") or el.name or "").lower()
        if etype == "submit":
            continue
        if name == "store" and etype == "radio":
            value = el.get("value", "")
            if value in ("", "0"):
                continue
            label_node = soup.find("label", attrs={"for": el.get("id")}) or el.find_parent("label")
            strong = label_node.find("strong") if label_node else None
            name_txt = _text(strong)
            full = _text(label_node)
            address = full[len(name_txt):].strip(" ,") if name_txt and full.startswith(name_txt) else ""
            stores.append(Store(value, name_txt or full, address))
            continue
        if etype in ("radio", "checkbox"):
            continue
        if el.name == "textarea":
            fields[name] = ""
        else:
            fields[name] = el.get("value") or ""

    fields.setdefault("ean", ean)
    action = form.get("action") or f"/reserve/nojs/{ean}"
    return ReserveForm(action=action, fields=fields, stores=stores, fetched_at=time.monotonic())


def pick_store(stores: list[Store], needle: str, availability: str = "") -> Store:
    if not stores:
        # The shop renders the reserve form without any branch when the article
        # cannot be picked up at all — normal for titles that have not been
        # published yet (Vorbestellung) and for e-books/downloads. Saying "no
        # branch matches" here would blame the wrong thing.
        detail = f" Verfügbarkeit laut Shop: {availability}." if availability else ""
        raise RuntimeError(
            "Dieser Artikel wird nicht zur Abholung angeboten — die Filialauswahl "
            f"des Shops ist leer.{detail} Bei noch nicht erschienenen Titeln "
            "(Vorbestellung) und bei E-Books/Downloads ist das normal."
        )
    hits = [s for s in stores if needle.lower() in s.label.lower()]
    if not hits:
        listing = "\n".join(f"  {s.store_id}  {s.label}" for s in stores) or "  (keine)"
        raise RuntimeError(
            f"Keine Filiale enthält '{needle}'. Verfügbare Filialen:\n{listing}"
        )
    if len(hits) > 1:
        listing = "\n".join(f"  {s.store_id}  {s.label}" for s in hits)
        raise RuntimeError(
            f"'{needle}' ist nicht eindeutig — mehrere Filialen passen:\n{listing}\n"
            "Bitte --store-match präzisieren."
        )
    return hits[0]


# --------------------------------------------------------------------------- #
# Aktionen
# --------------------------------------------------------------------------- #

def fetch_detail(client: Client, ean: str) -> Book:
    resp = client.get(f"/shop/item/{ean}", allow_redirects=True)
    if resp.status_code == 404:
        raise RuntimeError(f"Kein Artikel mit ISBN/EAN {ean} gefunden.")
    book = parse_detail(resp.text, str(resp.url))
    if not book.title:
        raise RuntimeError(f"Artikelseite für {ean} nicht lesbar (Struktur geändert?).")
    if not book.ean:
        book.ean = ean
    return book


def do_search(client: Client, args) -> int:
    params: dict[str, str] = {}
    if args.isbn:
        params["ean"] = normalise_isbn(args.isbn)
    if args.author:
        params["autor"] = args.author
    if args.publisher:
        params["verlag"] = args.publisher
    if args.query:
        params["titel"] = " ".join(args.query)
    if not params:
        print("Bitte einen Suchbegriff oder --isbn/--author/--publisher angeben.", file=sys.stderr)
        return 2
    if args.page:
        params["page"] = str(args.page)

    resp = client.get("/shop/search", params=params, allow_redirects=True)

    # Exakter ISBN-Treffer leitet direkt auf die Artikelseite um.
    if "/shop/item/" in str(resp.url):
        books = [parse_detail(resp.text, str(resp.url))]
        total = 1
    else:
        books, total = parse_result_tiles(resp.text, client.base_url)

    if not books:
        print("Keine Treffer.")
        return 0

    shown = books[: args.limit]
    if args.availability:
        for book in shown:
            if not book.availability:
                try:
                    detail = fetch_detail(client, book.ean)
                except (RuntimeError, requests.RequestException) as exc:
                    book.availability = f"(nicht ermittelbar: {exc})"
                else:
                    book.availability = detail.availability
                    book.publisher = book.publisher or detail.publisher

    if args.json:
        print(json.dumps([b.__dict__ for b in shown], ensure_ascii=False, indent=2))
        return 0

    header = f"{len(shown)} von {total if total is not None else len(books)} Treffern"
    print(header)
    print("=" * len(header))
    def row(label: str, value: str) -> None:
        print(f"    {label + ':':<15}{value}")

    for i, book in enumerate(shown, 1):
        print(f"\n{i:>2}. {book.title}")
        if book.subtitle:
            print(f"    {book.subtitle}")
        if book.author:
            row("Autor", book.author)
        if book.publisher:
            row("Verlag", book.publisher)
        row("ISBN/EAN", book.ean)
        row("Preis", book.price_display)
        if book.binding:
            row("Ausführung", book.binding)
        row("Verfügbarkeit", book.availability or "— (mit --availability abrufen)")
        if book.release_note:
            row("Hinweis", book.release_note)
        elif not book.pickup_available:
            row("Hinweis", "keine Abholbestellung möglich")
        row("URL", book.url)
    if any(not b.availability for b in shown):
        print("\nHinweis: Verfügbarkeit steht nur auf der Artikelseite. "
              "--availability holt sie nach (ein Request pro Treffer).")
    return 0


def do_show(client: Client, args) -> int:
    book = fetch_detail(client, normalise_isbn(args.isbn))
    if args.json:
        print(json.dumps(book.__dict__, ensure_ascii=False, indent=2))
        return 0
    print(f"{book.title}")
    if book.subtitle:
        print(book.subtitle)
    print()
    for label, value in (
        ("Autor", book.author), ("Verlag", book.publisher), ("Kategorie", book.category),
        ("Erscheint am" if book.is_preorder else "Erschienen", book.published),
        ("Ausführung", book.binding),
        ("ISBN/EAN", book.ean), ("Preis", book.price_display),
        ("Verfügbarkeit", book.availability),
        ("Vorbestellung", book.release_note),
        ("Abholung", "" if book.pickup_available else "vom Shop nicht angeboten"),
        ("URL", book.url),
    ):
        if value:
            print(f"  {label + ':':<15} {value}")
    return 0


def do_stores(client: Client, args) -> int:
    ean = normalise_isbn(args.isbn) if args.isbn else "9783897948228"
    client.get(f"/shop/item/{ean}", allow_redirects=True)
    resp = client.get(f"/reserve/nojs/{ean}")
    form = parse_reserve_form(ctools_html(resp), ean)
    if args.json:
        print(json.dumps([s.__dict__ for s in form.stores], ensure_ascii=False, indent=2))
        return 0
    print("Abholfilialen (live aus dem Formular aufgelöst):")
    for store in form.stores:
        print(f"  store={store.store_id:<5} {store.label}")
    return 0


def print_order_summary(book: Book, store: Store, who: Identity) -> None:
    line = "─" * 58
    print(line)
    print("  BESTELLÜBERSICHT — Abholbestellung")
    print(line)
    print(f"  Titel:         {book.title}")
    if book.subtitle:
        print(f"                 {book.subtitle}")
    if book.author:
        print(f"  Autor:         {book.author}")
    print(f"  ISBN/EAN:      {book.ean}")
    print(f"  Preis:         {book.price_display}  (inkl. MwSt.)")
    print(f"  Menge:         1")
    print(f"  Verfügbarkeit: {book.availability or 'unbekannt'}")
    if book.release_note:
        print(f"  Hinweis:       {book.release_note}")
    print(line)
    print(f"  Lieferart:     Abholung (kein Versand)")
    print(f"  Filiale:       {store.label}  [store={store.store_id}]")
    print(f"  Zahlung:       vor Ort in der Filiale — keine Zahlungsdaten übertragen")
    print(line)
    print(f"  Name:          {mask_name(who.name)}")
    print(f"  E-Mail:        {mask_email(who.email)}")
    print(f"  Telefon:       {mask_phone(who.phone)}")
    print(line)


def do_order(client: Client, args, cfg: dict[str, str]) -> int:
    ean = normalise_isbn(args.isbn)
    who = resolve_identity(args, cfg)

    execute = args.execute and not args.dry_run
    if execute and who.missing:
        print("Fehlende Pflichtangaben für die Bestellung:", file=sys.stderr)
        for item in who.missing:
            print(f"  - {item}", file=sys.stderr)
        return 2

    book = fetch_detail(client, ean)
    if not book.pickup_available:
        # Caught from the article page, so this costs no extra request. The
        # reserve form would come back with an empty branch list anyway.
        when = f"erscheint am {book.published}" if book.is_preorder and book.published else "ist nicht lieferbar"
        raise RuntimeError(
            f'"{book.title}" {when} — der Shop bietet dafür keine Abholbestellung an '
            f"(Verfügbarkeit laut Shop: {book.availability or 'unbekannt'}). "
            + (
                f"Ab dem {book.published} sollte die Abholbestellung möglich sein; "
                if book.is_preorder and book.published
                else ""
            )
            + "Vorbestellungen laufen im Shop nur über den Warenkorb, der ein Kundenkonto verlangt."
        )
    resp = client.get(f"/reserve/nojs/{book.ean}")
    form = parse_reserve_form(ctools_html(resp), book.ean)
    store = pick_store(form.stores, args.store_match, book.availability)

    if store.store_id != KNOWN_GREIFSWALDER_STORE_ID and DEFAULT_STORE_MATCH.lower() in store.label.lower():
        print(f"Hinweis: Filial-ID für {DEFAULT_STORE_MATCH} ist jetzt {store.store_id} "
              f"(bei der Analyse: {KNOWN_GREIFSWALDER_STORE_ID}).", file=sys.stderr)

    def envelope(sent: bool, messages: list[str] | None = None) -> dict:
        return {
            "dry_run": not execute,
            "sent": sent,
            "delivery": "pickup",
            "payment": "on-site",
            "book": book.__dict__,
            "store": {**store.__dict__, "label": store.label},
            "orderer": {
                "name": mask_name(who.name),
                "email": mask_email(who.email),
                "phone": mask_phone(who.phone),
            },
            "missing": who.missing,
            "messages": messages or [],
        }

    if args.json:
        if not execute:
            print(json.dumps(envelope(False), ensure_ascii=False, indent=2))
            return 0
    else:
        print_order_summary(book, store, who)
        if who.missing:
            print("  Fehlt noch für --execute: " + "; ".join(who.missing))
        if not execute:
            print("  DRY RUN — es wurde nichts abgeschickt.")
            print("  Zum echten Absenden:  buchbox.py order "
                  f"{args.isbn} --execute")
            print("─" * 58)
            return 0
    if not execute:
        return 0

    if args.approved:
        # Die menschliche Bestätigung ist bereits erfolgt — über die
        # NanoClaw-Freigabekarte. Kein Terminal-Prompt, aber protokolliert.
        # stderr: stdout must stay pure JSON in --json mode
        print(f"  Freigabe {args.approved} liegt vor — sende ohne Terminal-Rückfrage.", file=sys.stderr)
    else:
        if not sys.stdin.isatty():
            print("Abbruch: --execute verlangt eine interaktive Bestätigung, "
                  "aber stdin ist kein Terminal. Für den freigegebenen "
                  "Agenten-Pfad --approved <id> verwenden.", file=sys.stderr)
            return 5
        print("  Mit dem Absenden akzeptierst Du die Datenschutzerklärung von BUCHBOX!")
        print(f"  ({client.base_url}/datenschutz)")
        try:
            answer = input("\n  Bestellung jetzt verbindlich absenden? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nAbgebrochen.", file=sys.stderr)
            return 5
        if answer not in ("y", "j", "yes", "ja"):
            print("Abgebrochen — nichts gesendet.")
            return 5

    payload = dict(form.fields)
    payload.update({
        "store": store.store_id,
        "name": who.name,
        "email": who.email,
        "phone": who.phone,
        "contact_privacy": "1",
        "op": "Senden",
    })
    payload["Link"] = ""  # Honeypot-Feld: bleibt leer, wie im Browser

    # Das Formular erzwingt eine Mindest-Ausfüllzeit. Die wird abgewartet,
    # nicht umgangen; die Bestätigung oben verbraucht sie meist schon.
    elapsed = time.monotonic() - form.fetched_at
    remaining = args.honeypot_wait - elapsed
    if remaining > 0:
        print(f"  Warte {remaining:.0f}s (Mindest-Ausfüllzeit des Formulars) …", file=sys.stderr)
        time.sleep(remaining)

    resp = client.post(
        form.action,
        data=payload,
        headers={"Referer": book.url or f"{client.base_url}/shop/item/{book.ean}"},
    )
    html = ctools_html(resp)
    soup = BeautifulSoup(html, "html.parser")
    messages = server_messages(soup)
    errors = [m for m in messages if is_error_message(m)]
    form_again = soup.find("form", id="bonuswebshopframe-reserve-form") is not None

    if errors:
        raise ServerValidation(errors)
    if form_again:
        raise ServerValidation(
            messages or ["Das Formular wurde erneut angezeigt — die Bestellung "
                         "ist wahrscheinlich NICHT eingegangen. Bitte im Browser prüfen."]
        )

    if args.json:
        print(json.dumps(envelope(True, messages), ensure_ascii=False, indent=2))
        return 0
    print("\n  ✓ Abholbestellung abgeschickt.")
    for msg in messages:
        print(f"  Server: {msg}")
    print(f"  Eine Bestätigungs-E-Mail geht an {mask_email(who.email)}.")
    print(f"  Abholung: {store.label}")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="buchbox.py",
        description="Bücher bei BUCHBOX! Berlin suchen und zur Abholung bestellen.",
        epilog="Lieferart ist immer Abholung. Zahlung erfolgt vor Ort.",
    )
    p.add_argument("--base-url", default=None, help=f"Shop-Basis-URL (Default: {DEFAULT_BASE_URL})")
    p.add_argument("--env-file", default=None, help="Pfad zur .env-Datei")
    p.add_argument("--delay", type=float, default=2.0, help="Mindestabstand zwischen Requests in s (Default: 2)")
    p.add_argument("--json", action="store_true", help="Ausgabe als JSON")
    p.add_argument("-v", "--verbose", action="store_true", help="HTTP-Requests auf stderr loggen")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="Bücher suchen")
    s.add_argument("query", nargs="*", help="Stichwort / Titel")
    s.add_argument("--isbn", help="Suche per ISBN/EAN")
    s.add_argument("--author", help="Suche per Autor")
    s.add_argument("--publisher", help="Suche per Verlag")
    s.add_argument("--limit", type=int, default=10, help="Max. Treffer anzeigen (Default: 10)")
    s.add_argument("--page", type=int, default=0, help="Ergebnisseite (0-basiert)")
    s.add_argument("--availability", action="store_true",
                   help="Verfügbarkeit nachladen (ein zusätzlicher Request pro Treffer)")

    d = sub.add_parser("show", help="Artikeldetails anzeigen")
    d.add_argument("isbn")

    st = sub.add_parser("stores", help="Abholfilialen und ihre IDs auflisten")
    st.add_argument("--isbn", default=None, help="Artikel, über den das Formular geholt wird")

    o = sub.add_parser("order", help="Abholbestellung (Default: Dry-Run)")
    o.add_argument("isbn")
    o.add_argument("--dry-run", action="store_true", help="Nur Zusammenfassung zeigen (Default)")
    o.add_argument("--execute", action="store_true",
                   help="Wirklich bestellen — fragt vorher im Terminal nach (y/N)")
    o.add_argument("--first-name", default=None, help="Vorname des Bestellers")
    o.add_argument("--last-name", default=None, help="Nachname des Bestellers")
    o.add_argument("--name", default=None, help="Vor- und Nachname zusammen (Alternative)")
    o.add_argument("--email", default=None, help="E-Mail für die Abholbenachrichtigung")
    o.add_argument("--phone", default=None, help="Telefonnummer (optional, aber empfohlen)")
    o.add_argument("--store-match", default=None,
                   help=f"Filiale per Textsuche wählen (Default: {DEFAULT_STORE_MATCH})")
    o.add_argument("--approved", metavar="APPROVAL_ID", default=None,
                   help="Freigabe-ID aus dem NanoClaw-Approval-Flow: ersetzt die "
                        "Terminal-Rückfrage (die Bestätigung ist dort erfolgt)")
    o.add_argument("--honeypot-wait", type=float, default=12.0,
                   help="Mindest-Ausfüllzeit des Formulars in s (Default: 12)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_env_file(args.env_file)

    base_url = args.base_url or resolve_setting("BUCHBOX_BASE_URL", cfg, DEFAULT_BASE_URL)
    if args.cmd == "order" and not args.store_match:
        args.store_match = resolve_setting("BUCHBOX_STORE_MATCH", cfg, DEFAULT_STORE_MATCH)

    client = Client(base_url=base_url, delay=max(args.delay, 0.0), verbose=args.verbose)

    try:
        if args.cmd == "search":
            return do_search(client, args)
        if args.cmd == "show":
            return do_show(client, args)
        if args.cmd == "stores":
            return do_stores(client, args)
        if args.cmd == "order":
            return do_order(client, args, cfg)
    except BotProtection as exc:
        print(f"\nBOT-SCHUTZ: {exc}", file=sys.stderr)
        return 3
    except ServerValidation as exc:
        print("\nDer Shop hat die Eingaben abgelehnt:", file=sys.stderr)
        for msg in exc.messages:
            print(f"  - {msg}", file=sys.stderr)
        return 4
    except KeyboardInterrupt:
        print("\nAbgebrochen.", file=sys.stderr)
        return 5
    except requests.RequestException as exc:
        print(f"Netzwerkfehler: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
