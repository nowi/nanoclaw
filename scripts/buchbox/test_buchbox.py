#!/usr/bin/env python3
"""Hermetic tests for buchbox.py against a local stub of the shop.

Covers the one path that cannot be exercised against the real shop without
placing a paid order: a *successful* submit. The stub also lets the
bot-protection abort and the validation-error path be asserted deterministically.

Run:  ./.venv/bin/python test_buchbox.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "buchbox.py"
EAN = "9783897948228"

DETAIL_HTML = f"""<!DOCTYPE html><html><body>
<div id="bonuswebshop-search-detail">
  <div class="image-media-box"><span title=" - Englische Broschur"></span></div>
  <h1>TRESCHER Reiseführer Sansibar</h1>
  <div id="bonuswebshop-search-detail-info-autor">Chengula, Francisca</div>
  <div id="bonuswebshop-search-detail-info-verlag">Trescher Verlag GmbH</div>
</div>
<div id="bonuswebshop-search-detail-add-to-cart-content">19,95 €
  <meta itemprop="price" content="19.95">
  <meta itemprop="gtin13" content="{EAN}">
  <link itemprop="availability" href="http://schema.org/InStock"/>
</div>
<p class="bonuswebshop-search-detail-availability-text">In 1-2 Werktagen im Laden</p>
</body></html>"""

RESERVE_FORM = f"""<form action="/reserve/nojs/{EAN}" method="post" id="bonuswebshopframe-reserve-form">
<div class="form-radios" id="edit-store">
  <label for="edit-store-0"><input id="edit-store-0" name="store" type="radio" value="0"/>Bitte wähle einen Abholort</label>
  <label for="edit-store-53"><input id="edit-store-53" name="store" type="radio" value="53"/>
    <div class="reserve-label"><strong>BUCHBOX! Kastanienallee</strong><br/>Kastanienallee 97<br/>10435 Berlin</div></label>
  <label for="edit-store-56"><input id="edit-store-56" name="store" type="radio" value="56"/>
    <div class="reserve-label"><strong>BUCHBOX! Bötzowkiez</strong><br/>Greifswalder Straße 33<br/>10405 Berlin</div></label>
</div>
<input name="name" type="text" value=""/>
<input name="email" type="text" value=""/>
<input name="phone" type="text" value=""/>
<input name="contact_privacy" type="checkbox" value="1"/>
<input name="ean" type="hidden" value="{EAN}"/>
<input name="form_build_id" type="hidden" value="form-STUB123"/>
<input name="form_id" type="hidden" value="bonuswebshopframe_reserve_form"/>
<input name="honeypot_time" type="hidden" value="1790000000|stubtoken"/>
<input name="Link" type="text" value=""/>
<input name="op" type="submit" value="Senden"/>
</form>"""


def ctools(output: str) -> bytes:
    return json.dumps([
        {"command": "settings", "merge": True},
        {"command": "modal_display", "title": "Abholbestellung", "output": output},
    ]).encode("utf-8")


class Stub(BaseHTTPRequestHandler):
    mode = "success"
    last_post: dict[str, list[str]] = {}

    def log_message(self, *a):  # silence
        pass

    def _send(self, body: bytes, status: int = 200, ctype: str = "text/html; charset=UTF-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if Stub.mode == "captcha":
            return self._send(b"<html><body><div class='g-recaptcha'></div></body></html>")
        if self.path.startswith("/shop/item/"):
            return self._send(DETAIL_HTML.encode("utf-8"))
        if self.path.startswith("/reserve/nojs/"):
            return self._send(ctools(RESERVE_FORM))
        return self._send(b"not found", 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        Stub.last_post = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
        if Stub.mode == "validation":
            body = ('<div class="messages error">Das Feld E-Mail-Adresse ist erforderlich.</div>'
                    + RESERVE_FORM)
            return self._send(ctools(body))
        return self._send(ctools(
            '<div class="messages status">Vielen Dank! Wir legen den Artikel für dich bereit.</div>'))


class BuchboxCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_cli(self, *args, identity=True):
        env = {
            "PATH": "/usr/bin:/bin",
            "BUCHBOX_ENV_FILE": "/dev/null",
            "BUCHBOX_BASE_URL": self.base,
        }
        if identity:
            env.update({
                "BUCHBOX_FIRST_NAME": "Test",
                "BUCHBOX_LAST_NAME": "Person",
                "BUCHBOX_EMAIL": "test@example.org",
                "BUCHBOX_PHONE": "+49 170 0000000",
            })
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--delay", "0", *args],
            capture_output=True, text=True, env=env, timeout=60, stdin=subprocess.DEVNULL,
        )

    def test_dry_run_sends_nothing(self):
        Stub.mode, Stub.last_post = "success", {}
        r = self.run_cli("--json", "order", EAN)
        self.assertEqual(r.returncode, 0, r.stderr)
        env = json.loads(r.stdout)
        self.assertTrue(env["dry_run"])
        self.assertFalse(env["sent"])
        self.assertEqual(env["store"]["store_id"], "56")
        self.assertIn("Greifswalder", env["store"]["label"])
        self.assertEqual(Stub.last_post, {}, "a dry run must not POST")

    def test_execute_without_tty_and_without_approval_refuses(self):
        Stub.mode, Stub.last_post = "success", {}
        r = self.run_cli("order", EAN, "--execute")
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        self.assertEqual(Stub.last_post, {}, "must not POST without confirmation")

    def test_approved_execute_places_the_order(self):
        Stub.mode, Stub.last_post = "success", {}
        r = self.run_cli("--json", "order", EAN, "--execute", "--approved", "appr-1",
                         "--honeypot-wait", "0")
        self.assertEqual(r.returncode, 0, r.stderr)
        env = json.loads(r.stdout)
        self.assertTrue(env["sent"])
        self.assertFalse(env["dry_run"])
        post = Stub.last_post
        self.assertEqual(post["store"], ["56"])
        self.assertEqual(post["contact_privacy"], ["1"])
        self.assertEqual(post["name"], ["Test Person"])
        self.assertEqual(post["email"], ["test@example.org"])
        self.assertEqual(post["Link"], [""], "honeypot decoy must stay empty")
        self.assertEqual(post["form_build_id"], ["form-STUB123"])
        self.assertEqual(post["op"], ["Senden"])

    def test_identity_never_leaks_unmasked(self):
        Stub.mode = "success"
        r = self.run_cli("order", EAN)
        self.assertNotIn("test@example.org", r.stdout)
        self.assertNotIn("0000000", r.stdout)
        self.assertNotIn("Test Person", r.stdout)
        self.assertIn("Test P.", r.stdout)  # surname masked to an initial

    def test_missing_phone_blocks_execute(self):
        Stub.mode, Stub.last_post = "success", {}
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "--delay", "0", "order", EAN, "--execute",
             "--first-name", "A", "--last-name", "B", "--email", "a@b.de"],
            capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "BUCHBOX_ENV_FILE": "/dev/null",
                 "BUCHBOX_BASE_URL": self.base},
        )
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("Telefon", r.stderr)
        self.assertEqual(Stub.last_post, {})

    def test_server_validation_error_is_reported(self):
        Stub.mode = "validation"
        r = self.run_cli("order", EAN, "--execute", "--approved", "appr-2", "--honeypot-wait", "0")
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertIn("E-Mail-Adresse ist erforderlich", r.stderr)

    def test_captcha_aborts(self):
        Stub.mode = "captcha"
        try:
            r = self.run_cli("order", EAN)
            self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
            self.assertIn("BOT-SCHUTZ", r.stderr)
        finally:
            Stub.mode = "success"


if __name__ == "__main__":
    unittest.main(verbosity=2)
