'use strict';

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
      var opts = {};
      ${rqdata ? `opts.rqdata = ${JSON.stringify(rqdata)};` : ''}
      hcaptcha.execute(id, opts);
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
async function challengeFrame(page) {
  for (const frame of page.frames()) {
    const url = frame.url() || '';
    if (url.indexOf('hcaptcha.com') === -1) continue;
    if (url.indexOf('/challenge') === -1 && url.indexOf('hcaptcha-challenge') === -1) continue;
    try {
      if (await frame.locator('.challenge-view, .task-image').first().count()) return frame;
    } catch (_) {}
  }
  // Zapasowo: dowolna ramka hCaptcha, ktora ma kafelki.
  for (const frame of page.frames()) {
    if ((frame.url() || '').indexOf('hcaptcha.com') === -1) continue;
    try {
      if (await frame.locator('.task-image').first().count()) return frame;
    } catch (_) {}
  }
  return null;
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

// Jedna runda wyzwania: przeczytaj polecenie, zrzuc kafelki, zapytaj solver,
// klikaj, zatwierdz. Zwraca true, jesli udalo sie cokolwiek zatwierdzic.
async function playRound(frame, log) {
  let prompt = '';
  try {
    prompt = (await frame.locator('.prompt-text').first().innerText({ timeout: 5000 })).trim();
  } catch (_) {
    log('[GPU-AI] Nie udało się odczytać treści zadania z ramki.');
    return false;
  }
  log(`[GPU-AI] Zadanie: "${prompt}"`);

  const tileLoc = frame.locator('.task-image');
  const count = await tileLoc.count();
  if (!count) {
    log('[GPU-AI] Brak kafelków w ramce wyzwania.');
    return false;
  }

  const tiles = [];
  for (let i = 0; i < count; i++) {
    const shot = await tileLoc.nth(i).screenshot({ timeout: 10000 });
    tiles.push('data:image/png;base64,' + shot.toString('base64'));
  }
  log(`[GPU-AI] Zrzucono ${tiles.length} kafelków, wysyłam do GPU...`);

  const picks = await askSolver(tiles, prompt, log);
  if (picks === null) return false;

  log(`[GPU-AI] GPU wytypowało kafelki: [${picks.join(', ')}]`);
  for (const idx of picks) {
    if (idx < 0 || idx >= count) continue;
    await tileLoc.nth(idx).click({ timeout: 5000 }).catch(() => {});
    await frame.page().waitForTimeout(250 + Math.random() * 250);
  }

  const submit = frame.locator('.button-submit, .verify-button').first();
  if (!(await submit.count())) {
    log('[GPU-AI] Nie znaleziono przycisku zatwierdzenia.');
    return false;
  }
  await submit.click({ timeout: 5000 });
  return true;
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

      let frame = null;
      for (let i = 0; i < 20 && !frame; i++) {
        frame = await challengeFrame(page);
        if (!frame) await page.waitForTimeout(500);
      }
      if (!frame) {
        log('[GPU-AI] Ramka wyzwania nie pojawiła się.');
        return null;
      }

      log(`[GPU-AI] Runda ${round}/${MAX_ROUNDS}`);
      const played = await playRound(frame, log);
      if (!played) return null;

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
