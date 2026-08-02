"""
Przykładowy scenariusz + punkt wejścia.

Wymagane zmienne środowiskowe:
    LOADTEST_ALLOWED_HOSTS=staging.twoja-domena.pl
    LOADTEST_TARGET_URL=https://staging.twoja-domena.pl/login
    LOADTEST_PROXY_FILE=socks5_proxies.txt

Uruchomienie:
    pip install -r requirements.txt
    playwright install chromium
    python example_scenario.py
"""
from __future__ import annotations

import asyncio
import logging

from config import SETTINGS
from orchestrator import run_load_test
from proxy_pool import ProxyPool
from session import TestSession

logging.basicConfig(level=logging.INFO)


async def login_scenario(sess: TestSession) -> dict:
    """
    Scenariusz jednej sesji: wejdź na stronę logowania, poczekaj (namysł),
    kliknij pole, wpisz dane po znaku, kliknij submit — całość z ruchem
    myszy po krzywej Beziera i opóźnieniami z rozkładu Gaussa.
    """
    b = sess.behavior

    exit_ip = await sess.verify_exit_ip()
    await sess.goto(sess.settings.target_base_url, wait_until="domcontentloaded")
    await b.wait_think(mean=1.5, sigma=0.5)

    email_field = sess.page.locator("input[name='email']")
    password_field = sess.page.locator("input[name='password']")
    submit_btn = sess.page.locator("button[type='submit']")

    await b.human_click(sess.page, email_field)
    await b.human_type(sess.page, email_field, f"loadtest+{sess.session_id}@example.test")

    await b.wait_think(mean=0.6, sigma=0.2)
    await b.human_click(sess.page, password_field)
    await b.human_type(sess.page, password_field, "TestPassword123!")

    await b.wait_think(mean=0.4, sigma=0.15)
    await b.human_click(sess.page, submit_btn)

    return {"exit_ip": exit_ip, "fingerprint_ua": sess.fingerprint.user_agent}


async def main() -> None:
    proxy_pool = ProxyPool.from_file(SETTINGS.proxy_file)
    results = await run_load_test(SETTINGS, proxy_pool, login_scenario)

    ok = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]
    print(f"\nOK: {len(ok)}  FAILED: {len(failed)}")
    for r in failed[:10]:
        print(f"  {r.session_id}: {r.error}")


if __name__ == "__main__":
    asyncio.run(main())
