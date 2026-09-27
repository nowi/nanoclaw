# buchbox — Bücher bei BUCHBOX! Berlin suchen und zur Abholung bestellen

Ein kleiner Python-CLI für den Webshop von BUCHBOX! Berlin. Sucht Bücher per
Titel, Autor, Verlag oder ISBN und gibt **Abholbestellungen** auf — nie Versand,
standardmäßig immer in der Filiale **Greifswalder Straße 33** (BUCHBOX!
Bötzowkiez). Bezahlt wird vor Ort, es werden also keine Zahlungsdaten
übertragen oder gespeichert.

> **Die Domain aus dem Auftrag ist nicht der Shop.** `buchbox.de` ist eine
> geparkte Fremddomain und leitet auf `inspiration.de` um. Der echte Shop läuft
> auf `buchboxberlin.de`. Details in [ENDPOINTS.md](ENDPOINTS.md).

## Setup

```bash
cd scripts/buchbox
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

Danach entweder `./.venv/bin/python buchbox.py …` aufrufen oder die venv
aktivieren (`source .venv/bin/activate`).

## Zugangsdaten / `.env`

Es gibt kein Login. Für eine Bestellung braucht der Shop nur Name, E-Mail und
(optional, hier verpflichtend) Telefonnummer. Diese Werte stehen **nie im Code
und nie in Logs** — sie kommen aus Umgebungsvariablen oder einer `.env`.

Suchreihenfolge:

1. echte Umgebungsvariablen (haben immer Vorrang)
2. `$BUCHBOX_ENV_FILE`, falls gesetzt
3. `~/.config/buchbox/env`  ← empfohlen, liegt außerhalb des Repos
4. `./.env` im aktuellen Verzeichnis

Diese Datei ist gleichzeitig der **Standard-Besteller für Agenten**: lässt eine
`buchbox_order`-Anfrage Name, E-Mail oder Telefon weg, füllt der Host sie hier
auf. Ein Agent schickt also normalerweise nur die ISBN und übergibt Identitäts-
felder nur, wenn für jemand anderen bestellt wird. Ohne konfigurierten Standard
wird eine ISBN-only-Anfrage abgelehnt, nicht anonym verschickt.

Beispiel `~/.config/buchbox/env`:

```ini
# Wer bestellt
BUCHBOX_FIRST_NAME=Philipp
BUCHBOX_LAST_NAME=Mustermann
BUCHBOX_EMAIL=philipp@example.de
BUCHBOX_PHONE=+49 170 1234567

# Optional
# BUCHBOX_NAME=Philipp Mustermann       # Alternative zu FIRST/LAST
# BUCHBOX_BASE_URL=https://buchboxberlin.de
# BUCHBOX_STORE_MATCH=Greifswalder      # Filialauswahl per Textsuche
```

```bash
chmod 600 ~/.config/buchbox/env
```

Auf der Kommandozeile gehen die Angaben auch direkt mit — das übersteuert die
`.env`:

```bash
buchbox.py order <ISBN> --first-name Philipp --last-name Mustermann \
  --email philipp@example.de --phone "+49 170 1234567"
```

In der Terminalausgabe erscheinen Name, E-Mail und Telefon **immer maskiert**
(`Philipp M.`, `p******@example.de`, `********4567`).

## Nutzung

```bash
# Suchen — Titel, Autor, ISBN, Preis
buchbox.py search "Sansibar"
buchbox.py search "Sansibar" --limit 5 --availability   # + Verfügbarkeit
buchbox.py search --author "Andersch, Alfred"
buchbox.py search --isbn 978-3-89794-822-8

# Details zu einem Titel
buchbox.py show 978-3-89794-822-8

# Abholfilialen und ihre IDs (live aufgelöst)
buchbox.py stores

# Bestellen — DRY RUN ist der Standard, es wird nichts gesendet
buchbox.py order 978-3-89794-822-8

# Wirklich bestellen: zeigt die Zusammenfassung und fragt y/N
buchbox.py order 978-3-89794-822-8 --execute
```

Globale Optionen: `--json`, `-v/--verbose`, `--delay <s>`, `--base-url`,
`--env-file`.

### Verfügbarkeit in der Trefferliste

Die Trefferliste des Shops enthält keine Verfügbarkeit — die steht nur auf der
Artikelseite. `--availability` holt sie nach, mit **einem zusätzlichen Request
pro Treffer**. Deshalb ist sie nicht der Standard.

### Bestellung: die zwei Bestätigungswege

Jede echte Bestellung braucht eine menschliche Zusage. Es gibt genau zwei Wege:

| Weg | Gate |
|---|---|
| Du im Terminal | `--execute` zeigt Titel, Preis, Lieferart, Filiale und fragt `[y/N]` |
| NanoClaw-Agent | `buchbox_order`-MCP-Tool → Freigabekarte an einen Admin; erst nach Freigabe wird gesendet |

`--execute` verweigert die Arbeit, wenn stdin kein Terminal ist. Es gibt kein
`--yes`: ein unbeaufsichtigter Prozess kann auf diesem Weg nichts bestellen.
Der Agentenpfad nutzt `--approved <id>`, wo die Zusage bereits auf der
Freigabekarte erfolgt ist.

Mit dem Absenden wird die Datenschutzerklärung des Shops akzeptiert
(`contact_privacy=1`). Das steht im Klartext über der `y/N`-Frage.

### Exit-Codes

| Code | Bedeutung |
|---|---|
| 0 | Erfolg |
| 1 | Fehler (Netzwerk, Struktur) |
| 2 | Benutzungsfehler / Pflichtangabe fehlt |
| 3 | **Bot-Schutz / CAPTCHA erkannt — Abbruch** |
| 4 | Server hat die Eingaben abgelehnt |
| 5 | Abgebrochen (auch: `n` bei der Rückfrage) |

## Tests

```bash
./.venv/bin/python test_buchbox.py
```

Sieben Tests gegen einen lokalen Stub des Shops — keine echte Bestellung, kein
Netz. Sie prüfen unter anderem, dass ein Dry-Run **nie** POSTet, dass
`--execute` ohne Bestätigung verweigert, dass der freigegebene Pfad `store=56`
und `contact_privacy=1` mit leerem Honeypot-Feld sendet, und dass CAPTCHA
(Code 3) und Server-Fehler (Code 4) korrekt abbrechen.

## Rücksichtnahme und Grenzen

- **Ein Request zur Zeit**, Mindestabstand 2 s (`--delay`), keine
  Parallelisierung, kein Polling, keine automatischen Retries.
- **Kein Umgehen von Schutzmechanismen.** Taucht ein CAPTCHA auf oder antwortet
  der Server `401/403/429/503`, bricht der Client mit Code 3 ab und meldet es.
- Das Reservierungsformular hat eine Mindest-Ausfüllzeit (Drupal Honeypot). Der
  Client **wartet sie ab** (`--honeypot-wait`, Standard 12 s) statt sie zu
  unterlaufen; die `y/N`-Rückfrage verbraucht sie meist schon.
- Der Decoy-Feld `Link` bleibt leer — genau wie im Browser.
- `robots.txt` nennt `Crawl-delay: 10`. Der Client ist kein Crawler (eine
  Handvoll von Menschen ausgelöster Requests), aber für Massenabfragen sollte
  `--delay 10` gesetzt werden.
- **Keine Zahlungsdaten**, nirgends. Der Abholweg kennt keine.
- Automatisierter Zugriff kann den AGB des Shops widersprechen. Das Werkzeug
  ist für den Eigenbedarf gedacht; bei Zweifeln kurz beim Laden fragen.

## Was daran fragil ist

Der Shop hat keine API. Alles hier ist aus dem HTML gelesen und bricht, wenn
sich das HTML ändert. Nach Wichtigkeit sortiert:

1. **Filial-IDs (`store=…`)** — Drupal-Node-Referenzen, die sich bei jeder
   Pflege ändern können. *Abgesichert:* nie hartkodiert; der Client liest die
   Radio-Labels live und matcht auf "Greifswalder". Findet er keine oder mehrere
   passende Filialen, bricht er ab statt zu raten. Weicht die ID von der
   dokumentierten `56` ab, gibt es einen Hinweis. **Ändert der Laden den
   Straßennamen im Label, muss `--store-match` / `BUCHBOX_STORE_MATCH`
   angepasst werden.**
2. **Formularfelder des Reservierungsformulars** (`store`, `name`, `email`,
   `phone`, `contact_privacy`) — werden live aus dem Formular gelesen, aber die
   fünf Namen sind im Code fest. Kommt ein neues Pflichtfeld hinzu, schlägt die
   Bestellung mit Exit 4 und der deutschen Server-Meldung fehl (kein stiller
   Fehlschlag).
3. **Erfolgserkennung** — der Server antwortet bei Erfolg *und* Fehler mit
   HTTP 200 und ctools-JSON. Unterschieden wird über Fehlerblöcke und darüber,
   ob das Formular erneut ausgeliefert wird. Ändert sich das Markup der
   Meldungen, kann eine erfolgreiche Bestellung als "nicht gesendet" gemeldet
   werden — konservativ, aber dann bitte im Postfach prüfen.
4. **CSS-Selektoren der Trefferliste** (`#bonuswebshopframe-search`,
   `div.bonuswebhighlights-item`, `.title`, `.autor`, `.price`) — reines
   Theme-Markup und am ehesten Änderungen unterworfen. Bricht als "Keine
   Treffer", nicht als Absturz.
5. **Detailseite** — die Schema.org-Microdata (`itemprop=price`, `gtin13`,
   `availability`) sind stabiler als die CSS-Klassen. Der Verfügbarkeitstext
   `.bonuswebshop-search-detail-availability-text` ist Theme-Markup.
6. **Honeypot-Zeitfenster** — steigt das Minimum über 12 s, muss
   `--honeypot-wait` hoch. Symptom: Exit 4 mit einer Meldung über zu schnelles
   Ausfüllen.
7. **Suchpfad `/shop/search`** — abgeleitet aus dem Redirect des POST-Formulars.
   Fällt er weg, bleibt der POST auf `/shop` mit `form_id=
   bonuswebshopframe_frontpage` als Rückfallebene (dann *mit* Honeypot).
8. **Plattform-Updates** — `bhwp` / `bonuswebshopframe` ist eine
   White-Label-Distribution für viele Buchhandlungen; ein Plattform-Update
   ändert das Markup bei allen gleichzeitig.

Wenn etwas bricht: `ENDPOINTS.md` beschreibt jeden Endpunkt, jedes Feld und
jeden Selektor mit Stand 2026-09-27 — das ist die Referenz zum Nachziehen.
