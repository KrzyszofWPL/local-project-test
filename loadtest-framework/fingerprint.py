"""
Generowanie unikalnego, ale WEWNĘTRZNIE SPÓJNEGO profilu przeglądarki na sesję.

Spójność ma znaczenie: viewport, User-Agent, locale i timezone muszą się
zgadzać (np. UA Windows + timezone Europe/Warsaw + locale pl-PL), inaczej
Twój własny system anty-bot powinien to złapać jako niespójny fingerprint —
i to jest dokładnie sygnał, który chcesz móc wygenerować (spójny) albo
złamać celowo (niespójny) podczas testów.

Deterministyczne per-session: seed globalny + session_id -> ten sam profil
przy powtórnym uruchomieniu z tym samym ID, co ułatwia debugowanie failing
runów zamiast gonić za nieodtwarzalnym stanem.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

# Kilka spójnych "person" (OS + przeglądarka + UA szablon). Rozszerzaj wg potrzeb;
# trzymaj UA zgodne z realnymi wersjami, bo stare/nieistniejące UA są same w sobie
# sygnałem dla detekcji.
_PERSONAS = [
    dict(
        os="Windows", browser="Chrome",
        ua_tmpl="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/{v} Safari/537.36",
        versions=["124.0.6367.91", "123.0.6312.122", "125.0.6422.60"],
        viewports=[(1920, 1080), (1366, 768), (1536, 864)],
    ),
    dict(
        os="macOS", browser="Safari",
        ua_tmpl="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                "(KHTML, like Gecko) Version/{v} Safari/605.1.15",
        versions=["17.4", "17.3.1", "17.2"],
        viewports=[(1440, 900), (1680, 1050)],
    ),
    dict(
        os="Linux", browser="Firefox",
        ua_tmpl="Mozilla/5.0 (X11; Linux x86_64; rv:{v}) Gecko/20100101 Firefox/{v}",
        versions=["125.0", "124.0"],
        viewports=[(1920, 1080), (1280, 1024)],
    ),
]

_LOCALES = [
    ("pl-PL", "Europe/Warsaw"),
    ("en-US", "America/New_York"),
    ("de-DE", "Europe/Berlin"),
    ("en-GB", "Europe/London"),
    ("fr-FR", "Europe/Paris"),
]


@dataclass(frozen=True)
class FingerprintProfile:
    session_id: str
    user_agent: str
    viewport: dict  # {"width": int, "height": int}
    locale: str
    timezone_id: str
    extra_http_headers: dict = field(default_factory=dict)

    def as_context_kwargs(self) -> dict:
        """Kwargs gotowe pod browser.new_context(**kwargs)."""
        return dict(
            user_agent=self.user_agent,
            viewport=self.viewport,
            locale=self.locale,
            timezone_id=self.timezone_id,
            extra_http_headers=self.extra_http_headers,
        )


def build_fingerprint(session_id: str, global_seed: int) -> FingerprintProfile:
    # Seed lokalny do tego RNG, deterministyczny, ale niezależny od innych sesji —
    # zmiana jednej sesji nie przesuwa profili wszystkich pozostałych.
    rng = random.Random(f"{global_seed}:{session_id}")

    persona = rng.choice(_PERSONAS)
    version = rng.choice(persona["versions"])
    width, height = rng.choice(persona["viewports"])
    locale, timezone_id = rng.choice(_LOCALES)

    user_agent = persona["ua_tmpl"].format(v=version)

    return FingerprintProfile(
        session_id=session_id,
        user_agent=user_agent,
        viewport={"width": width, "height": height},
        locale=locale,
        timezone_id=timezone_id,
        extra_http_headers={
            "Accept-Language": f"{locale},{locale.split('-')[0]};q=0.9",
        },
    )
