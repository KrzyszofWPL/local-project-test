const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { loadProxies } = require('./proxies.js');
const { playwrightProxy, closeAll: closeBridges } = require('./socks-bridge.js');
const { fingerprintFor, initScript } = require('./fingerprint.js');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const USE_PROXIES = process.env.USE_PROXIES !== 'false';
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
  if (!wpRequire?.c) return { fatal: 'wpRequire.c missing' };

  const mods = Object.values(wpRequire.c);
  const findExport = (pred, key) => {
    const m = mods.find(pred);
    return m ? m.exports[key] : null;
  };

  // ── 2. Discord stores ─────────────────────────────────────────────────────
  const QuestsStore = findExport(x => x?.exports?.A?.__proto__?.getQuest, 'A');
  if (!QuestsStore) return { fatal: 'QuestsStore not found' };

  const RunningGameStore = findExport(x => x?.exports?.Ay?.getRunningGames, 'Ay');
  const ApplicationStreamingStore = findExport(x => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata, 'A');
  const ChannelStore = findExport(x => x?.exports?.A?.__proto__?.getAllThreadsForParent, 'A');
  const GuildChannelStore = findExport(x => x?.exports?.Ay?.getSFWDefaultChannel, 'Ay');
  const FluxDispatcher = findExport(x => x?.exports?.h?.__proto__?.flushWaitQueue, 'h');
  const api = findExport(x => x?.exports?.Bo?.get, 'Bo');

  if (!api) return { fatal: 'api module not found' };
  log('Store: quests=' + !!QuestsStore + ' games=' + !!RunningGameStore +
      ' flux=' + !!FluxDispatcher + ' api=' + !!api);

  // Pretend to be the desktop app – unlocks PLAY/STREAM quests
  const isApp = typeof DiscordNative !== 'undefined';
  if (!isApp) {
    try {
      window.DiscordNative = window.DiscordNative || {
        process: { platform: 'win32' },
        app: { getModuleVersions: () => ({}) },
      };
    } catch(_) {}
  }

  // ── 3. Wait for the quest list ────────────────────────────────────────────
  for (let i = 0; i < 30 && QuestsStore.quests.size === 0; i++) await sleep(1000);
  log('QuestsStore: ' + QuestsStore.quests.size + ' quests in total');

  const SUPPORTED = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];

  const pending = [...QuestsStore.quests.values()].filter(q => {
    const tc = q.config?.taskConfig ?? q.config?.taskConfigV2;
    return !q.userStatus?.completedAt
        && new Date(q.config?.expiresAt).getTime() > Date.now()
        && tc?.tasks
        && SUPPORTED.some(t => t in tc.tasks);
  });
  log('Active and unfinished: ' + pending.length);

  // ── 4. Enroll – Discord expects a numeric location ────────────────────────
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
    // Last resort: no request body at all
    try {
      await api.post({ url: '/quests/' + quest.id + '/enroll', body: {} });
      return { ok: true, loc: 'empty' };
    } catch(e) {
      return { ok: false, err: lastErr ?? (e?.message ?? 'unknown') };
    }
  };

  // ── 5. Complete a single quest ────────────────────────────────────────────
  const results = [];

  const doQuest = async (quest) => {
    const name = quest.config?.messages?.questName ?? quest.id;
    const tc = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
    const taskName = SUPPORTED.find(t => tc.tasks[t] != null);
    const taskData = tc.tasks[taskName];
    const secondsNeeded = taskData.target;
    const applicationId = quest.config?.application?.id ?? taskData.applications?.[0]?.id;
    let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    // Enroll first if this account is not enrolled yet
    if (!quest.userStatus?.enrolledAt) {
      const e = await enroll(quest);
      if (!e.ok) { results.push({ name, taskName, error: 'enroll: ' + e.err }); return; }
      log('Enrolled: ' + name + ' (location=' + e.loc + ')');
      await sleep(500);
    }

    // ── WATCH_VIDEO: fake the timestamp, ~7x faster than real time ─────────
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

    // ── PLAY_ACTIVITY: heartbeat carrying a voice channel key ──────────────
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
      if (!channelId) { results.push({ name, taskName, error: 'no voice channel available' }); return; }

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

    // ── PLAY_ON_DESKTOP: impersonate a running game ────────────────────────
    if (taskName === 'PLAY_ON_DESKTOP') {
      if (!RunningGameStore || !FluxDispatcher) {
        results.push({ name, taskName, error: 'RunningGameStore/FluxDispatcher missing' }); return;
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
        // If the client sends no heartbeats (browser), give up after 3 min
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
      else results.push({ name, taskName, error: 'no progress – the browser does not send PLAY_ON_DESKTOP heartbeats' });
      return;
    }

    // ── STREAM_ON_DESKTOP: needs a live stream in a voice channel ──────────
    if (taskName === 'STREAM_ON_DESKTOP') {
      results.push({ name, taskName, error: 'skipped – needs a stream in a voice channel with someone else' });
      return;
    }
  };

  // ── 6. Run them one after another ─────────────────────────────────────────
  for (const quest of pending) {
    try { await doQuest(quest); }
    catch(e) {
      const name = quest.config?.messages?.questName ?? quest.id;
      results.push({ name, error: e?.body?.message ?? e?.message ?? String(e) });
    }
  }

  return { results, logs };
})()`;
// ─────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────
async function processToken(browser, token, index, total, proxy) {
  const tag = `[${String(index + 1).padStart(2)}/${total}] ${token.substring(0, 12)}...`;
  const log = (...a) => console.log(tag, ...a);

  log('→ opening context' + (proxy ? ' via ' + proxy.label : ''));
  const fp = fingerprintFor(token);
  const context = await browser.newContext({
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    viewport: fp.viewport,
    screen: fp.screen,
    deviceScaleFactor: fp.deviceScaleFactor,
    proxy: await playwrightProxy(proxy),
  });
  try { await context.addInitScript(initScript(fp)); } catch (_) {}

  const page = await context.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));

  try {
    page.setDefaultTimeout(0);
    if (proxy) {
      try {
        const res = await context.request.get('https://api.ipify.org?format=json',
          { timeout: 20000 });
        log('→ exit IP ' + (await res.json()).ip);
      } catch (e) {
        log('✗ proxy ' + proxy.label + ' is not reachable:', e.message.split('\n')[0]);
        return;
      }
    }
    await page.goto('https://discord.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.evaluate(tk => {
      let ls = window.localStorage;
      if (!ls) {
        const iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        ls = iframe.contentWindow.localStorage;
      }
      ls.setItem('token', JSON.stringify(tk));
    }, token.trim());

    log('→ token injected, loading Discord…');

    await page.goto('https://discord.com/channels/@me', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForFunction(() => !!window.webpackChunkdiscord_app, {
      timeout: 60000
    });


    await page.waitForTimeout(12000);

    log('→ Discord loaded, running the quest script…');

    const result = await page.evaluate(INJECT_SCRIPT);

    if (!result) {
      log('⚠ No response (probably redirected to login – bad or expired token)');
      return;
    }

    if (result.fatal) {
      log('✗ Fatal error:', result.fatal);
      if (result.debug) {
        log('  [Debug] modules:', result.debug.modules,
            '| stores:', result.debug.storesFound);
        if (result.debug.questRelated?.length)
          log('  [Debug] quest-related:', result.debug.questRelated.join(', '));
        if (result.debug.sample?.length)
          log('  [Debug] samples:', result.debug.sample.join(', '));
      }
      return;
    }

    for (const l of (result.logs ?? [])) log(' ·', l);

    if (!result.results?.length) {
      log('— no active quests');
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
    log('✗ Exception:', e.message);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error('[!] tokens.txt is missing'); process.exit(1);
  }

  const tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
    .split('\n').map(t => t.trim()).filter(Boolean);

  if (!tokens.length) {
    console.error('[!] tokens.txt is empty'); process.exit(1);
  }

  const proxyList = USE_PROXIES ? loadProxies().proxies : [];
  const proxyFor = i => proxyList.length ? proxyList[i % proxyList.length] : null;

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      Discord Quest Bot  –  Playwright edition    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Accounts to process : ${tokens.length}`);
  console.log(`Parallel contexts   : ${CONCURRENCY}`);
  console.log(`Estimated RAM       : ~${CONCURRENCY * 350} MB`);
  console.log(`Proxies (ip.txt)    : ${proxyList.length || 'none – every account uses your own IP'}`);
  if (proxyList.length && tokens.length > proxyList.length) {
    console.log('                      note: fewer proxies than accounts, some will share an IP');
  }
  console.log('');

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyList.length ? { server: 'http://per-context' } : undefined,
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
      // Without these WebRTC opens UDP sockets outside the proxy and leaks the
      // machine's real IP while every request goes through the proxy.
      ...(proxyList.length ? [
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ] : []),
    ]
  });

  console.log('Browser started. Processing accounts…\n');

  try {
    await runPool(tokens, CONCURRENCY, (token, i) =>
      processToken(browser, token, i, tokens.length, proxyFor(i))
    );
  } finally {
    await browser.close();
    await closeBridges().catch(() => {});
  }

  console.log('\n[DONE] All accounts processed.');
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
