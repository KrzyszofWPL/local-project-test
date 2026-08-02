"""
Orkiestracja N równoległych sesji testowych, każda z własnym proxy SOCKS5,
fingerprintem i izolowanym kontekstem przeglądarki.

Uruchamia dostarczony `scenario(session) -> dict` na `total_sessions` sesjach,
maksymalnie `concurrency` naraz (semafor), zbiera SessionResult z metrykami
(np. czas ładowania, kody odpowiedzi) do prostej analizy po teście.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from playwright.async_api import async_playwright

from config import Settings, assert_target_allowed
from proxy_pool import ProxyPool
from session import SessionResult, make_session

logger = logging.getLogger(__name__)

Scenario = Callable[["session.TestSession"], Awaitable[dict]]  # noqa: F821


async def run_load_test(settings: Settings, proxy_pool: ProxyPool,
                         scenario: Scenario) -> list[SessionResult]:
    # Fail fast: nie otwieraj ani jednej przeglądarki, jeśli cel nie jest dozwolony.
    assert_target_allowed(settings.target_base_url, settings)

    results: list[SessionResult] = []
    semaphore = asyncio.Semaphore(settings.concurrency)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=settings.headless)
        try:
            async def run_one(idx: int) -> SessionResult:
                session_id = f"sess-{idx:05d}"
                async with semaphore:
                    t0 = time.monotonic()
                    try:
                        async with make_session(session_id, browser, proxy_pool,
                                                 settings) as sess:
                            metrics = await scenario(sess)
                            metrics = {**(metrics or {}),
                                       "duration_s": time.monotonic() - t0,
                                       "proxy": sess.proxy.label()}
                            return SessionResult(session_id, ok=True, metrics=metrics)
                    except Exception as e:
                        logger.exception("session %s failed", session_id)
                        return SessionResult(session_id, ok=False, error=str(e))

            tasks = [run_one(i) for i in range(settings.total_sessions)]
            results = await asyncio.gather(*tasks)
        finally:
            await browser.close()

    ok = sum(1 for r in results if r.ok)
    logger.info("Load test done: %d/%d sesji OK", ok, len(results))
    return list(results)
