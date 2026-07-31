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
// ─────────────────────────────────────────────────────────────────────────────
// Skrypt wstrzykiwany do strony Discord. Wzorowany na skrypcie aamiaa –
// używa prawdziwych store'ów Discorda i FluxDispatchera zamiast surowych
// heartbeatów, dzięki czemu klient sam raportuje postęp do backendu.
// ─────────────────────────────────────────────────────────────────────────────
const INJECT_SCRIPT = /* javascript */ `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const logs  = [];
  const log   = m => { logs.push(String(m)); };

  // ── 1. Webpack ────────────────────────────────────────────────────────────
  for (let i = 0; i < 120 && !window.webpackChunkdiscord_app; i++) await sleep(500);
  if (!window.webpackChunkdiscord_app) return { fatal: 'webpack timeout (60s)' };

  let wpRequire;
  try {
    delete window.$;
    wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
    webpackChunkdiscord_app.pop();
  } catch(e) { return { fatal: 'wpRequire: ' + e.message }; }
  if (!wpRequire?.c) return { fatal: 'wpRequire.c brak' };

  const mods = Object.values(wpRequire.c);
  const findExport = (pred, key) => {
    const m = mods.find(pred);
    return m ? m.exports[key] : null;
  };

  // ── 2. Store'y Discorda ───────────────────────────────────────────────────
  const QuestsStore = findExport(x => x?.exports?.A?.__proto__?.getQuest, 'A');
  if (!QuestsStore) return { fatal: 'QuestsStore nie znaleziono' };

  const RunningGameStore = findExport(x => x?.exports?.Ay?.getRunningGames, 'Ay');
  const ApplicationStreamingStore = findExport(x => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata, 'A');
  const ChannelStore = findExport(x => x?.exports?.A?.__proto__?.getAllThreadsForParent, 'A');
  const GuildChannelStore = findExport(x => x?.exports?.Ay?.getSFWDefaultChannel, 'Ay');
  const FluxDispatcher = findExport(x => x?.exports?.h?.__proto__?.flushWaitQueue, 'h');
  const api = findExport(x => x?.exports?.Bo?.get, 'Bo');

  if (!api) return { fatal: 'moduł api nie znaleziony' };
  log('Store: quests=' + !!QuestsStore + ' games=' + !!RunningGameStore +
      ' flux=' + !!FluxDispatcher + ' api=' + !!api);

  // Udawaj aplikację desktopową – odblokowuje questy PLAY/STREAM
  const isApp = typeof DiscordNative !== 'undefined';
  if (!isApp) {
    try {
      window.DiscordNative = window.DiscordNative || {
        process: { platform: 'win32' },
        app: { getModuleVersions: () => ({}) },
      };
    } catch(_) {}
  }

  // ── 3. Poczekaj na questy ─────────────────────────────────────────────────
  for (let i = 0; i < 30 && QuestsStore.quests.size === 0; i++) await sleep(1000);
  log('QuestsStore: ' + QuestsStore.quests.size + ' questów ogółem');

  const SUPPORTED = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];

  const pending = [...QuestsStore.quests.values()].filter(q => {
    const tc = q.config?.taskConfig ?? q.config?.taskConfigV2;
    return !q.userStatus?.completedAt
        && new Date(q.config?.expiresAt).getTime() > Date.now()
        && tc?.tasks
        && SUPPORTED.some(t => t in tc.tasks);
  });
  log('Aktywnych do ukończenia: ' + pending.length);

  // ── 4. Zapis do questa – Discord oczekuje numerycznego location ───────────
  const enroll = async (quest) => {
    const locations = [11, 10, 8, 4, 2, 1, 0];
    let lastErr = null;
    for (const loc of locations) {
      try {
        await api.post({ url: '/quests/' + quest.id + '/enroll', body: { location: loc } });
        return { ok: true, loc };
      } catch(e) {
        lastErr = e?.body?.message ?? e?.message ?? ('HTTP ' + e?.status);
      }
    }
    // Ostatnia próba: bez ciała żądania
    try {
      await api.post({ url: '/quests/' + quest.id + '/enroll', body: {} });
      return { ok: true, loc: 'empty' };
    } catch(e) {
      return { ok: false, err: lastErr ?? (e?.message ?? 'unknown') };
    }
  };

  // ── 5. Ukończ pojedynczy quest ────────────────────────────────────────────
  const results = [];

  const doQuest = async (quest) => {
    const name = quest.config?.messages?.questName ?? quest.id;
    const tc = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
    const taskName = SUPPORTED.find(t => tc.tasks[t] != null);
    const taskData = tc.tasks[taskName];
    const secondsNeeded = taskData.target;
    const applicationId = quest.config?.application?.id ?? taskData.applications?.[0]?.id;
    let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    // Zapis jeśli jeszcze niezapisany
    if (!quest.userStatus?.enrolledAt) {
      const e = await enroll(quest);
      if (!e.ok) { results.push({ name, taskName, error: 'enroll: ' + e.err }); return; }
      log('Zapisano: ' + name + ' (location=' + e.loc + ')');
      await sleep(500);
    }

    // ── WATCH_VIDEO: fałszujemy timestamp, ~7x szybciej niż realny czas ─────
    if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
      const speed = 7;
      let completed = false;
      while (true) {
        const remaining = Math.min(speed, secondsNeeded - secondsDone);
        await sleep(remaining * 1000);
        const timestamp = secondsDone + speed;
        const res = await api.post({
          url: '/quests/' + quest.id + '/video-progress',
          body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
        });
        completed = res.body?.completed_at != null;
        secondsDone = Math.min(secondsNeeded, timestamp);
        if (timestamp >= secondsNeeded) break;
      }
      if (!completed) {
        await api.post({ url: '/quests/' + quest.id + '/video-progress', body: { timestamp: secondsNeeded } });
      }
      results.push({ name, taskName, completed: true, done: secondsNeeded, target: secondsNeeded });
      return;
    }

    // ── PLAY_ACTIVITY: heartbeat z kluczem kanału głosowego ────────────────
    if (taskName === 'PLAY_ACTIVITY') {
      let channelId = null;
      try {
        channelId = ChannelStore?.getSortedPrivateChannels?.()[0]?.id;
        if (!channelId && GuildChannelStore) {
          const g = Object.values(GuildChannelStore.getAllGuilds())
            .find(x => x != null && x.VOCAL?.length > 0);
          channelId = g?.VOCAL?.[0]?.channel?.id;
        }
      } catch(_) {}
      if (!channelId) { results.push({ name, taskName, error: 'brak kanału głosowego' }); return; }

      const streamKey = 'call:' + channelId + ':1';
      while (true) {
        const res = await api.post({
          url: '/quests/' + quest.id + '/heartbeat',
          body: { stream_key: streamKey, terminal: false }
        });
        const progress = res.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
        secondsDone = progress;
        if (progress >= secondsNeeded) {
          await api.post({
            url: '/quests/' + quest.id + '/heartbeat',
            body: { stream_key: streamKey, terminal: true }
          });
          break;
        }
        await sleep(20000);
      }
      results.push({ name, taskName, completed: true, done: secondsNeeded, target: secondsNeeded });
      return;
    }

    // ── PLAY_ON_DESKTOP: podszywamy się pod uruchomioną grę ────────────────
    if (taskName === 'PLAY_ON_DESKTOP') {
      if (!RunningGameStore || !FluxDispatcher) {
        results.push({ name, taskName, error: 'brak RunningGameStore/FluxDispatcher' }); return;
      }
      const pid = Math.floor(Math.random() * 30000) + 1000;
      const res = await api.get({ url: '/applications/public?application_ids=' + applicationId });
      const appData = res.body[0];
      const exeName = appData.executables?.find(x => x.os === 'win32')?.name?.replace('>','')
                   ?? appData.name.replace(/[\\/\\\\:*?"<>|]/g, '');

      const fakeGame = {
        cmdLine: 'C:\\\\Program Files\\\\' + appData.name + '\\\\' + exeName,
        exeName,
        exePath: 'c:/program files/' + appData.name.toLowerCase() + '/' + exeName,
        hidden: false, isLauncher: false, id: applicationId, name: appData.name,
        pid, pidPath: [pid], processName: appData.name, start: Date.now(),
      };
      const realGames = RunningGameStore.getRunningGames();
      const fakeGames = [fakeGame];
      const realGetRunningGames = RunningGameStore.getRunningGames;
      const realGetGameForPID = RunningGameStore.getGameForPID;
      RunningGameStore.getRunningGames = () => fakeGames;
      RunningGameStore.getGameForPID = p => fakeGames.find(x => x.pid === p);
      FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: realGames, added: [fakeGame], games: fakeGames });

      const restore = () => {
        RunningGameStore.getRunningGames = realGetRunningGames;
        RunningGameStore.getGameForPID = realGetGameForPID;
        FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: [fakeGame], added: [], games: [] });
      };

      const ok = await new Promise(resolve => {
        let lastProgress = secondsDone;
        let stalled = 0;
        const fn = data => {
          const p = quest.config.configVersion === 1
            ? data.userStatus.streamProgressSeconds
            : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);
          lastProgress = p;
          if (p >= secondsNeeded) {
            FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', fn);
            clearInterval(watchdog);
            resolve(true);
          }
        };
        FluxDispatcher.subscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', fn);
        // Jeśli klient nie wysyła heartbeatów (przeglądarka), przerwij po 3 min
        const watchdog = setInterval(() => {
          stalled += 30;
          if (lastProgress === secondsDone && stalled >= 180) {
            FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', fn);
            clearInterval(watchdog);
            resolve(false);
          }
        }, 30000);
      });

      restore();
      if (ok) results.push({ name, taskName, completed: true, done: secondsNeeded, target: secondsNeeded });
      else results.push({ name, taskName, error: 'brak postępu – przeglądarka nie wysyła heartbeatów dla PLAY_ON_DESKTOP' });
      return;
    }

    // ── STREAM_ON_DESKTOP: wymaga aktywnego streamu na kanale głosowym ─────
    if (taskName === 'STREAM_ON_DESKTOP') {
      results.push({ name, taskName, error: 'pominięto – wymaga streamu na kanale głosowym z inną osobą' });
      return;
    }
  };

  // ── 6. Wykonaj sekwencyjnie ───────────────────────────────────────────────
  for (const quest of pending) {
    try { await doQuest(quest); }
    catch(e) {
      const name = quest.config?.messages?.questName ?? quest.id;
      results.push({ name, error: e?.body?.message ?? e?.message ?? String(e) });
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
    // Questy PLAY_ACTIVITY trwają kilkanaście minut – zdejmij domyślne limity
    page.setDefaultTimeout(0);

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
      if (result.debug) {
        log('  [Debug] modułów:', result.debug.modules,
            '| store\'ów:', result.debug.storesFound);
        if (result.debug.questRelated?.length)
          log('  [Debug] quest-related:', result.debug.questRelated.join(', '));
        if (result.debug.sample?.length)
          log('  [Debug] przykłady:', result.debug.sample.join(', '));
      }
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
