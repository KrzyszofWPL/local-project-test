"""
Solver hCaptcha z routingiem na kilka modeli.

Jeden proces, kilka wyspecjalizowanych modeli, ladowanych LENIWIE i zwalnianych,
gdy zabraknie VRAM. Polecenie decyduje, ktory model odpowiada:

    siatka obrazkow  ->  CLIP         (otwarty slownik, ~1,7 GB)
    przeciaganie     ->  Qwen2.5-VL   (wskazuje PUNKTY, nie ramki)
    obracanie        ->  Qwen2.5-VL
    nierozpoznane    ->  ODMOWA (lepiej nic niz spalona proba)

DLACZEGO NIE DETEKTOR OBIEKTOW DO PRZECIAGANIA

Grounding DINO (i Florence-2) to detektory: dostaja fraze i szukaja RZECZY,
ktora do niej pasuje. Zadanie "przeciagnij ikone w miejsce, gdzie pasuje"
wymaga wskazania miejsca PUSTEGO - obiektu, ktorego tam z definicji nie ma.
W logach wygladalo to zawsze tak samo: ramka obejmujaca 66-68% kadru, czyli
"nie znalazlem niczego, wiec zwracam wszystko". Zadnym progiem sie tego nie
naprawi, bo to nie jest kwestia czulosci, tylko tego, o co model potrafi zostac
zapytany.

Model wizyjno-jezykowy rozumuje o ukladzie sceny i podaje wspolrzedne punktu.
Tak samo dziala referencyjna implementacja dla hCaptchy (hcaptcha-challenger:
"Spatial Chain-of-Thought" dla image_drag_drop).

Instalacja:
    pip install torch transformers pillow fastapi uvicorn einops timm
    pip install -U accelerate qwen-vl-utils      # dla Qwen2.5-VL
    pip install bitsandbytes                     # kwantyzacja 4-bit (karty <12 GB)
Uruchomienie:
    python solver.py

Konfiguracja przez zmienne srodowiskowe:
    MODEL_GRID=clip           model dla siatek
    MODEL_DRAG=qwen           model dla przeciagania (dino = stare zachowanie)
    QWEN_MODEL=...            domyslnie Qwen/Qwen2.5-VL-3B-Instruct
    QWEN_4BIT=auto            auto|true|false - 'auto' wlacza 4-bit ponizej 12 GB
    MAX_VRAM_GB=7.0           budzet, po przekroczeniu zwalniany jest najdawniej
                              uzywany model
"""

import base64
import io
import json
import multiprocessing
import os
import re
import threading
import time
from typing import Dict, List, Optional, Tuple

import torch
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

# ── WERSJA SOLVERA - podnies przy KAZDEJ zmianie w tym pliku ────────────────
# Doklejana do kazdej odpowiedzi i wypisywana w logu bota. Ten proces NIE jest
# restartowany przez Stop/Start w panelu - to osobny serwer uvicorn, ktory
# trzeba ubic recznie. Bez numeru w logu nie da sie odroznic "poprawka nie
# dziala" od "poprawka nie zostala zaladowana".
SOLVER_VERSION = "s1.3"

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

# Model wizyjno-jezykowy dla zadan pozycyjnych. 3B miesci sie na 8 GB w fp16
# na styk, wiec przy malej karcie wchodzi kwantyzacja 4-bit (patrz QWEN_4BIT).
# Wieksze warianty: Qwen/Qwen2.5-VL-7B-Instruct (wymaga 4-bit na 8 GB).
QWEN_ID = os.environ.get("QWEN_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
QWEN_4BIT = os.environ.get("QWEN_4BIT", "auto").lower()

ROUTES = {
    "grid": os.environ.get("MODEL_GRID", "clip"),
    # Detektor obiektow (DINO) jest do zadan pozycyjnych ZLYM narzedziem i
    # zostalo to potwierdzone w boju: przy poleceniach opisujacych PUSTE
    # miejsce ("the place where it fits", "the empty slot") zwracal ramke
    # obejmujaca 66-68% kadru, czyli "nie znalazlem niczego". Detektor
    # znajduje rzeczy obecne - a tu trzeba wskazac miejsce, w ktorym czegos
    # NIE MA. Zadnym progiem sie tego nie naprawi.
    #
    # Model wizyjno-jezykowy rozumuje o scenie i potrafi wskazac PUNKT, nie
    # tylko obrys obiektu. Tak samo robi to referencyjna implementacja dla
    # hCaptchy (hcaptcha-challenger: "Spatial Chain-of-Thought" dla
    # image_drag_drop). MODEL_DRAG=dino przywraca stare zachowanie.
    "drag": os.environ.get("MODEL_DRAG", "qwen"),
    "rotate": os.environ.get("MODEL_ROTATE", "qwen"),
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
        # Ladowanie modelu potrafi trwac minuty (pobranie wag + kwantyzacja).
        # Bez zamka dwa rownolegle zapytania zaczynaja to samo ladowanie dwa
        # razy i podwajaja szczyt zuzycia VRAM - na 8 GB karcie to OOM.
        self._lock = threading.Lock()

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

    def is_loaded(self, name: str) -> bool:
        return name in self._models

    def get(self, name: str) -> dict:
        if name in self._models:
            self._used[name] = time.time()
            return self._models[name]

        loader = LOADERS.get(name)
        if loader is None:
            raise HTTPException(status_code=400, detail=f"Nieznany model: {name}")

        with self._lock:
            # Ktos mogl zaladowac go, gdy czekalismy na zamek.
            if name in self._models:
                self._used[name] = time.time()
                return self._models[name]

            print(f"[i] Ładuję model '{name}'... (pierwszy raz pobiera wagi,"
                  " to może potrwać kilka minut)")
            t0 = time.time()
            bundle = loader()
            self._models[name] = bundle
            self._used[name] = time.time()
            self._evict_until(keep=name)
            print(f"[+] '{name}' gotowy w {time.time() - t0:.0f}s."
                  f" VRAM: {self.vram_gb():.2f} GB")
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


def load_qwen() -> dict:
    """
    Qwen2.5-VL: model wizyjno-jezykowy z natywnym wskazywaniem punktow.

    Roznica wzgledem Grounding DINO jest zasadnicza, nie ilosciowa. DINO to
    detektor obiektow otwartego slownika: dostaje fraze i szuka RZECZY, ktora
    do niej pasuje. Zadanie "przeciagnij ikone w miejsce, gdzie pasuje" wymaga
    wskazania PUSTEGO miejsca - obiektu, ktorego z definicji tam nie ma.
    Detektor odpowiada wtedy ramka na caly kadr, co widac bylo w logach jako
    "zajmuje 68% obrazu".

    Model jezykowy rozumuje o ukladzie sceny: widzi luke w linii, widzi
    element obok i potrafi podac wspolrzedne jednego i drugiego.

    Instalacja (poza tym, co juz jest):
        pip install -U transformers accelerate qwen-vl-utils
        pip install bitsandbytes        # tylko dla kwantyzacji 4-bit
    """
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    kwargs = {"torch_dtype": DTYPE}

    # 8 GB karta (RTX 4060) nie udzwignie 7B w fp16, a 3B miesci sie na styk.
    # 'auto' wlacza 4-bit, gdy karta ma mniej niz 12 GB.
    want4bit = QWEN_4BIT == "true"
    if QWEN_4BIT == "auto" and DEVICE == "cuda":
        try:
            total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            want4bit = total < 12.0
        except Exception:  # noqa: BLE001
            want4bit = False

    if want4bit:
        try:
            from transformers import BitsAndBytesConfig
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=DTYPE,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
            kwargs["device_map"] = "auto"
            print("[i] Qwen2.5-VL w kwantyzacji 4-bit (mała karta).")
        except Exception as e:  # noqa: BLE001
            print(f"[!] Kwantyzacja 4-bit niedostępna ({e}) – ładuję w {DTYPE}."
                  " Jeśli zabraknie VRAM: pip install bitsandbytes")

    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(QWEN_ID, **kwargs)
    if "device_map" not in kwargs:
        model = model.to(DEVICE)
    model = model.eval()

    # Sufit rozdzielczosci: obszar wyzwania to ~500x470, wiec nie ma powodu
    # placic za wiecej tokenow wizyjnych, a domyslny limit Qwena jest ogromny.
    proc = AutoProcessor.from_pretrained(
        QWEN_ID, min_pixels=256 * 28 * 28, max_pixels=1280 * 28 * 28)

    return {"model": model, "proc": proc, "id": QWEN_ID, "kind": "vlm"}


LOADERS = {"clip": load_clip, "florence": load_florence, "dino": load_dino,
           "qwen": load_qwen}
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


# ── Backend: wskazywanie punktow modelem wizyjno-jezykowym ──────────────────

# Polecenie celowo zada SAMEGO JSON-a. Krotki tok rozumowania podnosi jakosc,
# ale rozwleklej odpowiedzi nie da sie niezawodnie sparsowac, a zla odpowiedz
# kosztuje wiecej niz odmowa. Model dostaje wymiary obrazu, bo Qwen operuje na
# wspolrzednych BEZWZGLEDNYCH, nie znormalizowanych.
VLM_PROMPT = (
    "This is a CAPTCHA puzzle image, {w} by {h} pixels.\n"
    "Instruction shown to the user: \"{task}\"\n\n"
    "Find exactly two locations:\n"
    "  \"from\" = the centre of the movable element that must be dragged\n"
    "  \"to\"   = the exact spot where that element belongs once placed\n\n"
    "The \"to\" location is usually EMPTY - a gap, a slot or a hole. "
    "Give its centre even though nothing is drawn there.\n\n"
    "Reply with ONLY this JSON and nothing else:\n"
    "{{\"from\": [x, y], \"to\": [x, y]}}\n"
    "Use absolute pixel coordinates in this image."
)


# Siatki, ktorych CLIP z zasady nie rozwiaze.
#
# CLIP porownuje PODOBIENSTWO obrazu do opisu. Nie rozumie relacji ("co zmiesci
# sie w tym naczyniu"), nie umie porownac kafelka ze WZORCEM pokazanym obok
# polecenia i nie wnioskuje o przeznaczeniu ani rozmiarze.
#
# Przyklad z boju: "Click on items that can fit inside the object shown", gdzie
# wzorcem byla miska w banerze polecenia. extract_target() nie mial z czego
# wyciagnac rzeczownika i zwrocil cala fraze "that can fit inside the object
# shown". CLIP liczyl wtedy podobienstwo kafelkow do zdania bez tresci
# wizualnej, wiec wskazania byly losowe: obok czosnku (poprawnie) zaznaczyl
# kanapy i pralki. Sam WZORZEC - miska - nigdy nie trafial do modelu, bo
# zrzucalismy wylacznie kafelki.
SEMANTIC_MARKERS = re.compile(
    r"\bshown\b|\bexample\b|\babove\b|\bpictured\b"
    r"|\bfits?\s+(?:in|inside|into)\b|\bfit\s+inside\b"
    r"|\bsame\b|\bsimilar\b|\bmatch(?:es|ing)?\b|\bpair\b"
    r"|\bbelongs?\b|\bused\s+(?:for|to)\b|\bmade\s+(?:of|from)\b"
    r"|\bthat\s+can\b|\bwhich\s+can\b|\bcan\s+be\b",
    re.I)


def needs_reasoning(prompt: str, target: Optional[str]) -> bool:
    """
    Czy siatka wymaga rozumowania, a nie samego podobienstwa.

    Zasada, nie lista fraz: CLIP dostaje polecenia, ktore NAZYWAJA obiekt
    ("bicycle", "primarily metal"), a model wizyjno-jezykowy te, ktore opisuja
    go zdaniem podrzednym ("animal THAT emerges from an egg", "items THAT can
    fit inside the object shown"). Zdanie podrzedne oznacza wlasnosc, relacje
    albo wiedze o swiecie - a CLIP mierzy wylacznie podobienstwo obrazu do
    opisu i takiego warunku nie sprawdzi.

    Podzial ma tez znaczenie praktyczne: CLIP odpowiada w ulamku sekundy,
    model wizyjno-jezykowy w kilka sekund. Prostych siatek nie ma po co
    przepuszczac przez ten drugi.
    """
    if not target:
        return True
    if SEMANTIC_MARKERS.search(prompt or ""):
        return True
    return bool(re.search(r"\b(?:that|which|who|whose)\b", target, re.I))


GRID_VLM_PROMPT = (
    "This image is a CAPTCHA panel, {w} by {h} pixels.\n"
    "It shows an instruction at the top (sometimes together with a small "
    "reference picture), and below it a grid of {n} tiles.\n\n"
    "Instruction: \"{task}\"\n\n"
    "Tiles are numbered starting at 0, left to right, then top to bottom.\n"
    "Decide which tiles satisfy the instruction. Think about what the "
    "instruction actually asks - it may refer to the reference picture, to "
    "physical size, or to what an object is used for.\n\n"
    "Reply with ONLY this JSON and nothing else:\n"
    "{{\"click\": [0, 3]}}\n"
    "Use an empty list if no tile satisfies the instruction."
)


@torch.inference_mode()
def vlm_grid_picks(img: Image.Image, task: str, n: int) -> Optional[List[int]]:
    b = registry.get(ROUTES["drag"])   # ten sam model wizyjno-jezykowy
    w, h = img.size

    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": img},
            {"type": "text", "text": GRID_VLM_PROMPT.format(w=w, h=h, task=task, n=n)},
        ],
    }]
    text = b["proc"].apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True)
    inputs = b["proc"](text=[text], images=[img], return_tensors="pt")
    inputs = {k: v.to(b["model"].device) for k, v in inputs.items()}

    out = b["model"].generate(**inputs, max_new_tokens=128, do_sample=False)
    raw = b["proc"].decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    data = _extract_json(raw)
    if not data or not isinstance(data.get("click"), list):
        print(f"[!] VLM (siatka) nie zwrócił JSON-a: {raw[:200]!r}")
        return None

    picks = []
    for v in data["click"]:
        try:
            i = int(v)
        except Exception:  # noqa: BLE001
            continue
        if 0 <= i < n and i not in picks:
            picks.append(i)
    return picks


def _extract_json(text: str) -> Optional[dict]:
    """Ostatni obiekt JSON w odpowiedzi - model lubi dokleic komentarz."""
    best = None
    for m in re.finditer(r"\{[^{}]*\}", text or "", re.S):
        try:
            best = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            continue
    return best if isinstance(best, dict) else None


def _pt(v, w: int, h: int) -> Optional[Tuple[float, float]]:
    if not isinstance(v, (list, tuple)) or len(v) < 2:
        return None
    try:
        x, y = float(v[0]), float(v[1])
    except Exception:  # noqa: BLE001
        return None
    # Model bywa proszony o piksele, ale czasem odpowiada 0..1 albo 0..1000.
    # Rozpoznajemy skale po zakresie, zamiast ufac instrukcji.
    if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
        x, y = x * w, y * h
    elif x > w or y > h:
        if x <= 1000 and y <= 1000:
            x, y = x / 1000.0 * w, y / 1000.0 * h
    return (max(0.0, min(float(w), x)), max(0.0, min(float(h), y)))


@torch.inference_mode()
def vlm_drag_points(img: Image.Image, task: str):
    """Zwraca ((x1,y1),(x2,y2)) w pikselach albo None."""
    b = registry.get(ROUTES["drag"])
    w, h = img.size

    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": img},
            {"type": "text", "text": VLM_PROMPT.format(w=w, h=h, task=task)},
        ],
    }]
    text = b["proc"].apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True)
    inputs = b["proc"](text=[text], images=[img], return_tensors="pt")
    inputs = {k: v.to(b["model"].device) for k, v in inputs.items()}

    out = b["model"].generate(**inputs, max_new_tokens=128, do_sample=False)
    trimmed = out[0][inputs["input_ids"].shape[1]:]
    raw = b["proc"].decode(trimmed, skip_special_tokens=True)

    data = _extract_json(raw)
    if not data:
        print(f"[!] VLM nie zwrócił JSON-a: {raw[:200]!r}")
        return None
    a = _pt(data.get("from"), w, h)
    c = _pt(data.get("to"), w, h)
    if a is None or c is None:
        print(f"[!] VLM zwrócił niepełne punkty: {data!r}")
        return None
    return a, c


def box_area_ratio(box, w: int, h: int) -> float:
    """Jaka czesc obrazu zajmuje ramka. 1.0 = caly obraz."""
    if not w or not h:
        return 1.0
    bw = max(0.0, box[2] - box[0])
    bh = max(0.0, box[3] - box[1])
    return (bw * bh) / float(w * h)


# ── Kontrakt HTTP ───────────────────────────────────────────────────────────

class SolveRequest(BaseModel):
    prompt: str = ""
    # Siatka: osobny obrazek na kafelek.
    tiles: Optional[List[str]] = None
    # Zadania pozycyjne: jeden zrzut obszaru wyzwania.
    image_data: Optional[str] = None
    grid: str = "3x3"
    # Ile kafelkow naprawde jest na panelu. Model wizyjno-jezykowy indeksuje po
    # nich, wiec musi znac liczbe - inaczej zdarza mu sie zgadywac 9.
    tile_count: Optional[int] = None
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

    # Siatka relacyjna/semantyczna idzie do modelu wizyjno-jezykowego, i to na
    # PELNYM zrzucie panelu - bo wzorzec, do ktorego odnosi sie polecenie
    # ("the object shown"), jest narysowany OBOK polecenia, a nie w kafelkach.
    # Wysylanie samych kafelkow gwarantowalo bledna odpowiedz: model nie mial
    # jak zobaczyc, o jaki obiekt chodzi.
    if needs_reasoning(req.prompt, target):
        if not req.image_data:
            return {"success": False, "kind": "grid", "reason": "no_image",
                    "detail": "Siatka semantyczna wymaga zrzutu całego panelu"
                              " (wzorzec bywa obok polecenia, nie w kafelkach)",
                    "click_indices": []}
        vlm = ROUTES["drag"]
        if not registry.is_loaded(vlm):
            return _not_ready("grid")

        n = req.tile_count or (len(req.tiles) if req.tiles else 9)
        picks = vlm_grid_picks(decode_image(req.image_data), req.prompt or "", n)
        if picks is None:
            return {"success": False, "kind": "grid", "reason": "not_grounded",
                    "detail": "Model wizyjno-językowy nie wskazał kafelków",
                    "click_indices": []}
        return {"success": True, "kind": "grid", "action": "click", "mode": "vlm",
                "target": target or "(relacja)", "click_indices": picks,
                "model": vlm}

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

# Powyzej tego udzialu powierzchni ramka przestaje byc wskazaniem miejsca.
# 0.6 przepuszcza duze obiekty (segment linii bywa rozlegly), a odrzuca
# uziemienie na calym kadrze.
MAX_BOX_RATIO = float(os.environ.get("DRAG_MAX_BOX_RATIO", "0.60"))


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

    # Sciezka modelu wizyjno-jezykowego: pytamy wprost o DWA PUNKTY, zamiast
    # kazac detektorowi szukac obiektu w miejscu, ktore jest puste z zalozenia.
    # Kontrole ponizej (dystans, granice) zostaja te same - to nadal jest
    # odpowiedz do zweryfikowania, nie wyrocznia.
    if registry.get(ROUTES["drag"]).get("kind") == "vlm":
        pts = vlm_drag_points(img, req.prompt or "")
        if not pts:
            return {"success": False, "kind": "drag", "reason": "not_grounded",
                    "detail": "Model wizyjno-językowy nie wskazał dwóch punktów"}
        (ax, ay), (bx, by) = pts
        frm = [round(ax / w, 4), round(ay / h, 4)]
        to = [round(bx / w, 4), round(by / h, 4)]
        travel = ((frm[0] - to[0]) ** 2 + (frm[1] - to[1]) ** 2) ** 0.5
        if travel < MIN_TRAVEL:
            return {"success": False, "kind": "drag", "reason": "degenerate",
                    "detail": f"Źródło i cel w tym samym miejscu (dystans {travel:.3f})"}
        return {"success": True, "kind": "drag", "action": "drag",
                "from": frm, "to": to, "confidence": "medium",
                "model": ROUTES["drag"]}

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

    # Ramka obejmujaca (prawie) caly obraz to nie detekcja, tylko kapitulacja
    # modelu: detektor obiektow nie znalazl niczego i zwrocil wszystko. Srodek
    # takiej ramki wypada w (0.5, 0.5), czyli w martwym srodku obrazka.
    #
    # Kontrola `travel` nizej lapie to TYLKO gdy zdegenerowane sa OBIE ramki.
    # Gdy degeneruje sie sam cel - a przy frazach opisujacych puste miejsce
    # ("the empty slot", "the place where it fits") to przypadek typowy, bo
    # grounding znajduje rzeczy obecne, nie ich brak - dystans wychodzi duzy,
    # walidacja przepuszcza i przeciagamy element na srodek obrazu. hCaptcha
    # odpowiada na to `challenge-error` i wyzwanie jest spalone.
    for label, det in (("źródło", src), ("cel", tgt)):
        ratio = box_area_ratio(det[0], w, h)
        if ratio > MAX_BOX_RATIO:
            return {"success": False, "kind": "drag", "reason": "not_grounded",
                    "detail": f"Ramka dla \"{det[2]}\" ({label}) zajmuje "
                              f"{ratio * 100:.0f}% obrazu (próg "
                              f"{MAX_BOX_RATIO * 100:.0f}%) - model nie wskazał "
                              f"konkretnego miejsca, tylko całość"}

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


# ── Rozgrzewka ──────────────────────────────────────────────────────────────
# Modele MUSZA byc zaladowane, zanim przyjdzie pierwsze zapytanie. Leniwe
# ladowanie dzialalo, dopoki najwiekszy model wazyl 1,7 GB - przy modelu
# wizyjno-jezykowym pierwsze /solve wisialo dwie minuty na pobieraniu wag i
# ginelo na limicie czasu po stronie bota. W logu wygladalo to jak "solver
# nieosiagalny", czyli myllilo trop w strone sieci.
WARMUP = {"done": False, "loading": None, "error": None}


def _warmup():
    for name in [ROUTES["drag"], ROUTES["grid"]]:
        try:
            WARMUP["loading"] = name
            registry.get(name)
        except Exception as e:  # noqa: BLE001
            WARMUP["error"] = f"{name}: {type(e).__name__}: {e}"[:300]
            print(f"[!] Rozgrzewka '{name}' nie powiodła się: {e}")
    WARMUP["loading"] = None
    WARMUP["done"] = True
    print("[+] Rozgrzewka zakończona – solver gotowy na zapytania.")


@app.on_event("startup")
async def _on_start():
    threading.Thread(target=_warmup, daemon=True).start()


def _not_ready(kind: str) -> dict:
    """Szybka, czytelna odmowa zamiast wiszacego zapytania."""
    what = WARMUP["loading"] or "modele"
    return _stamp({
        "success": False, "kind": kind, "reason": "warming_up",
        "detail": f"Solver wciąż ładuje '{what}' (pierwszy start pobiera wagi)."
                  " Spróbuj ponownie za chwilę – to nie jest błąd wyzwania.",
    })


@app.get("/health")
async def health():
    return {
        "ok": True,
        "version": SOLVER_VERSION,
        "ready": WARMUP["done"] and not WARMUP["error"],
        "warmup": {"loading": WARMUP["loading"], "error": WARMUP["error"]},
        "device": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU",
        "vram_gb": round(registry.vram_gb(), 2),
        "budget_gb": MAX_VRAM_GB,
        "routes": ROUTES,
        "loaded": sorted(registry._models.keys()),
        "available": sorted(LOADERS.keys()),
    }


def _stamp(result: dict) -> dict:
    """Kazda odpowiedz niesie wersje procesu, ktory ja wyprodukowal."""
    if isinstance(result, dict):
        result.setdefault("version", SOLVER_VERSION)
    return result


@app.post("/solve")
async def solve(req: SolveRequest):
    kind = req.kind or classify(req.prompt)

    # Kazdy blad backendu wraca jako czytelna odmowa, a nie gole 500.
    # Wczesniej niezlapany wyjatek (np. nieudane ladowanie modelu) docieral do
    # wolajacego jako "Internal Server Error" bez cienia informacji, co padlo.
    # Zapytanie nie moze CZEKAC na zaladowanie modelu: bot ma wlasny limit
    # czasu i zamiast "jeszcze sie laduje" zobaczylby "solver nieosiagalny".
    want = ROUTES.get(kind)
    if want and not registry.is_loaded(want):
        return _not_ready(kind)

    try:
        if kind == "grid":
            return _stamp(await run_in_threadpool(solve_grid, req))
        if kind in ("drag", "rotate"):
            return _stamp(await run_in_threadpool(solve_drag, req))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return _stamp({"success": False, "kind": kind, "reason": "backend_error",
                       "detail": f"{type(e).__name__}: {e}"[:400]})

    # Swiadoma odmowa - klikniecie na chybil trafil spala probe i podnosi
    # ocene ryzyka sesji bardziej niz brak odpowiedzi.
    return _stamp({"success": False, "kind": kind, "reason": "unsupported_challenge",
                   "detail": f"Nie mam modelu do zadania typu \"{kind}\": \"{req.prompt}\""})


@app.post("/analyze-captcha")
async def analyze_captcha(req: SolveRequest):
    """Stary kontrakt (tylko siatka) - zachowany dla zgodności."""
    return _stamp(await run_in_threadpool(solve_grid, req))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)
