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

const SOLVER_URL = process.env.SOLVER_URL || 'http://127.0.0.1:5000/analyze-captcha';
const CAPTCHA_URL = 'https://discord.com/__quest_captcha';
const MAX_ROUNDS = parseInt(process.env.CAPTCHA_ROUNDS || '4', 10);
const FRAME_WAIT_MS = parseInt(process.env.CAPTCHA_FRAME_WAIT || '30000', 10);
const MAX_REROLLS = parseInt(process.env.CAPTCHA_REROLLS || '3', 10);

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
<script src="https://js.hcaptcha.com/1/api.js?render=explicit&onload=onHcLoad" async defer></script>
</body></html>`;
}

// Ramka z wyzwaniem (siatka obrazkow) - hCaptcha trzyma osobna ramke na
// checkbox i osobna na samo wyzwanie. Interesuje nas ta druga.
// Klasy w ramce hCaptcha bywaja zmieniane, wiec nie opieramy sie na jednej.
const TILE_SELECTORS = '.task-image, .image-wrapper, [class*="task-image"], [class*="challenge"] .image';
const PROMPT_SELECTORS = '.prompt-text, [class*="prompt-text"], .challenge-prompt';

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

// Gdy ramka wyzwania sie nie znajduje, jedyne co pomaga to zobaczyc, co
// naprawde jest na stronie: lista ramek z liczba elementow kandydatow oraz
// zrzut ekranu na dysk.
async function dumpState(page, log, tag) {
  const frames = page.frames();
  log(`[GPU-AI] Diagnostyka (${tag}): ramek=${frames.length}`);
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
    await page.screenshot({ path: file, fullPage: true });
    log(`[GPU-AI] Zrzut ekranu: ${file}`);
  } catch (e) {
    log(`[GPU-AI] Nie udało się zrobić zrzutu: ${(e && e.message) || e}`);
  }
}

async function askSolver(tiles, prompt, log) {
  const res = await fetch(SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiles, target_object: prompt, grid: '3x3' }),
    signal: AbortSignal.timeout(60000),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    log(`[GPU-AI] Solver zwrócił HTTP ${res.status}: `
      + (data && data.detail ? JSON.stringify(data.detail).slice(0, 200) : '?'));
    return null;
  }
  if (!data || !data.success) {
    // Swiadoma odmowa solvera (nieznane zadanie) - nie klikamy na oslep.
    log(`[GPU-AI] Solver odmówił: ${(data && (data.reason || data.detail)) || 'brak odpowiedzi'}`
      + (data && data.detail ? ` – ${data.detail}` : ''));
    return null;
  }
  return Array.isArray(data.click_indices) ? data.click_indices : [];
}

// hCaptcha wystawia rozne typy wyzwan. Solver oparty o detekcje obiektow
// (YOLO/COCO) potrafi obsluzyc WYLACZNIE siatke obrazkow - reszta to zupelnie
// inne zadania (przeciaganie elementow, geometria, rozpoznawanie ksztaltow),
// dla ktorych detektor obiektow nie ma zadnego zastosowania.
function classifyChallenge(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (/\bdrag\b|przeciągnij|przeciagnij|\bslide\b|\bmove the\b/.test(p)) return 'drag';
  if (/\brotate\b|obróć|obroc/.test(p)) return 'rotate';
  if (/click each image|select all|zaznacz|kliknij.*obraz|containing a/.test(p)) return 'grid';
  return 'nieznany';
}

// Nowe wyzwanie zamiast obecnego - hCaptcha losuje typ, wiec przy zadaniu
// spoza mozliwosci solvera warto sprobowac wylosowac siatke obrazkow.
async function reroll(frame, log) {
  const btn = frame.locator(
    '.refresh, .button-refresh, [aria-label*="new challenge" i], [title*="new challenge" i]'
  ).first();
  try {
    if (!(await btn.count())) {
      log('[GPU-AI] Brak przycisku losowania nowego wyzwania.');
      return false;
    }
    await btn.click({ timeout: 5000 });
    await frame.page().waitForTimeout(2000);
    return true;
  } catch (e) {
    log(`[GPU-AI] Nie udało się wylosować nowego wyzwania: ${(e && e.message) || e}`);
    return false;
  }
}

// Jedna runda wyzwania: przeczytaj polecenie, zrzuc kafelki, zapytaj solver,
// klikaj, zatwierdz. Zwraca kod statusu opisujacy, co sie stalo.
async function playRound(frame, log, page) {
  let prompt = '';
  try {
    prompt = (await frame.locator(PROMPT_SELECTORS).first().innerText({ timeout: 8000 })).trim();
  } catch (_) {
    log('[GPU-AI] Nie udało się odczytać treści zadania z ramki.');
    return 'brak-polecenia';
  }

  const kind = classifyChallenge(prompt);
  log(`[GPU-AI] Zadanie [${kind}]: "${prompt}"`);

  const tileLoc = frame.locator(TILE_SELECTORS);
  const count = await tileLoc.count();

  if (!count) {
    if (kind !== 'grid') {
      log(`[GPU-AI] To wyzwanie typu "${kind}" - solver oparty o detekcję obiektów`
        + ' nie ma jak go rozwiązać (brak siatki obrazków).');
    } else {
      log('[GPU-AI] Polecenie wygląda na siatkę, ale nie znalazłem kafelków.');
    }
    if (page) await dumpState(page, log, 'brak-kafelkow');
    return 'brak-kafelkow';
  }

  if (kind !== 'grid') {
    log(`[GPU-AI] Kafelki są, ale polecenie nie wygląda na wybór obrazków`
      + ' - próbuję mimo to.');
  }

  const tiles = [];
  for (let i = 0; i < count; i++) {
    const shot = await tileLoc.nth(i).screenshot({ timeout: 10000 });
    tiles.push('data:image/png;base64,' + shot.toString('base64'));
  }
  log(`[GPU-AI] Zrzucono ${tiles.length} kafelków, wysyłam do GPU...`);

  const picks = await askSolver(tiles, prompt, log);
  if (picks === null) return 'solver-odmowil';

  log(`[GPU-AI] GPU wytypowało kafelki: [${picks.join(', ')}]`);
  for (const idx of picks) {
    if (idx < 0 || idx >= count) continue;
    await tileLoc.nth(idx).click({ timeout: 5000 }).catch(() => {});
    await frame.page().waitForTimeout(250 + Math.random() * 250);
  }

  const submit = frame.locator('.button-submit, .verify-button').first();
  if (!(await submit.count())) {
    log('[GPU-AI] Nie znaleziono przycisku zatwierdzenia.');
    return 'brak-zatwierdzenia';
  }
  await submit.click({ timeout: 5000 });
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

    // Ta sama domena co prawdziwy klient - hCaptcha wiaze wyzwanie z hostem.
    await page.route(CAPTCHA_URL, route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: pageHtml(challenge.sitekey, challenge.rqdata || null),
    }));

    log(`[GPU-AI] Otwieram wyzwanie (sitekey ${String(challenge.sitekey).slice(0, 8)}…`
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

      log(`[GPU-AI] Runda ${round}/${MAX_ROUNDS}`);
      const status = await playRound(frame, log, page);

      if (status === 'brak-kafelkow' && rerolls < MAX_REROLLS) {
        rerolls++;
        log(`[GPU-AI] Losuję inne wyzwanie (${rerolls}/${MAX_REROLLS})...`);
        if (await reroll(frame, log)) continue;
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
    log(`[GPU-AI] Mostek captchy przerwany: ${(e && e.message) || e}`);
    return null;
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

module.exports = { solveCaptcha, SOLVER_URL };
