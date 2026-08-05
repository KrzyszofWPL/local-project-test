"""
Solver hCaptcha z routingiem na kilka modeli.

Jeden proces, kilka wyspecjalizowanych modeli, ladowanych LENIWIE i zwalnianych,
gdy zabraknie VRAM. Polecenie decyduje, ktory model odpowiada:

    siatka obrazkow  ->  CLIP      (otwarty slownik, ~1,7 GB)
    przeciaganie     ->  Florence-2 (grounding, zwraca wspolrzedne, ~1,5 GB)
    obracanie        ->  Florence-2
    nierozpoznane    ->  ODMOWA (lepiej nic niz spalona proba)

Na 8 GB VRAM oba modele mieszcza sie jednoczesnie (~3,2 GB), wiec przelaczanie
nie kosztuje przeladowan.

Instalacja:
    pip install torch transformers pillow fastapi uvicorn einops timm
Uruchomienie:
    python solver.py

Konfiguracja przez zmienne srodowiskowe:
    MODEL_GRID=clip           model dla siatek
    MODEL_DRAG=florence       model dla przeciagania
    MAX_VRAM_GB=7.0           budzet, po przekroczeniu zwalniany jest najdawniej
                              uzywany model
"""

import base64
import io
import multiprocessing
import os
import re
import time
from typing import Dict, List, Optional, Tuple

import torch
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
MAX_VRAM_GB = float(os.environ.get("MAX_VRAM_GB", "7.0"))

CLIP_ID = os.environ.get("CLIP_MODEL", "openai/clip-vit-large-patch14")
FLORENCE_ID = os.environ.get("FLORENCE_MODEL", "microsoft/Florence-2-large")
DINO_ID = os.environ.get("DINO_MODEL", "IDEA-Research/grounding-dino-base")

ROUTES = {
    "grid": os.environ.get("MODEL_GRID", "clip"),
    "drag": os.environ.get("MODEL_DRAG", "dino"),
    "rotate": os.environ.get("MODEL_ROTATE", "dino"),
}

print(f"=== Solver hCaptcha | urządzenie: {DEVICE} | budżet VRAM: {MAX_VRAM_GB} GB ===")
print(f"    routing: {ROUTES}")


# ── Rejestr modeli ──────────────────────────────────────────────────────────
# Leniwe ladowanie: model wchodzi do VRAM dopiero, gdy pierwszy raz go potrzeba.
# Gdy budzet przekroczony - zwalniany jest najdawniej uzywany.

class Registry:
    def __init__(self):
        self._models: Dict[str, dict] = {}
        self._used: Dict[str, float] = {}

    def vram_gb(self) -> float:
        return torch.cuda.memory_allocated() / (1024 ** 3) if DEVICE == "cuda" else 0.0

    def _evict_until(self, keep: str):
        while DEVICE == "cuda" and self.vram_gb() > MAX_VRAM_GB and len(self._models) > 1:
            victim = min((k for k in self._models if k != keep), key=lambda k: self._used[k],
                         default=None)
            if victim is None:
                return
            print(f"[i] Zwalniam model '{victim}' (VRAM {self.vram_gb():.2f} GB)")
            self._models.pop(victim, None)
            self._used.pop(victim, None)
            torch.cuda.empty_cache()

    def get(self, name: str) -> dict:
        if name in self._models:
            self._used[name] = time.time()
            return self._models[name]

        loader = LOADERS.get(name)
        if loader is None:
            raise HTTPException(status_code=400, detail=f"Nieznany model: {name}")

        print(f"[i] Ładuję model '{name}'...")
        bundle = loader()
        self._models[name] = bundle
        self._used[name] = time.time()
        self._evict_until(keep=name)
        print(f"[+] '{name}' gotowy. VRAM: {self.vram_gb():.2f} GB")
        return bundle


def load_clip() -> dict:
    from transformers import CLIPModel, CLIPProcessor
    model = CLIPModel.from_pretrained(CLIP_ID, torch_dtype=DTYPE).to(DEVICE).eval()
    return {"model": model, "proc": CLIPProcessor.from_pretrained(CLIP_ID), "id": CLIP_ID}


def load_florence() -> dict:
    """
    Florence-2 dziala tylko ze starszymi wersjami transformers: jego zdalny kod
    czyta self.forced_bos_token_id, zanim baza go ustawi, co na nowszych
    wersjach konczy sie AttributeError. Zostaje jako opcja dla tych, ktorzy maja
    zgodne wersje - domyslnym backendem jest teraz Grounding DINO.
    """
    from unittest.mock import patch

    from transformers import AutoModelForCausalLM, AutoProcessor
    from transformers.dynamic_module_utils import get_imports

    def without_flash_attn(filename):
        return [imp for imp in get_imports(filename) if imp != "flash_attn"]

    with patch("transformers.dynamic_module_utils.get_imports", without_flash_attn):
        model = AutoModelForCausalLM.from_pretrained(
            FLORENCE_ID, torch_dtype=DTYPE, trust_remote_code=True,
            attn_implementation="eager").to(DEVICE).eval()
        proc = AutoProcessor.from_pretrained(FLORENCE_ID, trust_remote_code=True)

    return {"model": model, "proc": proc, "id": FLORENCE_ID, "kind": "florence"}


def load_dino() -> dict:
    """
    Grounding DINO: detekcja otwartego slownika - dostaje fraze, zwraca ramki.
    Dokladnie to, czego potrzeba przy zadaniach pozycyjnych, a przy tym jest
    obslugiwany natywnie przez transformers: bez trust_remote_code, bez
    flash_attn i bez zdalnego kodu, ktory psuje sie przy kazdej aktualizacji.
    ~700 MB wag.
    """
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    proc = AutoProcessor.from_pretrained(DINO_ID)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(DINO_ID).to(DEVICE).eval()
    return {"model": model, "proc": proc, "id": DINO_ID, "kind": "dino"}


LOADERS = {"clip": load_clip, "florence": load_florence, "dino": load_dino}
registry = Registry()


# ── Rozpoznanie typu zadania ────────────────────────────────────────────────

def classify(prompt: str) -> str:
    p = re.sub(r"\s+", " ", (prompt or "").strip().lower())
    if re.search(r"\bdrag\b|przeciągnij|przeciagnij|\bslide\b|\bmove the\b", p):
        return "drag"
    if re.search(r"\brotate\b|obróć|obroc|\bturn the\b", p):
        return "rotate"
    if re.search(r"click each image|select all|containing a|zaznacz|wybierz|kliknij", p):
        return "grid"
    return "unknown"


PROMPT_PATTERNS = [
    # "Select items that are primarily metal" / "…which contain a bus".
    # Wczesniej takie polecenia w ogole nie pasowaly i solver odmawial z
    # unparsable_prompt, mimo ze byla to zwykla siatka obrazkow.
    r"(?:select|click|choose|pick)\s+(?:all\s+)?(?:the\s+)?(?:items?|images?|pictures?|tiles?|objects?)"
    r"\s+(?:that\s+(?:are|is)|which\s+(?:are|is)|that\s+contains?|which\s+contains?|with|of)"
    r"\s+(?:primarily\s+|mostly\s+|mainly\s+)?(?:an?\s+|the\s+)?(.+)",
    r"containing\s+(?:an?|the)?\s*(.+)",
    r"select\s+all\s+(?:images?\s+)?(?:with|of|containing)?\s*(?:an?|the)?\s*(.+)",
    r"click\s+(?:on\s+)?(?:each|all)\s+(?:image[s]?\s+)?(?:with|of|containing)?\s*(?:an?|the)?\s*(.+)",
    r"please\s+click\s+(?:on\s+)?(?:each|all)\s+(.+)",
    r"zaznacz\s+(?:wszystkie\s+)?(?:obrazki\s+)?(?:z\s+)?(.+)",
    r"kliknij\s+(?:wszystkie\s+)?(?:obrazki\s+)?(?:z\s+)?(.+)",
    r"wybierz\s+(?:wszystkie\s+)?(.+)",
]


def extract_target(prompt: str) -> Optional[str]:
    text = re.sub(r"\s+", " ", (prompt or "").strip().lower())
    for pat in PROMPT_PATTERNS:
        m = re.search(pat, text)
        if m:
            t = m.group(1).strip(" .!?:;\"'")
            t = re.split(r"\.\s|\bif there are\b|\bin the image\b", t)[0].strip()
            if 2 <= len(t) <= 60:
                return t

    # Ostatnia deska ratunku: zdejmij tryb rozkazujacy i zwroc reszte zdania.
    # Odmowa kosztuje cala runde, a CLIP radzi sobie nawet z niedoskonala fraza
    # - lepsza przyblizona etykieta niz unparsable_prompt.
    fallback = re.sub(
        r"^(?:please\s+)?(?:select|click|choose|pick|tap)\s+"
        r"(?:on\s+)?(?:all|each|every|both)?\s*"
        r"(?:the\s+)?(?:items?|images?|pictures?|tiles?|objects?)?\s*"
        r"(?:that\s+(?:are|is)|which\s+(?:are|is)|with|of|containing)?\s*"
        r"(?:primarily\s+|mostly\s+|mainly\s+)?(?:an?\s+|the\s+)?",
        "", text).strip(" .!?:;\"'")
    fallback = re.split(r"\.\s|\bif there are\b|\bin the image\b", fallback)[0].strip()
    if 2 <= len(fallback) <= 60 and fallback != text:
        return fallback
    return None


def decode_image(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64.split(",")[-1]))).convert("RGB")


# ── Backend: siatka obrazkow (CLIP) ─────────────────────────────────────────

NEGATIVES = ["a photo of something else", "an unrelated photo",
             "a blank or abstract image"]


@torch.inference_mode()
def clip_scores(images: List[Image.Image], target: str) -> List[float]:
    b = registry.get(ROUTES["grid"])
    texts = [f"a photo of {target}"] + NEGATIVES
    inputs = b["proc"](text=texts, images=images, return_tensors="pt", padding=True)
    inputs = {k: (v.to(DEVICE, DTYPE) if v.dtype.is_floating_point else v.to(DEVICE))
              for k, v in inputs.items()}
    probs = b["model"](**inputs).logits_per_image.float().softmax(dim=-1)
    return probs[:, 0].tolist()


def crop_grid(img: Image.Image, cols: int, rows: int) -> List[Image.Image]:
    w, h = img.size
    tw, th = w / cols, h / rows
    return [img.crop((int(c * tw), int(r * th), int((c + 1) * tw), int((r + 1) * th)))
            for r in range(rows) for c in range(cols)]


# ── Backend: grounding (Florence-2) ─────────────────────────────────────────
# Zwraca ramki dla frazy. Uzywane do zadan, w ktorych trzeba wskazac miejsce,
# a nie wybrac obrazek.

@torch.inference_mode()
def ground(img: Image.Image, phrase: str) -> List[Tuple[Tuple[float, float, float, float], float]]:
    """
    Ramki dla frazy wraz z pewnoscia, POSORTOWANE malejaco.

    Wczesniej funkcja zwracala same ramki, a wolajacy bral `boxes[0]`. Wyniki
    `post_process_grounded_object_detection` NIE sa posortowane po pewnosci,
    wiec bylo to wziecie dowolnej detekcji - i przy okazji wyrzucenie do kosza
    `scores`, jedynej informacji o tym, czy model w ogole cos rozpoznal.
    """
    b = registry.get(ROUTES["drag"])

    if b.get("kind") == "dino":
        # Grounding DINO wymaga zapytan malymi literami zakonczonych kropka.
        query = phrase.strip().lower().rstrip(".") + "."
        inputs = b["proc"](images=img, text=query, return_tensors="pt").to(DEVICE)
        outputs = b["model"](**inputs)
        results = b["proc"].post_process_grounded_object_detection(
            outputs, inputs["input_ids"],
            threshold=0.25, text_threshold=0.25,
            target_sizes=[(img.size[1], img.size[0])],
        )
        if not results:
            return []
        boxes = results[0]["boxes"].tolist()
        scores = results[0]["scores"].tolist()
        pairs = [(tuple(bx), float(sc)) for bx, sc in zip(boxes, scores)]
        return sorted(pairs, key=lambda p: p[1], reverse=True)

    task = "<CAPTION_TO_PHRASE_GROUNDING>"
    inputs = b["proc"](text=task + phrase, images=img, return_tensors="pt")
    inputs = {k: (v.to(DEVICE, DTYPE) if v.dtype.is_floating_point else v.to(DEVICE))
              for k, v in inputs.items()}
    out = b["model"].generate(**inputs, max_new_tokens=256, num_beams=3, do_sample=False)
    text = b["proc"].batch_decode(out, skip_special_tokens=False)[0]
    parsed = b["proc"].post_process_generation(text, task=task, image_size=img.size)
    # Florence nie zwraca pewnosci - nadajemy neutralna, zeby kontrakt byl jeden.
    return [(tuple(bx), 0.5) for bx in parsed.get(task, {}).get("bboxes", [])]


def center(box) -> Tuple[float, float]:
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


# ── Kontrakt HTTP ───────────────────────────────────────────────────────────

class SolveRequest(BaseModel):
    prompt: str = ""
    # Siatka: osobny obrazek na kafelek.
    tiles: Optional[List[str]] = None
    # Zadania pozycyjne: jeden zrzut obszaru wyzwania.
    image_data: Optional[str] = None
    grid: str = "3x3"
    threshold: float = 0.55
    # Wymuszenie typu, gdy wolajacy juz go zna.
    kind: Optional[str] = None


def grid_size(grid: str) -> Tuple[int, int]:
    if "4x4" in grid:
        return 4, 4
    if "2x2" in grid:
        return 2, 2
    return 3, 3


def solve_grid(req: SolveRequest) -> dict:
    target = extract_target(req.prompt)
    if not target:
        return {"success": False, "kind": "grid", "reason": "unparsable_prompt",
                "detail": f"Nie wyciągnąłem celu z: \"{req.prompt}\"", "click_indices": []}

    if req.tiles:
        images, mode = [decode_image(t) for t in req.tiles], "tiles"
    elif req.image_data:
        cols, rows = grid_size(req.grid)
        images, mode = crop_grid(decode_image(req.image_data), cols, rows), "composite"
    else:
        raise HTTPException(status_code=400, detail="Brak tiles ani image_data")

    scores = clip_scores(images, target)
    thr = max(0.05, min(0.95, req.threshold))
    picks = [i for i, s in enumerate(scores) if s >= thr]

    return {"success": True, "kind": "grid", "action": "click", "mode": mode,
            "target": target, "threshold": thr, "click_indices": picks,
            "scores": {i: round(s, 3) for i, s in enumerate(scores)},
            "model": ROUTES["grid"]}


# Zapasowe frazy - uzywane DOPIERO, gdy z polecenia nie da sie nic wyciagnac.
# Wczesniej byly jedynym zrodlem zapytan, przez co tresc zadania nie mila
# zadnego wplywu na wynik: pierwsza fraza z listy ("the draggable piece") przy
# progu 0.25 prawie zawsze zwracala JAKAS ramke, petla robila break i do frazy
# faktycznie pasujacej do zadania nigdy nie dochodzilo.
DRAG_SOURCE_HINTS = ["the draggable piece", "the puzzle piece", "the segment", "the icon"]
DRAG_TARGET_HINTS = ["the empty slot", "the target area", "the outline", "the line"]

# "Przeciagnij X na Y" / "drag the X to the Y" - z tego bierzemy obie frazy.
# Kolejnosc MA znaczenie: separatory "to/into/onto" ida przed "on", bo w zdaniu
# "drag the segment ON THE RIGHT to complete the line" slowo "on" nalezy do
# opisu zrodla, a nie oddziela zrodla od celu. Rozbicie na pierwszym "on"
# dawalo zrodlo "segment" i cel "right" - czyli gubilo polowe informacji.
DRAG_PROMPT_PATTERNS = [
    r"drag\s+(.+?)\s+(?:to|into|onto)\s+(.+)",
    r"move\s+(.+?)\s+(?:to|into|onto)\s+(.+)",
    r"slide\s+(.+?)\s+(?:to|into|onto)\s+(.+)",
    r"przeciągnij\s+(.+?)\s+(?:na|do)\s+(.+)",
    r"przeciagnij\s+(.+?)\s+(?:na|do)\s+(.+)",
    # "Przeciągnij segment po prawej stronie, ABY uzupełnić linię" - polski
    # wariant bez przyimka kierunku, cel opisany celem czynnosci.
    r"przeciągnij\s+(.+?),?\s+(?:aby|żeby|by)\s+(.+)",
    r"przeciagnij\s+(.+?),?\s+(?:aby|zeby|by)\s+(.+)",
    r"drag\s+(.+?)\s+on\s+(.+)",
]

# Cel bywa opisany celem czynnosci ("to COMPLETE the line"), a nie rzeczownikiem.
# Grounding potrzebuje rzeczownika, wiec czasownik zamiaru odcinamy.
PURPOSE_VERBS = (
    r"^(?:complete|finish|fill\s+in|fill|match|form|make|close|connect"
    r"|uzupełnić|uzupelnic|dokończyć|dokonczyc|domknąć|domknac"
    r"|połączyć|polaczyc|dopasować|dopasowac)\s+"
)

# Progi ponizej ktorych odmawiamy - slabe uziemienie jest gorsze niz brak
# odpowiedzi, bo spalona runda podnosi ocene ryzyka calej sesji.
MIN_SCORE = float(os.environ.get("DRAG_MIN_SCORE", "0.30"))
MIN_TRAVEL = float(os.environ.get("DRAG_MIN_TRAVEL", "0.03"))


def _clean_phrase(s: str) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip(" .!?:;\"'")
    s = re.sub(PURPOSE_VERBS, "", s).strip()
    s = re.sub(r"^(?:the|a|an)\s+", "", s).strip()
    # Wszystko po "so that/aby" to juz uzasadnienie, nie opis obiektu.
    s = re.split(r"\bso that\b|\baby\b", s)[0].strip()
    return s.strip(" .!?:;\"'")


def drag_phrases(prompt: str) -> Tuple[List[str], List[str]]:
    """Frazy (zrodlo, cel) zbudowane z TRESCI ZADANIA, z hintami na koncu."""
    text = re.sub(r"\s+", " ", (prompt or "").strip().lower())
    for pat in DRAG_PROMPT_PATTERNS:
        m = re.search(pat, text)
        if m:
            src, tgt = _clean_phrase(m.group(1)), _clean_phrase(m.group(2))
            if 2 <= len(src) <= 60 and 2 <= len(tgt) <= 60:
                return [src] + DRAG_SOURCE_HINTS, [tgt] + DRAG_TARGET_HINTS
    return list(DRAG_SOURCE_HINTS), list(DRAG_TARGET_HINTS)


def best_box(img: Image.Image, phrases: List[str]):
    """Najlepsza ramka spomiedzy WSZYSTKICH fraz, nie pierwsza z brzegu."""
    best = None
    for phrase in phrases:
        for box, score in ground(img, phrase)[:1]:
            if best is None or score > best[1]:
                best = (box, score, phrase)
    return best


def solve_drag(req: SolveRequest) -> dict:
    if not req.image_data:
        return {"success": False, "kind": "drag", "reason": "no_image",
                "detail": "Zadanie pozycyjne wymaga image_data (zrzut obszaru wyzwania)"}

    img = decode_image(req.image_data)
    w, h = img.size

    src_phrases, tgt_phrases = drag_phrases(req.prompt)
    src = best_box(img, src_phrases)
    tgt = best_box(img, tgt_phrases)

    if src is None or tgt is None:
        return {"success": False, "kind": "drag", "reason": "not_grounded",
                "detail": "Model nie wskazał elementu do przeciągnięcia lub celu"}

    score = min(src[1], tgt[1])
    if score < MIN_SCORE:
        return {"success": False, "kind": "drag", "reason": "low_confidence",
                "detail": f"Najlepsze uziemienie {score:.2f} < próg {MIN_SCORE:.2f} "
                          f"(źródło: \"{src[2]}\", cel: \"{tgt[2]}\")"}

    a, b = center(src[0]), center(tgt[0])
    frm = [round(a[0] / w, 4), round(a[1] / h, 4)]
    to = [round(b[0] / w, 4), round(b[1] / h, 4)]

    # Dwie ramki w tym samym miejscu to typowy objaw uziemienia na calym
    # obrazku - wtedy oba srodki wypadaja w (0.5, 0.5) i "przeciagniecie"
    # nie ma sensu.
    travel = ((frm[0] - to[0]) ** 2 + (frm[1] - to[1]) ** 2) ** 0.5
    if travel < MIN_TRAVEL:
        return {"success": False, "kind": "drag", "reason": "degenerate",
                "detail": f"Źródło i cel w tym samym miejscu (dystans {travel:.3f})"}

    # Wspolrzedne znormalizowane 0..1 - wolajacy sam przelicza je na piksele
    # strony, wiec skalowanie zrzutu nie ma tu znaczenia.
    return {"success": True, "kind": "drag", "action": "drag",
            "from": frm, "to": to,
            # Wyliczana z detekcji, nie zahardkodowana - poprzednio zawsze
            # bylo "low", wiec ostrzezenie w logu nic nie znaczylo.
            "confidence": "high" if score >= 0.5 else ("medium" if score >= 0.4 else "low"),
            "score": round(score, 3),
            "phrases": {"from": src[2], "to": tgt[2]},
            "image_size": [w, h],
            "model": ROUTES["drag"]}


@app.get("/health")
async def health():
    return {
        "ok": True,
        "device": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU",
        "vram_gb": round(registry.vram_gb(), 2),
        "budget_gb": MAX_VRAM_GB,
        "routes": ROUTES,
        "loaded": sorted(registry._models.keys()),
        "available": sorted(LOADERS.keys()),
    }


@app.post("/solve")
async def solve(req: SolveRequest):
    kind = req.kind or classify(req.prompt)

    # Kazdy blad backendu wraca jako czytelna odmowa, a nie gole 500.
    # Wczesniej niezlapany wyjatek (np. nieudane ladowanie modelu) docieral do
    # wolajacego jako "Internal Server Error" bez cienia informacji, co padlo.
    try:
        if kind == "grid":
            return await run_in_threadpool(solve_grid, req)
        if kind in ("drag", "rotate"):
            return await run_in_threadpool(solve_drag, req)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"success": False, "kind": kind, "reason": "backend_error",
                "detail": f"{type(e).__name__}: {e}"[:400]}

    # Swiadoma odmowa - klikniecie na chybil trafil spala probe i podnosi
    # ocene ryzyka sesji bardziej niz brak odpowiedzi.
    return {"success": False, "kind": kind, "reason": "unsupported_challenge",
            "detail": f"Nie mam modelu do zadania typu \"{kind}\": \"{req.prompt}\""}


@app.post("/analyze-captcha")
async def analyze_captcha(req: SolveRequest):
    """Stary kontrakt (tylko siatka) - zachowany dla zgodności."""
    return await run_in_threadpool(solve_grid, req)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)
