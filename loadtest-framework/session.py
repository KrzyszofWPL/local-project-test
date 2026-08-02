"""
Pojedyncza sesja testowa: 1 BrowserContext = 1 proxy SOCKS5 + 1 fingerprint +
własne cookies/localStorage/cache, całkowicie odizolowane od pozostałych sesji.

Playwright izoluje BrowserContext-y natywnie (osobny storage per kontekst);
nie trzeba osobnego profilu na dysku dopóki nie chcesz przetrwać restartu
(patrz storage_state_path poniżej, analogicznie do "persistent profile").
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import Browser, BrowserContext, Page

from behavior import HumanBehavior
from config import Settings, assert_target_allowed
from fingerprint import FingerprintProfile, build_fingerprint
from proxy_pool import ProxyPool, Socks5Proxy

logger = logging.getLogger(__name__)


@dataclass
class SessionResult:
    session_id: str
    ok: bool
    error: str | None = None
    metrics: dict | None = None


class TestSession:
    def __init__(self, session_id: str, browser: Browser, proxy: Socks5Proxy,
                 fingerprint: FingerprintProfile, settings: Settings,
                 profile_dir: Path | None = None):
        self.session_id = session_id
        self._browser = browser
        self.proxy = proxy
        self.fingerprint = fingerprint
        self.settings = settings
        self.behavior = HumanBehavior(seed=f"{settings.random_seed}:{session_id}")
        self._context: BrowserContext | None = None
        self.page: Page | None = None
        # Opcjonalny trwały profil (np. dla scenariuszy "powracający użytkownik").
        # Domyślnie None -> świeży, w pełni izolowany kontekst za każdym razem.
        self._storage_state_path = (
            str(profile_dir / f"{session_id}.json") if profile_dir else None
        )

    async def __aenter__(self) -> "TestSession":
        storage_state = None
        if self._storage_state_path and Path(self._storage_state_path).exists():
            storage_state = self._storage_state_path

        self._context = await self._browser.new_context(
            proxy=self.proxy.playwright_proxy(),
            storage_state=storage_state,
            **self.fingerprint.as_context_kwargs(),
        )
        self.page = await self._context.new_page()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._context is None:
            return
        if self._storage_state_path:
            try:
                await self._context.storage_state(path=self._storage_state_path)
            except Exception:
                logger.exception("session %s: nie udało się zapisać storage_state",
                                  self.session_id)
        await self._context.close()

    async def goto(self, url: str, **kwargs):
        # Guardrail wymuszony na poziomie kodu, nie tylko configu — patrz config.py.
        assert_target_allowed(url, self.settings)
        return await self.page.goto(url, **kwargs)

    async def verify_exit_ip(self, check_url: str = "https://api.ipify.org?format=json") -> str:
        res = await self._context.request.get(check_url, timeout=20_000)
        data = await res.json()
        return data["ip"]


def make_session(session_id: str, browser: Browser, proxy_pool: ProxyPool,
                  settings: Settings, profile_dir: Path | None = None) -> TestSession:
    proxy = proxy_pool.next()
    fingerprint = build_fingerprint(session_id, settings.random_seed)
    return TestSession(session_id, browser, proxy, fingerprint, settings, profile_dir)
