"""
Symulacja zachowania: krzywe Beziera dla ruchu myszy + opóźnienia z
rozkładu Gaussa/Poissona zamiast sztywnego sleep().

Cel inżynieryjny: Twój load-test ma generować rozkład czasowy akcji zbliżony
do realnych sesji użytkowników, żeby testować np. throttling per-request-rate,
a nie tylko "jak najszybciej jak się da" (co testuje coś innego — czysty
maksymalny throughput, nie zachowanie pod realistycznym obciążeniem).
"""
from __future__ import annotations

import asyncio
import random


def _cubic_bezier(t: float, p0, p1, p2, p3) -> tuple[float, float]:
    mt = 1 - t
    x = (mt**3) * p0[0] + 3 * (mt**2) * t * p1[0] + 3 * mt * (t**2) * p2[0] + (t**3) * p3[0]
    y = (mt**3) * p0[1] + 3 * (mt**2) * t * p1[1] + 3 * mt * (t**2) * p2[1] + (t**3) * p3[1]
    return x, y


def bezier_path(start: tuple[float, float], end: tuple[float, float],
                 rng: random.Random, steps: int = 25) -> list[tuple[float, float]]:
    """
    Punkty pośrednie ruchu myszy z start do end po krzywej sześciennej Beziera.
    Punkty kontrolne są losowo wychylone w bok od linii prostej, żeby uniknąć
    idealnie liniowego ruchu (typowy sygnał automatyzacji).
    """
    dx, dy = end[0] - start[0], end[1] - start[1]
    dist = max((dx**2 + dy**2) ** 0.5, 1.0)
    # Wychylenie kontrolnych punktów proporcjonalne do dystansu, z odrobiną szumu.
    offset = dist * rng.uniform(0.1, 0.3)
    perp = (-dy / dist, dx / dist)  # wektor prostopadły, znormalizowany

    ctrl1 = (
        start[0] + dx * 0.33 + perp[0] * offset * rng.choice([-1, 1]),
        start[1] + dy * 0.33 + perp[1] * offset * rng.choice([-1, 1]),
    )
    ctrl2 = (
        start[0] + dx * 0.66 + perp[0] * offset * rng.choice([-1, 1]),
        start[1] + dy * 0.66 + perp[1] * offset * rng.choice([-1, 1]),
    )

    return [_cubic_bezier(i / steps, start, ctrl1, ctrl2, end) for i in range(steps + 1)]


class HumanBehavior:
    """
    Jedna instancja per sesja (własny RNG per sesja -> profile nie korelują).
    """

    def __init__(self, seed: str):
        self._rng = random.Random(seed)

    # ── Opóźnienia ───────────────────────────────────────────────────────────
    def think_delay_seconds(self, mean: float = 1.2, sigma: float = 0.4) -> float:
        """Gaussowska pauza 'namysłu' między akcjami, ucięta do >= 0.05s."""
        return max(0.05, self._rng.gauss(mean, sigma))

    def interarrival_seconds(self, rate_per_min: float = 6.0) -> float:
        """
        Odstęp między kolejnymi requestami/akcjami wg procesu Poissona
        (czas międzyprzybyciowy = rozkład wykładniczy o średniej 1/rate).
        Do generowania ruchu API o zadanym średnim tempie zamiast stałego interwału.
        """
        return self._rng.expovariate(rate_per_min / 60.0)

    def typing_delay_seconds(self) -> float:
        """Odstęp między znakami przy 'pisaniu' w polu tekstowym."""
        return max(0.02, self._rng.gauss(0.09, 0.03))

    # ── Ruch myszy ───────────────────────────────────────────────────────────
    async def move_mouse_human(self, page, target_x: float, target_y: float,
                                start: tuple[float, float] | None = None) -> None:
        if start is None:
            start = (self._rng.uniform(0, 200), self._rng.uniform(0, 200))
        path = bezier_path(start, (target_x, target_y), self._rng,
                            steps=self._rng.randint(15, 35))
        for x, y in path:
            await page.mouse.move(x, y)
            await asyncio.sleep(self._rng.uniform(0.005, 0.02))

    async def human_click(self, page, locator) -> None:
        box = await locator.bounding_box()
        if box is None:
            await locator.click()
            return
        target_x = box["x"] + box["width"] * self._rng.uniform(0.3, 0.7)
        target_y = box["y"] + box["height"] * self._rng.uniform(0.3, 0.7)
        await self.move_mouse_human(page, target_x, target_y)
        await asyncio.sleep(self.think_delay_seconds(mean=0.2, sigma=0.08))
        await page.mouse.click(target_x, target_y)

    async def human_type(self, page, locator, text: str) -> None:
        await locator.click()
        for ch in text:
            await page.keyboard.type(ch)
            await asyncio.sleep(self.typing_delay_seconds())

    async def wait_think(self, mean: float = 1.2, sigma: float = 0.4) -> None:
        await asyncio.sleep(self.think_delay_seconds(mean, sigma))
