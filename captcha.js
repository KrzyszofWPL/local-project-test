'use strict';

const fs = require('fs');
const path = require('path');

// ── Mostek do rozwiazywania hCaptcha ────────────────────────────────────────
//
// Discord odrzuca claim z wyzwaniem hCaptcha: sitekey + rqdata + rqtoken.
// Wstrzyknietemu JS-owi nie da sie tego rozwiazac - ramka hCaptcha jest
// cross-origin, wiec `iframe.contentWindow.document` rzuca SecurityError.
//
// Playwright NIE dziala w piaskownicy strony, tylko na poziomie przegladarki,
// wiec ramki cross-origin sa dla niego normalnie dostepne: mozna je odpytac,
// zrzucic z nich obrazki i w nie kliknac. Caly proces musi wiec zyc tutaj,
// a nie w inject.js.
//
// Przebieg:
//   1. Otwieramy strone na origin discord.com (przechwycona trasa), zeby
//      hCaptcha widziala ten sam host co prawdziwy klient.
//   2. Renderujemy niewidoczny widget z sitekey i odpalamy go z rqdata.
//   3. Zrzucamy kafelki z ramki wyzwania i wysylamy do lokalnego solvera.
//   4. Klikamy wytypowane kafelki i zatwierdzamy.
//   5. Zwracamy token h-captcha-response.

// ── WERSJA MOSTKA - podnies przy KAZDEJ zmianie w tym pliku ────────────────
// Wypisywana raz na kazde rozwiazywanie. Bez tego z samego logu NIE DA SIE
// stwierdzic, czy poprawka jest zaladowana: node trzyma captcha.js w cache
// require(), a solver.py chodzi w OSOBNYM procesie Pythona, ktorego Stop/Start
// w panelu nie restartuje. Dwie diagnozy zostaly juz przez to postawione w
// ciemno - numer wersji w logu konczy te klase watpliwosci raz na zawsze.
const CAPTCHA_VERSION = 'c1.1';

const SOLVER_URL = process.env.SOLVER_URL || 'http://127.0.0.1:5000';
const SOLVE_URL = SOLVER_URL.replace(/\/+$/, '') + '/solve';
const CAPTCHA_URL = 'https://discord.com/__quest_captcha';
const MAX_ROUNDS = parseInt(process.env.CAPTCHA_ROUNDS || '4', 10);
const FRAME_WAIT_MS = parseInt(process.env.CAPTCHA_FRAME_WAIT || '30000', 10);
const MAX_REROLLS = parseInt(process.env.CAPTCHA_REROLLS || '3', 10);

// Jezyk interfejsu hCaptchy. Kontekst przegladarki jest pl-PL, wiec wyzwania
// przychodzily po polsku ("Przeciągnij segment po prawej stronie, aby uzupełnić
// linię"). Grounding DINO ma angielski enkoder tekstu, wiec polska frazy nie
// rozumie w ogole - uziemial sie wtedy na calym obrazku i dawal odpowiedzi
// zdegenerowane. Wymuszamy angielski, zeby model dostawal zapytania w jezyku,
// na ktorym byl trenowany. Ustaw CAPTCHA_LANG=pl, zeby wrocic do lokalizacji
// zgodnej z reszta odcisku przegladarki.
const CAPTCHA_LANG = process.env.CAPTCHA_LANG || 'en';

// Prog wykrywania pustego zrzutu. Jednolita plama koloru kompresuje sie w PNG
// do kilkuset bajtow, a prawdziwe wyzwanie to dziesiatki kilobajtow - roznica
// jest na tyle duza, ze wystarczy rozmiar pliku i nie trzeba dekodowac obrazu.
const MIN_AREA_SHOT_BYTES = parseInt(process.env.CAPTCHA_MIN_SHOT_BYTES || '3000', 10);
const MIN_TILE_SHOT_BYTES = parseInt(process.env.CAPTCHA_MIN_TILE_BYTES || '900', 10);

// Ile kafelkow moze wyjsc pusto, zanim uznamy siatke za niezdatna do wyslania.
// 1/3 to jeden rzad siatki 3x3 - powyzej tego odpowiedz i tak byla zgadywanka.
const MAX_BLANK_TILE_RATIO = parseFloat(process.env.CAPTCHA_MAX_BLANK_RATIO || '0.34');

function pageHtml(sitekey, rqdata) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>verify</title></head>
<body style="background:#1a1a1e">
<div id="cap"></div>
<script>
  window.__capToken = null;
  window.__capError = null;
  window.__capReady = false;
  function onHcLoad() {
    try {
      var id = hcaptcha.render('cap', {
        sitekey: ${JSON.stringify(sitekey)},
        size: 'invisible',
        hl: ${JSON.stringify(CAPTCHA_LANG)},
        callback: function (t) { window.__capToken = t; },
        'error-callback': function (e) { window.__capError = String(e || 'error'); },
        'expired-callback': function () { window.__capError = 'expired'; },
        'chalexpired-callback': function () { window.__capError = 'challenge-expired'; }
      });
      window.__capWidget = id;
      window.__capReady = true;
      var opts = { async: true };
      ${rqdata ? `opts.rqdata = ${JSON.stringify(rqdata)};` : ''}
      // Wariant obietnicowy obok callbacku - przy niewidocznym widgecie to on
      // niesie wynik, a przy okazji lapiemy powod odmowy.
      var p = hcaptcha.execute(id, opts);
      if (p && typeof p.then === 'function') {
        p.then(function (r) {
          window.__capToken = (r && (r.response || r.token)) || window.__capToken;
        }).catch(function (e) {
          window.__capError = 'execute: ' + String((e && e.message) || e);
        });
      }
    } catch (e) {
      window.__capError = String((e && e.message) || e);
    }
  }
</script>
<script src="https://js.hcaptcha.com/1/api.js?render=explicit&onload=onHcLoad&hl=${encodeURIComponent(CAPTCHA_LANG)}" async defer></script>
</body></html>`;
}

// Ramka z wyzwaniem (siatka obrazkow) - hCaptcha trzyma osobna ramke na
// checkbox i osobna na samo wyzwanie. Interesuje nas ta druga.
// Klasy w ramce hCaptcha bywaja zmieniane, wiec nie opieramy sie na jednej.
//
// UWAGA: to MUSI byc lista prob, a nie jeden selektor z przecinkami. W DOM
// hCaptchy `.image-wrapper` siedzi WEWNATRZ `.task-image`, wiec lista alternatyw
// trafia w te sama kratke na dwoch poziomach zagniezdzenia: `count()` zwracalo
// 18 zamiast 9, a tablica zrzutow byla przeplatana [kafelek0, wrapper0,
// kafelek1, wrapper1…]. Model dostawal kazdy obrazek dwa razy, w dwoch roznych
// kadrach - raz z ramka i nakladka, raz bez.
const TILE_SELECTOR_CANDIDATES = [
  '.task-image',
  '[class*="task-image"]',
  '.image-wrapper',
  '[class*="challenge"] .image',
];
// Sam selektor listowy zostaje do wykrywania ramki wyzwania, gdzie liczy sie
// tylko "czy cokolwiek jest", a nie ile tego jest.
const TILE_SELECTORS = TILE_SELECTOR_CANDIDATES.join(', ');
const PROMPT_SELECTORS = '.prompt-text, [class*="prompt-text"], .challenge-prompt';

// Obszar samego zadania - kolejnosc MA znaczenie, od najwezszego do najszerszego.
// Nie wolno tego zwinac do jednego selektora z przecinkami: Playwright zwraca
// wtedy trafienia w kolejnosci dokumentu, a `body` jest przodkiem wszystkiego
// pozostalego, wiec `.first()` zawsze wybieralby cale cialo ramki. Model
// dostawal przez to zrzut z trescia polecenia i przyciskami zamiast samego
// zadania i "uziemial sie" na elementach interfejsu.
const AREA_SELECTORS = [
  '.challenge-interface', '.challenge-view', '.challenge-container',
  '.challenge', 'body',
];

async function challengeFrame(page) {
  const frames = page.frames().filter(f => (f.url() || '').indexOf('hcaptcha.com') !== -1);
  // Najpierw ramka, ktora naprawde ma kafelki - niezaleznie od ksztaltu URL-a.
  for (const frame of frames) {
    try {
      if (await frame.locator(TILE_SELECTORS).first().count()) return frame;
    } catch (_) {}
  }
  // Potem taka, ktora ma chociaz tresc polecenia (kafelki moga sie doladowywac).
  for (const frame of frames) {
    try {
      if (await frame.locator(PROMPT_SELECTORS).first().count()) return frame;
    } catch (_) {}
  }
  return null;
}

// Najwezszy sensowny element obejmujacy samo zadanie. Zwraca lokator, zeby
// wolajacy mogl zrobic zrzut i DOPIERO POTEM zmierzyc prostokat: `screenshot()`
// przewija element do widoku, wiec prostokat pobrany wczesniej moze byc
// nieaktualny, a na nim opiera sie przeliczenie wspolrzednych przeciagniecia.
async function challengeArea(frame) {
  for (const sel of AREA_SELECTORS) {
    const loc = frame.locator(sel).first();
    try {
      if (!(await loc.count())) continue;
      const box = await loc.boundingBox();
      if (box && box.width > 1 && box.height > 1) return { loc, sel };
    } catch (_) {}
  }
  return null;
}

// Kafelki siatki - pierwszy kandydat, ktory cokolwiek lapie, wygrywa. Nie
// laczymy kandydatow przecinkami, bo zagniezdzaja sie w sobie (patrz komentarz
// przy TILE_SELECTOR_CANDIDATES): liczylibysmy te sama kratke wielokrotnie.
async function tileLocator(frame) {
  for (const sel of TILE_SELECTOR_CANDIDATES) {
    try {
      const loc = frame.locator(sel);
      const count = await loc.count();
      if (count) return { loc, count, sel };
    } catch (_) {}
  }
  return { loc: frame.locator(TILE_SELECTOR_CANDIDATES[0]), count: 0, sel: null };
}

// Gdy ramka wyzwania sie nie znajduje, jedyne co pomaga to zobaczyc, co
// naprawde jest na stronie: lista ramek z liczba elementow kandydatow oraz
// zrzut ekranu na dysk.
async function dumpState(page, log, tag) {
  const frames = page.frames();
  const fails = (page && page.__questNetFail) || [];
  log(`[GPU-AI] Diagnostyka (${tag}): ramek=${frames.length}`
    + `, nieudanych żądań do hcaptcha.com: ${fails.length}`
    + (fails.length ? ` [${fails.slice(0, 6).join('; ')}]` : ''));
  for (const f of frames) {
    let info;
    try {
      info = JSON.stringify(await f.evaluate(() => ({
        task: document.querySelectorAll('.task-image').length,
        chal: document.querySelectorAll('.challenge-view').length,
        prompt: document.querySelectorAll('.prompt-text').length,
        img: document.querySelectorAll('img').length,
        iframe: document.querySelectorAll('iframe').length,
        txt: (document.body ? document.body.innerText : '').slice(0, 60).replace(/\s+/g, ' '),
        // Nazwy klas elementow, ktore WYGLADAJA na klikalne kafelki: obrazki
        // albo divy z tlem graficznym. Bez tego zgadujemy selektory w ciemno.
        klasy: Array.from(new Set(Array.from(
          document.querySelectorAll('img, [style*="background-image"], [class*="image"], [class*="tile"], [class*="answer"]')
        ).map(function (el) {
          return (el.className && el.className.baseVal !== undefined
            ? el.className.baseVal : String(el.className || '')).trim();
        }).filter(Boolean))).slice(0, 12),
      })));
    } catch (e) {
      info = 'evaluate: ' + String((e && e.message) || e).slice(0, 60);
    }
    log(`[GPU-AI]   ${(f.url() || 'about:blank').slice(0, 110)} ${info}`);
  }

  try {
    const dir = path.join(__dirname, 'captcha-debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${tag}.png`);
    // BEZ fullPage. Wyzwanie hCaptchy w trybie `size:'invisible'` to nakladka
    // `position: fixed` z ramka cross-origin (OOPIF) w srodku. Chromium sklada
    // zrzut calej strony z kolejnych przewiniec, a elementy `fixed` i OOPIF-y
    // nie trafiaja do kadrow poza pierwszym - dostawalismy PNG w rozmiarze
    // calego dokumentu, w ktorym captcha byla ucieta albo zostawal z niej sam
    // gorny pas. Zwykly zrzut viewportu lapie nakladke w calosci.
    await page.screenshot({ path: file, animations: 'disabled' });
    log(`[GPU-AI] Zrzut ekranu: ${file}`);
  } catch (e) {
    log(`[GPU-AI] Nie udało się zrobić zrzutu: ${(e && e.message) || e}`);
  }
}

// hCaptcha najpierw buduje szkielet zadania, a dopiero potem dociaga grafike -
// przez proxy potrafi to trwac sekundy. `challengeFrame()` zwraca ramke, gdy
// tylko pojawia sie elementy kafelkow, wiec bez tego czekania zrzucalismy
// PUSTE ramki: panel z bialym srodkiem, dokladnie jak na zrzucie z debugu.
// Kafelki hCaptchy noszą grafike jako background-image, nie jako <img>.
//
// `sel` musi byc TYM SAMYM selektorem, ktory wybral `tileLocator()` - inaczej
// czekamy na inny zbior elementow niz ten, ktory potem zrzucamy. Przy ksztalcie
// DOM lapanym dopiero przez ostatniego kandydata stala lista nie znajdowala
// niczego i funkcja konczyla sie timeoutem mimo zaladowanej grafiki.
async function waitForChallengeImages(frame, log, ms, sel) {
  const deadline = Date.now() + (ms || 15000);
  let last = -1;
  while (Date.now() < deadline) {
    const stat = await frame.evaluate((tileSel) => {
      const els = Array.from(document.querySelectorAll(tileSel));
      let loaded = 0;
      for (const el of els) {
        const inner = el.querySelector('.image') || el;
        const bg = getComputedStyle(inner).backgroundImage;
        if (bg && bg !== 'none' && bg.indexOf('url(') !== -1) loaded++;
      }
      // Zadania pozycyjne nie maja kafelkow - tam patrzymy na canvas/obrazki.
      const canvas = document.querySelectorAll('canvas, .challenge-view img').length;
      return { total: els.length, loaded: loaded, canvas: canvas };
    }, sel || TILE_SELECTORS).catch(() => null);

    if (!stat) return false;
    if (stat.total && stat.loaded >= stat.total) return true;
    if (!stat.total && stat.canvas) return true;

    if (stat.loaded !== last) {
      last = stat.loaded;
      if (stat.total) log(`[GPU-AI] Ładowanie grafiki zadania: ${stat.loaded}/${stat.total}`);
    }
    await frame.page().waitForTimeout(500);
  }
  log('[GPU-AI] Grafika zadania nie doładowała się w czasie – zrzucam, co jest.');
  return false;
}

// Solver routuje po typie zadania i odsyla akcje do wykonania: klikniecie
// kafelkow albo przeciagniecie miedzy dwoma punktami.
async function askSolver(payload, log) {
  let res;
  try {
    res = await fetch(SOLVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    log(`[GPU-AI] Solver nieosiągalny: ${(e && e.message) || e}`);
    return null;
  }

  // Czytamy tekstem, nie od razu JSON-em: przy niezlapanym wyjatku FastAPI
  // odsyla goly "Internal Server Error", ktory po res.json() gubil sie jako "?"
  // i zostawial nas bez powodu awarii.
  const raw = await res.text().catch(() => '');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

  if (!res.ok) {
    const why = (data && (data.detail || data.reason)) || raw.slice(0, 300) || '(puste ciało)';
    log(`[GPU-AI] Solver zwrócił HTTP ${res.status}: `
      + (typeof why === 'string' ? why : JSON.stringify(why).slice(0, 300)));
    return null;
  }
  if (!data || !data.success) {
    // Swiadoma odmowa - nie klikamy na oslep, bo spalona proba kosztuje wiecej.
    log(`[GPU-AI] Solver odmówił [${(data && data.kind) || '?'}]: `
      + `${(data && data.reason) || 'brak odpowiedzi'}`
      + (data && data.detail ? ` – ${data.detail}` : '')
      + (data && data.version ? ` (solver ${data.version})` : ' (solver bez wersji – STARY PROCES?)'));
    return null;
  }
  log(`[GPU-AI] Solver [${data.kind}/${data.model || '?'}] → akcja: ${data.action}`
    + (data.version ? ` (solver ${data.version})` : ' (solver bez wersji – STARY PROCES?)'));
  return data;
}

// Przeciagniecie wewnatrz ramki. Solver zwraca wspolrzedne znormalizowane
// 0..1 wzgledem przeslanego zrzutu, wiec przeliczamy je na piksele strony
// przez prostokat elementu, ktory zrzucalismy.
// Klikniecie prawdziwa myszą, z dojsciem do celu. Playwright potrafi kliknac
// element sam, ale robi to teleportem kursora - a brak trajektorii dojscia to
// jeden z sygnalow, po ktorych hCaptcha rozpoznaje automat. Celujemy w losowy
// punkt w poblizu srodka, nie zawsze dokladnie w srodek.
async function humanClick(page, box) {
  const tx = box.x + box.width / 2 + (Math.random() - 0.5) * Math.min(10, box.width * 0.3);
  const ty = box.y + box.height / 2 + (Math.random() - 0.5) * Math.min(10, box.height * 0.3);
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const from = { x: tx - 30 - Math.random() * 70, y: ty - 25 - Math.random() * 60 };
  await page.mouse.move(from.x, from.y);
  const steps = 9 + Math.floor(Math.random() * 6);
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (tx - from.x) * t, from.y + (ty - from.y) * t);
    await page.waitForTimeout(7 + Math.random() * 15);
  }
  await page.waitForTimeout(50 + Math.random() * 110);
  await page.mouse.down();
  await page.waitForTimeout(45 + Math.random() * 85);
  await page.mouse.up();
}

async function performDrag(page, box, from, to, log) {
  // Model potrafi zwrocic wartosc spoza 0..1 (ramka wystajaca poza obrazek).
  // Bez przyciecia kursor wyjezdza poza obszar zadania, hCaptcha gubi wskaznik
  // w trakcie gestu i wyzwanie konczy sie bledem zamiast zla odpowiedzia.
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const px = (pt) => ({
    x: box.x + clamp01(pt[0]) * box.width,
    y: box.y + clamp01(pt[1]) * box.height,
  });
  const a = px(from);
  const b = px(to);
  log(`[GPU-AI] Przeciągam (${Math.round(a.x)},${Math.round(a.y)})`
    + ` → (${Math.round(b.x)},${Math.round(b.y)})`);

  // hCaptcha punktuje SAM RUCH, nie tylko punkt koncowy: bada m.in. brak
  // laczenia zdarzen pointer (prawdziwa mysz daje kilka probek sprzetowych na
  // klatke, ruch wstrzykniety przez CDP jedna), spojnosc movementX/Y z delta
  // pozycji oraz klikniecia bez trajektorii dojscia. Poprzednia wersja
  // teleportowala kursor na start i jechala 18 krokami po prostej ze stalym
  // tempem - wzorzec, ktory takie kontrole wylapuja wprost.
  //
  // Nizej: dojscie do zrodla z biezacej pozycji, krzywa Beziera zamiast
  // odcinka, przyspieszenie i wyhamowanie (easing), przestrzelenie z korekta
  // oraz pauzy wokol wcisniecia i puszczenia przycisku.
  const jitter = (v) => v + (Math.random() - 0.5) * 2;

  // Punkt kontrolny z boku odcinka - im dluzszy gest, tym wieksze wybrzuszenie.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(60, dist * 0.22) * (Math.random() < 0.5 ? -1 : 1);
  const ctrl = {
    x: (a.x + b.x) / 2 - (dy / dist) * bow,
    y: (a.y + b.y) / 2 + (dx / dist) * bow,
  };
  const bezier = (p0, p1, p2, t) => {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    };
  };
  // Wolno-szybko-wolno. Bez tego predkosc jest stala, czego ludzka reka nie robi.
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // Dojscie do zrodla - kursor ma miec skad przyjechac.
  const approach = { x: a.x - 40 - Math.random() * 60, y: a.y - 30 - Math.random() * 50 };
  await page.mouse.move(approach.x, approach.y);
  for (let i = 1; i <= 8; i++) {
    const t = ease(i / 8);
    await page.mouse.move(approach.x + (a.x - approach.x) * t,
                          approach.y + (a.y - approach.y) * t);
    await page.waitForTimeout(8 + Math.random() * 14);
  }

  await page.waitForTimeout(90 + Math.random() * 140);
  await page.mouse.down();
  await page.waitForTimeout(60 + Math.random() * 90);

  const steps = 22 + Math.floor(Math.random() * 12);
  for (let i = 1; i <= steps; i++) {
    const p = bezier(a, ctrl, b, ease(i / steps));
    await page.mouse.move(jitter(p.x), jitter(p.y));
    await page.waitForTimeout(10 + Math.random() * 22);
  }

  // Przestrzelenie i korekta - ludzka reka rzadko zatrzymuje sie od razu w celu.
  await page.mouse.move(b.x + (Math.random() - 0.5) * 7, b.y + (Math.random() - 0.5) * 7);
  await page.waitForTimeout(40 + Math.random() * 70);
  await page.mouse.move(b.x, b.y);

  await page.waitForTimeout(110 + Math.random() * 160);
  await page.mouse.up();
  await page.waitForTimeout(600);
}

// hCaptcha wystawia rozne typy wyzwan. Solver oparty o detekcje obiektow
// (YOLO/COCO) potrafi obsluzyc WYLACZNIE siatke obrazkow - reszta to zupelnie
// inne zadania (przeciaganie elementow, geometria, rozpoznawanie ksztaltow),
// dla ktorych detektor obiektow nie ma zadnego zastosowania.
function classifyChallenge(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (/\bdrag\b|przeciągnij|przeciagnij|\bslide\b|\bmove the\b/.test(p)) return 'drag';
  if (/\brotate\b|obróć|obroc|\bturn the\b/.test(p)) return 'rotate';
  // Obejmuje takze wyzwania "semantyczne" ("wybierz zwierze, ktore wykluwa sie
  // z jajka") - to nadal wybor obrazka, tylko polecenie opisuje go pojęciem,
  // a nie nazwa. Wczesniej wpadaly w 'nieznany' i solver je odrzucal.
  // Kazde "select …" / "click …" to wybor kafelkow. Wczesniejsza lista
  // wyliczala konkretne sformulowania i przepuszczala warianty w rodzaju
  // "Select items that are primarily metal", ktore ladowaly w 'nieznany'.
  if (/\bselect\b|\bclick\b|\bchoose\b|\bpick\b|\bwhich of\b|zaznacz|kliknij|wybierz/.test(p)) {
    return 'grid';
  }
  return 'nieznany';
}

// Nowe wyzwanie zamiast obecnego - hCaptcha losuje typ, wiec przy zadaniu
// spoza mozliwosci solvera warto sprobowac wylosowac siatke obrazkow.
// Interfejs hCaptchy jest tlumaczony - przy polskiej lokalizacji przycisk ma
// aria-label "Odśwież wyzwanie", wiec dopasowania po angielskim tekscie nie
// trafiaja. Klasa `.refresh` jest stabilna, ale bywa ich w drzewie kilka.
const REFRESH_SELECTORS = '.refresh, .button-refresh,'
  + ' [aria-label*="new challenge" i], [title*="new challenge" i],'
  + ' [aria-label*="odśwież" i], [title*="odśwież" i],'
  + ' [aria-label*="odswiez" i], [title*="odswiez" i]';

async function reroll(frame, log) {
  try {
    const all = frame.locator(REFRESH_SELECTORS);
    const n = await all.count();
    if (!n) {
      log('[GPU-AI] Brak przycisku losowania nowego wyzwania.');
      return false;
    }

    // Bierzemy pierwszy WIDOCZNY, a nie pierwszy w drzewie. `.first()` trafialo
    // w egzemplarz ukryty (hCaptcha trzyma zapasowe kopie kontrolek), przez co
    // klikniecie konczylo sie "element is not visible" po 5 s czekania.
    //
    // `isVisible()` to jednak za waskie kryterium: zwraca false takze dla
    // przycisku, ktory MA prostokat i da sie w niego trafic myszą, a jest tylko
    // przezroczysty albo przykryty warstwa animacji. W logach wygladalo to jak
    // "znaleziono 1, zaden nie jest widoczny" - i przelosowanie nigdy nie
    // dochodzilo do skutku, wiec bot za kazdym razem wracal do tego samego,
    // nierozwiazywalnego zadania. Kryterium jest teraz PROSTOKAT: jesli element
    // zajmuje miejsce na ekranie, klikamy w jego srodek prawdziwa myszą.
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      const visible = await el.isVisible().catch(() => false);
      const box = await el.boundingBox().catch(() => null);
      if (!visible && !(box && box.width > 2 && box.height > 2)) continue;

      if (box) {
        await humanClick(frame.page(), box);
      } else {
        await el.click({ timeout: 5000 });
      }
      await frame.page().waitForTimeout(2000);
      return 'odswiezone';
    }

    // NIE forsujemy klikniecia przez dispatchEvent. Sprawdzone: syntetyczne
    // zdarzenie na przycisku odswiezania hCaptcha odrzuca i psuje cale
    // wyzwanie - w logu wychodzi "challenge-error" dwie sekundy pozniej.
    //
    // Zamiast tego POMIJAMY runde. Przycisk zatwierdzenia hCaptchy przy braku
    // zaznaczenia nosi etykiete "Skip" - to ten sam element `.button-submit`,
    // ktory sluzy do wysylania odpowiedzi. Widac to w zrzucie diagnostycznym z
    // wczesniejszego biegu: tresc ramki to "Please try again. ⚠️ Skip EN".
    // Pominiecie przechodzi do nastepnej rundy, a hCaptcha laczy rundy w
    // lancuch, w ktorym kolejna bywa z INNEJ rodziny zadan - czyli to jedyna
    // dostepna droga z nierozwiazywalnego przeciagania do siatki obrazkow.
    log(`[GPU-AI] Żaden z ${n} przycisków odświeżenia nie nadaje się do kliknięcia`
      + ' – pomijam rundę zamiast forsować klik.');
    return (await skipChallenge(frame, log)) ? 'pominiete' : false;
  } catch (e) {
    log(`[GPU-AI] Nie udało się wylosować nowego wyzwania: ${(e && e.message) || e}`);
    return false;
  }
}

const SUBMIT_SELECTORS = '.button-submit, .verify-button';

// Pominiecie rundy: klikniecie przycisku zatwierdzenia BEZ zaznaczonej
// odpowiedzi. hCaptcha renderuje wtedy na nim "Skip", nie "Verify".
async function skipChallenge(frame, log) {
  const ok = await clickControl(frame, SUBMIT_SELECTORS, log, 'pominięcie');
  if (ok) {
    log('[GPU-AI] Runda pominięta – czekam na następne wyzwanie.');
    await frame.page().waitForTimeout(2000);
  }
  return ok;
}

// Zatwierdzenie odpowiedzi. Wczesniej bledy klikniecia byly polykane przez
// .catch(() => {}), wiec nieklikniety przycisk (np. niewidoczny, tak jak
// przycisk odswiezania) byl nieodrozninalny od poprawnie wyslanej odpowiedzi -
// a nastepnym, co widac w logu, jest juz tylko blad hCaptchy.
async function clickSubmit(frame, log) {
  return clickControl(frame, SUBMIT_SELECTORS, log, 'zatwierdzenie');
}

// Klika pierwszy egzemplarz, w ktory da sie trafic myszą. hCaptcha trzyma w
// drzewie zapasowe kopie kontrolek, wiec `.first()` czesto wskazuje ukryta.
//
// Ostatnia proba przez dispatchEvent zostala USUNIETA. Ta sama technika na
// przycisku odswiezania byla juz raz zdiagnozowana jako psujaca cale wyzwanie
// (patrz komentarz w reroll) - syntetyczne zdarzenie bez poprzedzajacego ruchu
// myszy jest dla hCaptchy sygnalem automatu, a nie klikniecia. Trzymanie tego
// samego wyjatku w sciezce zatwierdzenia bylo niekonsekwencja: uratowany klik
// i tak konczyl sie odrzuceniem odpowiedzi, tyle ze rundę pozniej.
async function clickControl(frame, selector, log, what) {
  const all = frame.locator(selector);
  const n = await all.count();
  if (!n) {
    log(`[GPU-AI] Nie znaleziono przycisku (${what}).`);
    return false;
  }
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const visible = await el.isVisible().catch(() => false);
    const box = await el.boundingBox().catch(() => null);
    if (!visible && !(box && box.width > 2 && box.height > 2)) continue;
    try {
      if (box) await humanClick(frame.page(), box);
      else await el.click({ timeout: 5000 });
      return true;
    } catch (e) {
      log(`[GPU-AI] Kliknięcie (${what}) nie powiodło się: ${(e && e.message) || e}`);
      return false;
    }
  }
  log(`[GPU-AI] Żaden z ${n} przycisków (${what}) nie nadaje się do kliknięcia.`);
  return false;
}

// Jedna runda wyzwania: przeczytaj polecenie, zrzuc kafelki, zapytaj solver,
// klikaj, zatwierdz. Zwraca kod statusu opisujacy, co sie stalo.
async function playRound(frame, log, page, opts) {
  const allowPositional = !!(opts && opts.allowPositional);
  let prompt = '';
  try {
    prompt = (await frame.locator(PROMPT_SELECTORS).first().innerText({ timeout: 8000 })).trim();
  } catch (_) {
    log('[GPU-AI] Nie udało się odczytać treści zadania z ramki.');
    return 'brak-polecenia';
  }

  const kind = classifyChallenge(prompt);
  log(`[GPU-AI] Zadanie [${kind}]: "${prompt}"`);

  const { loc: tileLoc, count, sel: tileSel } = await tileLocator(frame);
  if (count) log(`[GPU-AI] Kafelki: ${count} (selektor ${tileSel})`);

  // Zadania pozycyjne (przeciaganie, obracanie) nie maja kafelkow - wysylamy
  // zrzut calego obszaru wyzwania i dostajemy wspolrzedne zamiast indeksow.
  if (!count) {
    if (kind === 'grid') {
      log('[GPU-AI] Polecenie wygląda na siatkę, ale nie znalazłem kafelków.');
      if (page) await dumpState(page, log, 'brak-kafelkow');
      return 'brak-kafelkow';
    }

    // Zadania pozycyjne to najslabsza strona solvera - grounding wskazuje
    // obiekty, a tu trzeba trafic w konkretne miejsce (czesto w PUSTE miejsce,
    // ktorego detektor z definicji nie znajdzie). Dopoki zostaly przelosowania,
    // taniej jest wylosowac siatke obrazkow niz strzelac.
    if (!allowPositional) {
      log(`[GPU-AI] Zadanie pozycyjne [${kind}] - wolę wylosować siatkę obrazków.`);
      return 'pozycyjne';
    }

    const area = await challengeArea(frame);
    if (!area) {
      log('[GPU-AI] Nie udało się zmierzyć obszaru wyzwania.');
      if (page) await dumpState(page, log, 'brak-obszaru');
      return 'brak-kafelkow';
    }

    // Zrzut PRZED pomiarem: screenshot() przewija element do widoku, wiec
    // prostokat musi pochodzic z tego samego stanu strony co obrazek.
    //
    // Zwrotka NIE moze byc ignorowana: `false` znaczy, ze minal timeout i czesc
    // grafiki wciaz sie nie doladowala. Wczesniej szlismy dalej mimo to i model
    // dostawal niepelny obraz - a przez proxy SOCKS5 to nie jest rzadki
    // przypadek brzegowy, tylko norma przy wolnym lączu.
    if (!(await waitForChallengeImages(frame, log, null, tileSel))) {
      log('[GPU-AI] Grafika wyzwania niekompletna po timeoucie'
        + ' - nie wysyłam uciętego obrazu do modelu.');
      if (page) await dumpState(page, log, 'niepelna-grafika');
      return 'niepelna-grafika';
    }

    const shot = await area.loc.screenshot({ timeout: 10000, animations: 'disabled' });

    // Ramka hCaptchy jest cross-origin, wiec Chromium renderuje ja w osobnym
    // procesie (OOPIF). W trybie headless, gdy strona nie jest na wierzchu,
    // taka ramka potrafi w ogole nie trafic do kompozycji - zrzut wychodzi
    // wtedy jednolicie szary (samo tlo strony), a model dostaje PUSTY obrazek
    // i "uziemia sie" na niczym. Wygladalo to jak slabosc modelu, a bylo
    // brakiem danych wejsciowych.
    if (shot.length < MIN_AREA_SHOT_BYTES) {
      log(`[GPU-AI] Zrzut obszaru wyzwania jest pusty (${shot.length} B < `
        + `${MIN_AREA_SHOT_BYTES} B) - ramka hCaptcha nie została namalowana.`
        + ' Nie wysyłam pustego obrazka do modelu.');
      if (page) await dumpState(page, log, 'pusty-zrzut');
      return 'pusty-zrzut';
    }

    const box = await area.loc.boundingBox();
    if (!box) {
      log('[GPU-AI] Obszar wyzwania zniknął po zrzucie.');
      return 'brak-kafelkow';
    }
    log(`[GPU-AI] Obszar zadania: ${area.sel} ${Math.round(box.width)}×${Math.round(box.height)}`);

    // Playwright nie dorysuje pikseli spoza prostokata, jaki <iframe> hCaptchy
    // zajmuje w dokumencie rodzica - to OOPIF, jego zawartosc konczy sie na
    // krawedzi ramki. Jesli obszar zadania jest wyzszy/szerszy niz sama ramka,
    // zrzut jest UCIETY, a wspolrzedne przeciagniecia licza sie wzgledem
    // prostokata, ktorego model nigdy w calosci nie zobaczyl.
    try {
      const el = await frame.frameElement();
      const fbox = await el.boundingBox();
      if (fbox && (box.width - fbox.width > 2 || box.height - fbox.height > 2)) {
        log(`[GPU-AI] UWAGA: obszar zadania (${Math.round(box.width)}×`
          + `${Math.round(box.height)}) wystaje poza ramkę (${Math.round(fbox.width)}×`
          + `${Math.round(fbox.height)}) - zrzut jest ucięty na krawędzi iframe.`);
      }
    } catch (_) {}

    const answer = await askSolver({
      prompt: prompt,
      kind: kind,
      image_data: 'data:image/png;base64,' + shot.toString('base64'),
    }, log);

    // Odmowa solvera na zadaniu pozycyjnym NIE konczy juz calego rozwiazywania.
    // Wysylanie zgadnietego przeciagniecia jest gorsze niz brak odpowiedzi:
    // hCaptcha odrzuca zla odpowiedz bledem `challenge-error` i pali cala
    // sesje wyzwania. Pominiecie rundy kosztuje tyle samo, a daje szanse, ze
    // nastepna runda przyjdzie z rodziny, ktora faktycznie umiemy rozwiazac.
    if (!answer) return 'pomin';

    if (answer.action === 'drag' && Array.isArray(answer.from) && Array.isArray(answer.to)) {
      if (answer.confidence === 'low') {
        log('[GPU-AI] Uwaga: model zgłasza NISKĄ pewność dla zadania pozycyjnego.');
      }

      // Zerowy albo mikroskopijny wektor to nie jest odpowiedz - to znak, ze
      // grounding zwrocil dwa razy ten sam obszar (zwykle caly obrazek).
      const dist = Math.hypot(answer.to[0] - answer.from[0], answer.to[1] - answer.from[1]);
      if (!(dist > 0.02)) {
        log(`[GPU-AI] Odrzucam odpowiedź: wektor przeciągnięcia ~0 (${dist.toFixed(3)})`
          + ' - model wskazał dwa razy to samo miejsce.');
        return 'pomin';
      }

      await performDrag(page, box, answer.from, answer.to, log);
    } else {
      log(`[GPU-AI] Solver nie zwrócił wykonalnej akcji (${answer.action || '?'}).`);
      return 'pomin';
    }

    if (!(await clickSubmit(frame, log))) return 'brak-zatwierdzenia';
    return 'zatwierdzone';
  }

  if (kind !== 'grid') {
    log('[GPU-AI] Kafelki są, ale polecenie nie wygląda na wybór obrazków'
      + ' - próbuję mimo to.');
  }

  // Jak wyzej: `false` = timeout i niedoladowana grafika. Zrzucanie "co jest"
  // konczylo sie wysylaniem do modelu siatki z szarymi dziurami.
  if (!(await waitForChallengeImages(frame, log, null, tileSel))) {
    log('[GPU-AI] Grafika kafelków niekompletna po timeoucie'
      + ' - nie wysyłam uciętej siatki do modelu.');
    if (page) await dumpState(page, log, 'niepelna-grafika');
    return 'niepelna-grafika';
  }

  const tiles = [];
  let blankTiles = 0;
  for (let i = 0; i < count; i++) {
    const shot = await tileLoc.nth(i).screenshot({ timeout: 10000, animations: 'disabled' });
    if (shot.length < MIN_TILE_SHOT_BYTES) blankTiles++;
    tiles.push('data:image/png;base64,' + shot.toString('base64'));
  }

  // Ta sama pulapka co przy zadaniach pozycyjnych: puste kafelki oznaczaja, ze
  // ramka nie zostala namalowana, a nie ze model sie myli.
  //
  // Prog, nie warunek "wszystkie": przy czesciowo namalowanej ramce model
  // dostawal komplet indeksow, z ktorych czesc byla szarymi prostokatami, i
  // typowal z tego, co widzial. Odpowiedz z polowa siatki zgadnietej w ciemno
  // spala runde tak samo jak brak odpowiedzi, a dodatkowo podnosi ocene ryzyka.
  if (blankTiles >= Math.max(1, Math.ceil(count * MAX_BLANK_TILE_RATIO))) {
    log(`[GPU-AI] ${blankTiles}/${count} kafelków to puste obrazki - ramka hCaptcha`
      + ' nie została namalowana w całości. Nie wysyłam niepełnej siatki do modelu.');
    if (page) await dumpState(page, log, 'puste-kafelki');
    return 'pusty-zrzut';
  }
  if (blankTiles) {
    log(`[GPU-AI] Uwaga: ${blankTiles}/${count} kafelków wygląda na puste.`);
  }
  log(`[GPU-AI] Zrzucono ${tiles.length} kafelków, wysyłam do GPU...`);

  const answer = await askSolver({ prompt: prompt, kind: 'grid', tiles: tiles }, log);
  if (!answer) return 'solver-odmowil';

  const picks = Array.isArray(answer.click_indices) ? answer.click_indices : [];
  log(`[GPU-AI] Cel "${answer.target || '?'}" → kafelki [${picks.join(', ')}]`);
  if (!picks.length) {
    // Zero pasujacych kafelkow to LEGALNA odpowiedz w hCaptchy: czesc rund nie
    // zawiera zadnego trafienia, a przycisk nosi wtedy etykiete "Skip" i
    // pominiecie jest ruchem POPRAWNYM. Wczesniej konczylo sie to porzuceniem
    // calego rozwiazywania, czyli gwarantowanym zerem.
    log('[GPU-AI] Model nie wskazał żadnego kafelka – pomijam rundę'
      + ' (brak trafień to dopuszczalna odpowiedź).');
    return 'pomin';
  }

  // Nieudane klikniecia byly dotad polykane w cichosci, wiec zatwierdzenie
  // PUSTEJ odpowiedzi wygladalo w logu identycznie jak poprawna runda.
  let clicked = 0;
  const failed = [];
  for (const idx of picks) {
    if (idx < 0 || idx >= count) continue;
    try {
      // Prawdziwa mysz z dojsciem zamiast teleportu Playwrighta - hCaptcha
      // bada trajektorie kursora, nie tylko to, ze klikniecie doszlo.
      const box = await tileLoc.nth(idx).boundingBox().catch(() => null);
      if (box) await humanClick(frame.page(), box);
      else await tileLoc.nth(idx).click({ timeout: 5000 });
      clicked++;
    } catch (e) {
      failed.push(idx);
    }
    await frame.page().waitForTimeout(250 + Math.random() * 250);
  }
  if (failed.length) {
    log(`[GPU-AI] Nie udało się kliknąć kafelków [${failed.join(', ')}]`
      + ` – zaznaczono ${clicked}/${picks.length}.`);
  }
  if (!clicked) {
    log('[GPU-AI] Żaden kafelek nie został zaznaczony - nie zatwierdzam pustej odpowiedzi.');
    return 'solver-odmowil';
  }

  if (!(await clickSubmit(frame, log))) return 'brak-zatwierdzenia';
  return 'zatwierdzone';
}

/**
 * Rozwiazuje wyzwanie hCaptcha i zwraca token, albo null.
 * @param {import('playwright').BrowserContext} context
 * @param {{sitekey: string, rqdata?: string}} challenge
 * @param {(msg: string) => void} log
 */
async function solveCaptcha(context, challenge, log) {
  if (!challenge || !challenge.sitekey) {
    log('[GPU-AI] Brak sitekey - nie ma czego rozwiązywać.');
    return null;
  }

  let page = null;
  try {
    page = await context.newPage();
    page.setDefaultTimeout(20000);

    // ── Diagnostyka sieci wyzwania ────────────────────────────────────────
    // Na zrzucie debugowym panel hCaptchy renderuje sie w calosci - polecenie,
    // stopka, przyciski - a obszar kafelkow zostaje PUSTY. Skoro dokument
    // ramki dochodzi, a grafika nie, to problem jest na poziomie pojedynczych
    // zadan sieciowych, nie renderowania. Obrazki zadan leca z innego hosta
    // (imgs.hcaptcha.com) niz sam widget (newassets.hcaptcha.com) i ida przez
    // ten sam mostek SOCKS5, ktory dla serii rownoleglych polaczen bywa waskim
    // gardlem.
    //
    // Bez tego licznika "model dostal bialy obrazek" i "obrazek nigdy nie
    // przyszedl" wygladaja w logu IDENTYCZNIE - a to zupelnie inne usterki.
    const netFail = [];
    page.on('requestfailed', (req) => {
      try {
        const u = req.url();
        if (u.indexOf('hcaptcha.com') === -1) return;
        const why = (req.failure() && req.failure().errorText) || '?';
        netFail.push(`${req.resourceType()} ${why}`);
        log(`[GPU-AI] SIEĆ ✗ ${req.resourceType()} ${why} – ${u.slice(0, 110)}`);
      } catch (_) {}
    });
    page.on('response', (res) => {
      try {
        const u = res.url();
        if (u.indexOf('hcaptcha.com') === -1 || res.status() < 400) return;
        netFail.push(`HTTP ${res.status()}`);
        log(`[GPU-AI] SIEĆ ✗ HTTP ${res.status()} – ${u.slice(0, 110)}`);
      } catch (_) {}
    });
    page.__questNetFail = netFail;

    // Karta MUSI byc aktywna. Strona konta zostaje otwarta obok, wiec bez tego
    // strona wyzwania jest kartą w tle: document.visibilityState = 'hidden',
    // a Chromium potrafi wtedy nie kompozytowac cross-originowej ramki
    // hCaptchy. Objaw: zrzuty wychodza jednolicie szare, kontrolki raportuja
    // "element is not visible", a model dostaje pusty obrazek.
    await page.bringToFront().catch(() => {});

    // Ta sama domena co prawdziwy klient - hCaptcha wiaze wyzwanie z hostem.
    await page.route(CAPTCHA_URL, route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: pageHtml(challenge.sitekey, challenge.rqdata || null),
    }));

    log(`[GPU-AI] Mostek ${CAPTCHA_VERSION} | otwieram wyzwanie`
      + ` (sitekey ${String(challenge.sitekey).slice(0, 8)}…`
      + `, rqdata ${challenge.rqdata ? 'jest' : 'brak'})`);
    await page.goto(CAPTCHA_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => window.__capReady === true || window.__capError,
      { timeout: 30000 });
    const early = await page.evaluate(() => window.__capError);
    if (early) {
      log(`[GPU-AI] hCaptcha nie wystartowała: ${early}`);
      return null;
    }

    let rerolls = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const token = await page.evaluate(() => window.__capToken);
      if (token) {
        log(`[GPU-AI] Token uzyskany po ${round - 1} rundzie/ach.`);
        return token;
      }

      const err = await page.evaluate(() => window.__capError);
      if (err) {
        log(`[GPU-AI] hCaptcha zgłosiła błąd: ${err}`);
        // Bliźniacza gałąź w pętli oczekiwania nizej zrzucala stan, a ta nie -
        // czyli akurat najczestsza sciezka bledu (odrzucenie odpowiedzi po
        // zatwierdzeniu rundy) nie zostawiala po sobie ZADNEGO sladu.
        await dumpState(page, log, 'challenge-error');
        return null;
      }

      // Wyzwanie potrafi sie ladowac dluzej niz kilka sekund, zwlaszcza przez
      // proxy - czekamy do FRAME_WAIT_MS, po drodze sprawdzajac, czy token nie
      // przyszedl bez pokazywania siatki.
      let frame = null;
      const deadline = Date.now() + FRAME_WAIT_MS;
      while (!frame && Date.now() < deadline) {
        frame = await challengeFrame(page);
        if (frame) break;
        const t = await page.evaluate(() => window.__capToken);
        if (t) {
          log('[GPU-AI] Token przyszedł bez siatki (wyzwanie pominięte).');
          return t;
        }
        const e2 = await page.evaluate(() => window.__capError);
        if (e2) {
          log(`[GPU-AI] hCaptcha przerwała: ${e2}`);
          await dumpState(page, log, 'error');
          return null;
        }
        await page.waitForTimeout(500);
      }

      if (!frame) {
        log(`[GPU-AI] Ramka wyzwania nie pojawiła się w ${Math.round(FRAME_WAIT_MS / 1000)}s.`);
        await dumpState(page, log, 'brak-ramki');
        return null;
      }

      // Konto pracuje na sasiedniej karcie i moze ja w miedzyczasie przejac.
      await page.bringToFront().catch(() => {});

      // Zrzut ZANIM czegokolwiek dotkniemy. Dotad `dumpState` odpalal sie
      // wylacznie po bledzie, a hCaptcha przy bledzie czysci kafelki i zostawia
      // sam szkielet panelu z napisem "Please try again" - czyli KAZDY zrzut,
      // jaki mielismy, pokazywal stan PO awarii. Z takiego obrazu nie da sie
      // orzec, czy grafika nigdy nie przyszla, czy zostala usunieta razem z
      // wyzwaniem. To sa zupelnie rozne usterki i prowadza w przeciwne strony.
      if (process.env.CAPTCHA_DEBUG_SHOTS !== 'false') {
        await dumpState(page, log, `runda${round}-przed-dotknieciem`);
      }

      log(`[GPU-AI] Runda ${round}/${MAX_ROUNDS}`);
      // Gdy przelosowania sie skoncza, przestajemy wybrzydzac i probujemy
      // rozwiazac to, co dostalismy - lepsza slaba proba niz zadna.
      const status = await playRound(frame, log, page,
        { allowPositional: rerolls >= MAX_REROLLS });

      if ((status === 'brak-kafelkow' || status === 'pozycyjne') && rerolls < MAX_REROLLS) {
        rerolls++;
        log(`[GPU-AI] Szukam innego wyzwania (${rerolls}/${MAX_REROLLS})...`);

        const how = await reroll(frame, log);
        // Odswiezenie przyciskiem NIE jest rozwiazana runda - bez cofniecia
        // licznika trzy proby zjadaly caly budzet MAX_ROUNDS i na faktyczne
        // rozwiazywanie nie zostawalo nic. Pominiecie natomiast runde ZUZYWA
        // (odpowiedz idzie na serwer, tyle ze pusta), wiec licznika nie ruszamy.
        if (how === 'odswiezone') { round--; continue; }
        if (how === 'pominiete') continue;

        // Bez przycisku losowania nie ma po co isc dalej z tym samym zadaniem -
        // ale przy zadaniu pozycyjnym sprobujmy je chociaz rozwiazac.
        if (status !== 'pozycyjne') return null;
        rerolls = MAX_REROLLS;
        continue;
      }

      // Wyzwania, ktorego nie umiemy rozwiazac, NIE probujemy zgadywac.
      // Pomijamy runde i prosimy o nastepna: hCaptcha laczy rundy w lancuch i
      // kolejna bywa z innej rodziny zadan, wiec to jedyna droga z przeciagania
      // (ktorego grounding nie obsluguje) do siatki obrazkow (ktora CLIP
      // rozwiazuje). Wczesniej kazda taka runda konczyla CALE rozwiazywanie -
      // stad zero odebranych nagrod przy kazdym wyzwaniu pozycyjnym.
      if (status === 'pomin') {
        if (round >= MAX_ROUNDS) {
          log(`[GPU-AI] Wyczerpano ${MAX_ROUNDS} rund – same zadania poza zasięgiem solvera.`);
          return null;
        }
        if (!(await skipChallenge(frame, log))) {
          log('[GPU-AI] Nie udało się pominąć rundy – przerywam.');
          await dumpState(page, log, 'brak-pominiecia');
          return null;
        }
        continue;
      }

      // Niedoladowana grafika to stan PRZEJSCIOWY, w odroznieniu od ramki, ktora
      // w ogole nie zostaje namalowana. Dajemy jej kolejna runde - obrazki maja
      // wtedy tyle czasu, ile trwa jedno okrazenie petli - zamiast konczyc caly
      // przebieg i marnowac wyzwanie, ktore za chwile bedzie kompletne.
      if (status === 'niepelna-grafika') {
        if (round >= MAX_ROUNDS) {
          log('[GPU-AI] Grafika wyzwania nie doładowała się do końca'
            + ` w ${MAX_ROUNDS} rundach - przerywam.`);
          return null;
        }
        log('[GPU-AI] Grafika niekompletna - czekam i próbuję jeszcze raz.');
        await page.waitForTimeout(3000);
        continue;
      }

      if (status === 'pusty-zrzut') {
        log('[GPU-AI] Przerywam: bez obrazu wyzwania rozwiązanie jest niemożliwe.'
          + ' Ramka hCaptcha jest w DOM, ale nie zostaje namalowana - typowo'
          + ' przy headless. Wyłącz tryb headless w panelu i sprawdź ponownie.');
        return null;
      }

      if (status !== 'zatwierdzone') {
        log(`[GPU-AI] Runda zakończona bez zatwierdzenia (${status}).`);
        return null;
      }

      // hCaptcha po zatwierdzeniu albo wystawia token, albo kolejna runde.
      await page.waitForTimeout(2500);
    }

    const finalToken = await page.evaluate(() => window.__capToken);
    if (finalToken) return finalToken;

    log(`[GPU-AI] Wyczerpano ${MAX_ROUNDS} rund bez tokenu.`);
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Ten blad nie pochodzi z captchy - ktos zamknal przegladarke pod mostkiem
    // (koniec biegu konta, Stop w panelu, przeladowanie strony Discorda).
    // Bez rozroznienia wyglada to na awarie rozwiazywania, czyli myli trop.
    if (/has been closed|Target closed|Browser closed|Execution context was destroyed/i.test(msg)) {
      log('[GPU-AI] Przeglądarka zamknięta w trakcie rozwiązywania CAPTCHA'
        + ' – to nie jest błąd wyzwania, tylko koniec sesji konta pod mostkiem.'
        + ` (${msg.slice(0, 120)})`);
    } else {
      log(`[GPU-AI] Mostek captchy przerwany: ${msg}`);
    }
    return null;
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

module.exports = { solveCaptcha, SOLVER_URL, CAPTCHA_VERSION };
