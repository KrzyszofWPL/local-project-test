/**
 * Discord Quest Automation – Playwright browser injection
 *
 * Uruchomienie:
 *   node browser.js                        (domyślnie 5 równoległych kont)
 *   set CONCURRENCY=20 && node browser.js  (Windows – 20 równoległych)
 *   CONCURRENCY=20 node browser.js         (Linux/Mac)
 *
 * Wskazówki dotyczące równoległości (CONCURRENCY):
 *   Każdy otwarty kontekst Discord zużywa ~200-400 MB RAM.
 *   CONCURRENCY=5   →  ~1-2 GB RAM   (bezpieczne na każdym PC)
 *   CONCURRENCY=10  →  ~2-4 GB RAM
 *   CONCURRENCY=20  →  ~4-8 GB RAM
 *   CONCURRENCY=50  →  ~10-20 GB RAM (tylko jeśli masz dużo RAMu i szybki CPU)
 *
 * Czas ukończenia questów:
 *   Questy WATCH_VIDEO          → kilkanaście sekund (fałszujemy timestamp)
 *   Questy PLAY_ON_DESKTOP itp. → ~15+ minut (wymagają heartbeatów co 20s)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Skrypt wstrzykiwany do strony Discord (uruchamia się wewnątrz przeglądarki).
// Ma dostęp do webpack i QuestsStore – tak jak skrypty aamiaa/Ghraven.
// ─────────────────────────────────────────────────────────────────────────────
const INJECT_SCRIPT = /* javascript */ `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const logs  = [];
  const log   = msg => { logs.push(msg); };

  // ── 1. Czekaj na webpack Discord ──────────────────────────────────────────
  for (let i = 0; i < 120 && !window.webpackChunkdiscord_app; i++) await sleep(500);
  if (!window.webpackChunkdiscord_app) return { fatal: 'webpack timeout (60s)' };

  // ── 2. Uzyskaj funkcję require() webpacka ─────────────────────────────────
  let wpRequire;
  try {
    webpackChunkdiscord_app.push([[Symbol()], {}, r => { wpRequire = r; }]);
    webpackChunkdiscord_app.pop();
  } catch(e) { return { fatal: 'wpRequire: ' + e.message }; }
  if (!wpRequire?.c) return { fatal: 'wpRequire.c brak' };

  // ── 3. Znajdź QuestsStore przez duck-typing ───────────────────────────────
  let QuestsStore = null;
  for (const mod of Object.values(wpRequire.c)) {
    try {
      const exp = mod?.exports;
      if (!exp) continue;
      const candidates = [exp, exp.default, ...Object.values(exp)];
      for (const v of candidates) {
        if (v?.getQuest && v?.quests instanceof Map) { QuestsStore = v; break; }
      }
    } catch(_) {}
    if (QuestsStore) break;
  }
  if (!QuestsStore) return { fatal: 'QuestsStore nie znaleziono' };

  // ── 4. Poczekaj aż Discord pobierze questy ze swojego backendu (maks 30s) ─
  for (let i = 0; i < 30 && QuestsStore.quests.size === 0; i++) await sleep(1000);
  log('QuestsStore: ' + QuestsStore.quests.size + ' questów ogółem');

  // ── 5. Token z localStorage → do bezpośrednich wywołań fetch() ───────────
  // Discord usuwa window.localStorage – odzyskaj przez iframe
  let ls = window.localStorage;
  if (!ls) {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    ls = iframe.contentWindow.localStorage;
  }
  const raw = ls.getItem('token');
  const token = raw ? (raw.startsWith('"') ? JSON.parse(raw) : raw) : null;
  if (!token) return { fatal: 'Brak tokena w localStorage (przekierowanie na login?)' };

  const api = async (method, url, body) => {
    const res = await fetch('/api/v9' + url, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    // Obsłuż rate limit
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = (data.retry_after ?? 5) * 1000;
      await sleep(wait);
      return api(method, url, body); // jeden retry
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.headers.get('content-type')?.includes('json') ? res.json() : null;
  };

  // ── 6. Filtruj aktywne, obsługiwane questy ────────────────────────────────
  const SUPPORTED = [
    'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE',
    'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY'
  ];

  const allQuests = [...QuestsStore.quests.values()];
  const now = Date.now();
  const pending = allQuests.filter(q => {
    const tc = q.config?.taskConfig ?? q.config?.taskConfigV2;
    return !q.userStatus?.completedAt
        && new Date(q.config?.expiresAt).getTime() > now
        && tc?.tasks
        && SUPPORTED.some(t => t in tc.tasks);
  });
  log('Aktywnych do ukończenia: ' + pending.length);

  // ── 7. Dla każdego questa: zapisz się (jeśli trzeba) i ukończ ─────────────
  const results = [];

  for (const quest of pending) {
    const name    = quest.config?.messages?.questName ?? quest.id;
    const tc      = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
    const taskName = Object.keys(tc.tasks).find(t => SUPPORTED.includes(t));
    if (!taskName) continue;

    const taskData = tc.tasks[taskName];
    const target   = taskData.target;
    let done       = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    // Auto-zapis do questa
    if (!quest.userStatus?.enrolledAt) {
      try {
        await api('POST', '/quests/' + quest.id + '/enroll', { location: 'QUESTS_TAB' });
        log('Zapisano: ' + name);
      } catch(e) {
        results.push({ name, error: 'enroll: ' + e.message });
        continue;
      }
    }

    try {
      if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
        // ── Typ VIDEO: fałszujemy timestamp – ukończenie w kilka sekund ──────
        while (done < target) {
          const next = Math.min(done + 15, target);
          await sleep(350);
          const r = await api('POST', '/quests/' + quest.id + '/video-progress', { timestamp: next });
          done = r?.userStatus?.progress?.[taskName]?.value ?? next;
        }
      } else {
        // ── Typ PLAY/STREAM: heartbeat co 20s, wymagane ~15 min łącznie ──────
        // Wyślij Presence Update przez API (informujemy Discord że gramy)
        await api('PATCH', '/users/@me/settings', {}).catch(() => {});

        while (done < target) {
          await sleep(20000);
          const terminal = (done + 20 >= target);
          const r = await api('POST', '/quests/' + quest.id + '/heartbeat', {
            stream_key: 'call:0:1',
            terminal
          });
          done = r?.userStatus?.progress?.[taskName]?.value ?? (done + 20);
          log(name + ': ' + Math.min(done, target) + '/' + target + 's');
          if (terminal) break;
        }
      }

      results.push({ name, completed: true, taskName, done: Math.min(done, target), target });
    } catch(e) {
      results.push({ name, error: e.message, done, target });
    }
  }

  return { results, logs };
})()`;

// ─────────────────────────────────────────────────────────────────────────────
// Prosta pula współbieżności (bez zewnętrznych zależności)
// ─────────────────────────────────────────────────────────────────────────────
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i).catch(e => ({ fatalError: e.message }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Obsługa jednego konta Discord
// ─────────────────────────────────────────────────────────────────────────────
async function processToken(browser, token, index, total) {
  const tag = `[${String(index + 1).padStart(2)}/${total}] ${token.substring(0, 12)}...`;
  const log = (...a) => console.log(tag, ...a);

  log('→ otwieranie kontekstu');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1280, height: 800 },
  });

  // Wycisz dialogi (np. powiadomienia Discorda)
  const page = await context.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));

  try {
    // Krok 1: Wejdź na stronę logowania – ustawiamy właściwą domenę dla localStorage
    await page.goto('https://discord.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Krok 2: Wstrzyknij token do localStorage
    // Discord usuwa window.localStorage – odzyskujemy go przez iframe
    await page.evaluate(tk => {
      let ls = window.localStorage;
      if (!ls) {
        const iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        ls = iframe.contentWindow.localStorage;
      }
      ls.setItem('token', JSON.stringify(tk));
    }, token.trim());

    log('→ token wstrzyknięty, ładowanie Discord...');

    // Krok 3: Przejdź do aplikacji – Discord odczyta token i zaloguje się
    await page.goto('https://discord.com/channels/@me', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Krok 4: Czekaj na załadowanie webpacka
    await page.waitForFunction(() => !!window.webpackChunkdiscord_app, {
      timeout: 60000
    });

    // Krok 5: Poczekaj na załadowanie danych sesji + QuestsStore (~10-15s)
    await page.waitForTimeout(12000);

    log('→ Discord załadowany, uruchamianie skryptu questów...');

    // Krok 6: Wstrzyknij skrypt i odbierz wyniki
    const result = await page.evaluate(INJECT_SCRIPT);

    if (!result) {
      log('⚠ Brak odpowiedzi (prawdopodobnie przekierowanie na login – zły/wygasły token)');
      return;
    }

    if (result.fatal) {
      log('✗ Błąd krytyczny:', result.fatal);
      return;
    }

    // Wyświetl logi wewnętrzne skryptu
    for (const l of (result.logs ?? [])) log(' ·', l);

    if (!result.results?.length) {
      log('— brak aktywnych questów');
    } else {
      for (const r of result.results) {
        if (r.completed) {
          const icon = r.taskName?.includes('VIDEO') ? '🎬' : '🎮';
          log(`✓ ${icon} ${r.name} (${r.done}/${r.target}s)`);
        } else {
          log(`✗ ${r.name}: ${r.error}`);
        }
      }
    }

  } catch(e) {
    log('✗ Wyjątek:', e.message);
  } finally {
    await context.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error('[!] Brak pliku tokens.txt'); process.exit(1);
  }

  const tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
    .split('\n').map(t => t.trim()).filter(Boolean);

  if (!tokens.length) {
    console.error('[!] tokens.txt jest pusty'); process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      Discord Quest Bot  –  Playwright edition    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Kont do przetworzenia : ${tokens.length}`);
  console.log(`Równoległość          : ${CONCURRENCY}`);
  console.log(`Szacowany RAM         : ~${CONCURRENCY * 350} MB\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ]
  });

  console.log('Przeglądarka uruchomiona. Procesowanie kont...\n');

  try {
    await runPool(tokens, CONCURRENCY, (token, i) =>
      processToken(browser, token, i, tokens.length)
    );
  } finally {
    await browser.close();
  }

  console.log('\n[DONE] Wszystkie konta przetworzone.');
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
