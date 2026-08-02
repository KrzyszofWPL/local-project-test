"""
Pula proxy SOCKS5 wczytywana z pliku (jedna linia = jeden proxy) lub z bazy.

Playwright wspiera SOCKS5 natywnie w konfiguracji `proxy={"server": "socks5://..."}`
zarówno na poziomie przeglądarki, jak i kontekstu — nie trzeba żadnego wrappera.
Dla warstwy HTTP (httpx, np. do wywołań API bez przeglądarki) SOCKS5 wymaga
ekstrasa: `pip install httpx[socks]`, a potem `httpx.AsyncClient(proxy="socks5://host:port")`.

Format linii w pliku:
    host:port
    host:port:user:pass
    user:pass@host:port
Linie zaczynające się od # są ignorowane.
"""
from __future__ import annotations

import itertools
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Socks5Proxy:
    host: str
    port: int
    username: str | None = None
    password: str | None = None

    @property
    def server(self) -> str:
        return f"socks5://{self.host}:{self.port}"

    def playwright_proxy(self) -> dict:
        d = {"server": self.server}
        if self.username:
            d["username"] = self.username
            d["password"] = self.password or ""
        return d

    def httpx_url(self) -> str:
        creds = f"{self.username}:{self.password}@" if self.username else ""
        return f"socks5://{creds}{self.host}:{self.port}"

    def label(self) -> str:
        return f"{self.host}:{self.port}"


def _parse_line(line: str) -> Socks5Proxy:
    line = line.strip()
    username = password = None

    if "@" in line:
        creds, hostport = line.split("@", 1)
        username, password = creds.split(":", 1)
    else:
        parts = line.split(":")
        if len(parts) == 4:
            host, port, username, password = parts
            hostport = f"{host}:{port}"
        else:
            hostport = line

    host, port = hostport.split(":")
    return Socks5Proxy(host=host, port=int(port), username=username, password=password)


def load_proxies(path: str | Path) -> list[Socks5Proxy]:
    p = Path(path)
    if not p.exists():
        return []
    proxies = []
    for raw in p.read_text().splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        try:
            proxies.append(_parse_line(raw))
        except ValueError:
            continue  # linia w nieznanym formacie — pomiń zamiast wywalać cały load
    return proxies


class ProxyPool:
    """
    Przypisuje proxy do sesji round-robin, wątkowo bezpiecznie.
    Każda sesja dostaje inny węzeł wyjściowy — to jest właśnie to, co
    pozwala zweryfikować per-IP rate limiting po stronie WAF.
    """

    def __init__(self, proxies: list[Socks5Proxy]):
        if not proxies:
            raise ValueError("Pusta lista proxy — sprawdź plik/DB źródłowe.")
        self._proxies = proxies
        self._cycle = itertools.cycle(proxies)
        self._lock = threading.Lock()

    @classmethod
    def from_file(cls, path: str | Path) -> "ProxyPool":
        return cls(load_proxies(path))

    def next(self) -> Socks5Proxy:
        with self._lock:
            return next(self._cycle)

    def __len__(self) -> int:
        return len(self._proxies)
