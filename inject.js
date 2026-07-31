/**
 * Skrypt wstrzykiwany do strony Discord.
 *
 * Raportuje postęp na żywo przez window.__questReport (wystawiane z Node
 * przez page.exposeFunction), dzięki czemu panel widzi stan w czasie
 * rzeczywistym, a nie dopiero po zakończeniu.
 *
 * UWAGA: wewnątrz tego stringa nie wolno używać backticków ani ${...}.
 */
module.exports = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const R = (o) => { try { window.__questReport(o); } catch(_) {} };
  const log = m => R({ t: 'log', m: String(m) });

  // ── 1. Webpack ────────────────────────────────────────────────────────────
  for (let i = 0; i < 120 && !window.webpackChunkdiscord_app; i++) await sleep(500);
  if (!window.webpackChunkdiscord_app) return { fatal: 'webpack timeout (60s)' };

  let wpRequire;
  try {
    delete window.$;
    wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
    webpackChunkdiscord_app.pop();
  } catch(e) { return { fatal: 'wpRequire: ' + e.message }; }
  if (!wpRequire || !wpRequire.c) return { fatal: 'wpRequire.c brak' };

  const mods = Object.values(wpRequire.c);
  const findExport = (pred, key) => {
    const m = mods.find(pred);
    return m ? m.exports[key] : null;
  };

  // ── 2. Store'y Discorda ───────────────────────────────────────────────────
  const QuestsStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getQuest, 'A');
  if (!QuestsStore) return { fatal: 'QuestsStore nie znaleziono' };

  const RunningGameStore = findExport(x => x && x.exports && x.exports.Ay && x.exports.Ay.getRunningGames, 'Ay');
  const ApplicationStreamingStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getStreamerActiveStreamMetadata, 'A');
  const ChannelStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getAllThreadsForParent, 'A');
  const GuildChannelStore = findExport(x => x && x.exports && x.exports.Ay && x.exports.Ay.getSFWDefaultChannel, 'Ay');
  const FluxDispatcher = findExport(x => x && x.exports && x.exports.h && x.exports.h.__proto__ && x.exports.h.__proto__.flushWaitQueue, 'h');
  const api = findExport(x => x && x.exports && x.exports.Bo && x.exports.Bo.get, 'Bo');
  const UserStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getCurrentUser, 'A');

  if (!api) return { fatal: 'modul api nie znaleziony' };

  // Nazwa konta do panelu
  try {
    const u = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
    if (u) R({ t: 'user', username: u.username, id: u.id, discriminator: u.discriminator });
  } catch(_) {}

  // Atrapa DiscordNative – odblokowuje sciezke PLAY/STREAM w kliencie
  if (typeof DiscordNative === 'undefined') {
    try {
      window.DiscordNative = {
        process: { platform: 'win32', arch: 'x64' },
        app: { getModuleVersions: () => ({}), getPath: () => 'C:\\\\Users' },
        os: { release: '10.0.26100' },
        window: { setDevtoolsCallbacks: () => {} },
      };
    } catch(_) {}
  }

  // ── 3. Poczekaj na questy ─────────────────────────────────────────────────
  for (let i = 0; i < 30 && QuestsStore.quests.size === 0; i++) await sleep(1000);

  const SUPPORTED = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];

  const orbsOf = (q) => {
    try {
      const rc = q.config.rewardsConfig || q.config.rewards_config;
      const rewards = (rc && (rc.rewards || rc.rewardsExpireAt ? rc.rewards : null)) || [];
      let sum = 0;
      for (const r of rewards) {
        const n = r.orbQuantity || r.orb_quantity || r.quantity || r.amount;
        if (typeof n === 'number') sum += n;
      }
      return sum;
    } catch(_) { return 0; }
  };

  const all = [...QuestsStore.quests.values()];
  const pending = all.filter(q => {
    const tc = q.config && (q.config.taskConfig || q.config.taskConfigV2);
    return q.config && !(q.userStatus && q.userStatus.completedAt)
        && new Date(q.config.expiresAt).getTime() > Date.now()
        && tc && tc.tasks
        && SUPPORTED.some(t => t in tc.tasks);
  });

  // Kolejnosc: wideo (sekundy) -> aktywnosc -> gra. Szybkie i pewne najpierw,
  // zeby jeden zablokowany quest-gra nie wstrzymywal calej reszty.
  const PRIORITY = { WATCH_VIDEO: 0, WATCH_VIDEO_ON_MOBILE: 0, PLAY_ACTIVITY: 1, PLAY_ON_DESKTOP: 2, STREAM_ON_DESKTOP: 3 };
  const taskOf = q => {
    const tc = q.config.taskConfig || q.config.taskConfigV2;
    return SUPPORTED.find(t => tc.tasks[t] != null);
  };
  pending.sort((a, b) => (PRIORITY[taskOf(a)] ?? 9) - (PRIORITY[taskOf(b)] ?? 9));

  R({ t: 'quests', total: all.length, pending: pending.length,
      list: pending.map(q => {
        const tc = q.config.taskConfig || q.config.taskConfigV2;
        const task = SUPPORTED.find(t => tc.tasks[t] != null);
        return {
          id: q.id,
          name: (q.config.messages && q.config.messages.questName) || q.id,
          task: task,
          target: tc.tasks[task].target,
          done: (q.userStatus && q.userStatus.progress && q.userStatus.progress[task] && q.userStatus.progress[task].value) || 0,
          orbs: orbsOf(q),
          enrolled: !!(q.userStatus && q.userStatus.enrolledAt),
        };
      }) });

  // ── 4. Zapis do questa ────────────────────────────────────────────────────
  log('Znaleziono ' + pending.length + ' questow do zrobienia (z ' + all.length + ' widocznych)');

  const enroll = async (quest) => {
    const locations = [11, 10, 8, 4, 2, 1, 0];
    let lastErr = null;
    for (const loc of locations) {
      try {
        await api.post({ url: '/quests/' + quest.id + '/enroll', body: { location: loc } });
        return { ok: true, loc: loc };
      } catch(e) {
        const msg = (e && e.body && e.body.message) || (e && e.message) || ('HTTP ' + (e && e.status));
        lastErr = msg;
        // Jesli Discord zada weryfikacji, dalsze proby nic nie dadza
        if (/captcha|verif/i.test(String(msg))) return { ok: false, err: msg, captcha: true };
      }
    }
    try {
      await api.post({ url: '/quests/' + quest.id + '/enroll', body: {} });
      return { ok: true, loc: 'empty' };
    } catch(e) {
      return { ok: false, err: lastErr || (e && e.message) || 'unknown' };
    }
  };

  // ── 5. Pojedynczy quest ───────────────────────────────────────────────────
  const doQuest = async (quest) => {
    const name = (quest.config.messages && quest.config.messages.questName) || quest.id;
    const tc = quest.config.taskConfig || quest.config.taskConfigV2;
    const taskName = SUPPORTED.find(t => tc.tasks[t] != null);
    const taskData = tc.tasks[taskName];
    const secondsNeeded = taskData.target;
    const applicationId = (quest.config.application && quest.config.application.id)
                       || (taskData.applications && taskData.applications[0] && taskData.applications[0].id);
    let secondsDone = (quest.userStatus && quest.userStatus.progress && quest.userStatus.progress[taskName] && quest.userStatus.progress[taskName].value) || 0;
    const orbs = orbsOf(quest);

    R({ t: 'qstart', id: quest.id, name: name, task: taskName, target: secondsNeeded, done: secondsDone, orbs: orbs });
    log('Start: ' + name + ' [' + taskName + '] ' + secondsDone + '/' + secondsNeeded + 's');

    if (!(quest.userStatus && quest.userStatus.enrolledAt)) {
      const e = await enroll(quest);
      if (!e.ok) {
        R({ t: 'qerr', id: quest.id, err: 'enroll: ' + e.err, captcha: !!e.captcha });
        return;
      }
      log('Zapisano: ' + name);
      await sleep(500);
    }

    // ── WATCH_VIDEO ─────────────────────────────────────────────────────────
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
        completed = res.body && res.body.completed_at != null;
        secondsDone = Math.min(secondsNeeded, timestamp);
        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });
        if (timestamp >= secondsNeeded) break;
      }
      if (!completed) {
        await api.post({ url: '/quests/' + quest.id + '/video-progress', body: { timestamp: secondsNeeded } });
      }
      R({ t: 'qdone', id: quest.id, orbs: orbs });
      return;
    }

    // ── PLAY_ACTIVITY ───────────────────────────────────────────────────────
    if (taskName === 'PLAY_ACTIVITY') {
      let channelId = null;
      try {
        const priv = ChannelStore && ChannelStore.getSortedPrivateChannels && ChannelStore.getSortedPrivateChannels();
        channelId = priv && priv[0] && priv[0].id;
        if (!channelId && GuildChannelStore) {
          const g = Object.values(GuildChannelStore.getAllGuilds())
            .find(x => x != null && x.VOCAL && x.VOCAL.length > 0);
          channelId = g && g.VOCAL[0] && g.VOCAL[0].channel && g.VOCAL[0].channel.id;
        }
      } catch(_) {}
      if (!channelId) { R({ t: 'qerr', id: quest.id, err: 'brak kanalu glosowego' }); return; }

      const streamKey = 'call:' + channelId + ':1';
      let stalledA = 0;
      let okA = false;
      let errA = null;

      while (true) {
        let res;
        try {
          res = await api.post({
            url: '/quests/' + quest.id + '/heartbeat',
            body: { stream_key: streamKey, terminal: false }
          });
        } catch(e) {
          errA = (e && e.body && e.body.message) || (e && e.message) || ('HTTP ' + (e && e.status));
          break;
        }

        const progress = (res.body && res.body.progress && res.body.progress.PLAY_ACTIVITY && res.body.progress.PLAY_ACTIVITY.value) || 0;
        if (progress > secondsDone) { secondsDone = progress; stalledA = 0; }
        else { stalledA += 20; }

        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });

        if (secondsDone >= secondsNeeded) {
          try {
            await api.post({
              url: '/quests/' + quest.id + '/heartbeat',
              body: { stream_key: streamKey, terminal: true }
            });
          } catch(_) {}
          okA = true;
          break;
        }

        if (stalledA >= 120) { errA = 'backend nie nalicza postepu (0s przez 2 min)'; break; }
        await sleep(20000);
      }

      if (okA) R({ t: 'qdone', id: quest.id, orbs: orbs });
      else R({ t: 'qerr', id: quest.id, err: errA || 'nieznany blad' });
      return;
    }

    // ── PLAY_ON_DESKTOP ─────────────────────────────────────────────────────
    if (taskName === 'PLAY_ON_DESKTOP') {
      if (!RunningGameStore || !FluxDispatcher) {
        R({ t: 'qerr', id: quest.id, err: 'brak RunningGameStore/FluxDispatcher' }); return;
      }
      const pid = Math.floor(Math.random() * 30000) + 1000;
      const res = await api.get({ url: '/applications/public?application_ids=' + applicationId });
      const appData = res.body[0];
      const exe = appData.executables && appData.executables.find(x => x.os === 'win32');
      const exeName = (exe && exe.name && exe.name.replace('>','')) || appData.name.replace(/[\\/\\\\:*?"<>|]/g, '');

      const fakeGame = {
        cmdLine: 'C:\\\\Program Files\\\\' + appData.name + '\\\\' + exeName,
        exeName: exeName,
        exePath: 'c:/program files/' + appData.name.toLowerCase() + '/' + exeName,
        hidden: false, isLauncher: false, id: applicationId, name: appData.name,
        pid: pid, pidPath: [pid], processName: appData.name, start: Date.now(),
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
        try { FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: [fakeGame], added: [], games: [] }); } catch(_) {}
      };

      // Klient webowy nie prowadzi wlasnej petli heartbeatow dla gier,
      // wiec wysylamy je sami - tak jak robi to klient desktopowy.
      log('Udaje gre: ' + appData.name);

      let stalled = 0;
      let ok = false;
      let failErr = null;

      while (true) {
        let res2;
        try {
          res2 = await api.post({
            url: '/quests/' + quest.id + '/heartbeat',
            body: { stream_key: null, terminal: false }
          });
        } catch(e) {
          failErr = (e && e.body && e.body.message) || (e && e.message) || ('HTTP ' + (e && e.status));
          break;
        }

        const prog = res2.body && res2.body.progress && res2.body.progress.PLAY_ON_DESKTOP;
        const p = (prog && prog.value) || 0;

        if (p > secondsDone) { secondsDone = p; stalled = 0; }
        else { stalled += 20; }

        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });

        if (secondsDone >= secondsNeeded) {
          try {
            await api.post({
              url: '/quests/' + quest.id + '/heartbeat',
              body: { stream_key: null, terminal: true }
            });
          } catch(_) {}
          ok = true;
          break;
        }

        // Backend nie nalicza postepu - dalsze czekanie nic nie da
        if (stalled >= 120) {
          failErr = 'backend nie nalicza postepu dla klienta webowego (0s przez 2 min)';
          break;
        }

        await sleep(20000);
      }

      restore();
      if (ok) R({ t: 'qdone', id: quest.id, orbs: orbs });
      else R({ t: 'qerr', id: quest.id, err: failErr || 'nieznany blad' });
      return;
    }

    // ── STREAM_ON_DESKTOP ───────────────────────────────────────────────────
    if (taskName === 'STREAM_ON_DESKTOP') {
      R({ t: 'qerr', id: quest.id, err: 'pominieto - wymaga streamu na kanale glosowym z inna osoba' });
      return;
    }
  };

  for (const quest of pending) {
    try { await doQuest(quest); }
    catch(e) {
      R({ t: 'qerr', id: quest.id,
          err: (e && e.body && e.body.message) || (e && e.message) || String(e) });
    }
  }

  R({ t: 'finished' });
  return { ok: true };
})()`;
