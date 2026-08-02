"""
Konfiguracja frameworka.

Twardy guardrail: TARGET_BASE_URL musi mieć hosta z ALLOWED_TARGET_HOSTS.
To nie jest sugestia w komentarzu — session.py odmawia nawigacji poza tę
listę (patrz TestSession.goto). Framework służy do red-teamingu WŁASNEGO
systemu anty-bot/WAF, nie do generowania ruchu wobec cudzych usług.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    # Hosty, na które WOLNO nawigować. Dodaj tu tylko domeny, które kontrolujesz.
    allowed_target_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset(
            h.strip()
            for h in os.environ.get("LOADTEST_ALLOWED_HOSTS", "").split(",")
            if h.strip()
        )
    )

    target_base_url: str = os.environ.get("LOADTEST_TARGET_URL", "")

    proxy_file: str = os.environ.get("LOADTEST_PROXY_FILE", "socks5_proxies.txt")

    # Ile sesji na raz (osobny BrowserContext = osobne cookies/localStorage/proxy).
    concurrency: int = int(os.environ.get("LOADTEST_CONCURRENCY", "10"))
    total_sessions: int = int(os.environ.get("LOADTEST_TOTAL_SESSIONS", "50"))

    headless: bool = os.environ.get("LOADTEST_HEADLESS", "true").lower() != "false"

    # Ziarno globalne — deterministyczne uruchomienia do debugowania,
    # a jednocześnie unikalne per-sesja (patrz fingerprint.py: seed + session_id).
    random_seed: int = int(os.environ.get("LOADTEST_SEED", "1337"))


SETTINGS = Settings()


def assert_target_allowed(url: str, settings: Settings = SETTINGS) -> None:
    from urllib.parse import urlparse

    host = urlparse(url).hostname or ""
    if not settings.allowed_target_hosts:
        raise RuntimeError(
            "LOADTEST_ALLOWED_HOSTS jest puste — ustaw je na hosty, które "
            "kontrolujesz, zanim uruchomisz jakąkolwiek sesję."
        )
    if host not in settings.allowed_target_hosts:
        raise RuntimeError(
            f"Host '{host}' nie jest na liście allowed_target_hosts "
            f"({sorted(settings.allowed_target_hosts)}). Nawigacja odrzucona."
        )
