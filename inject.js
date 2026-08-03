module.exports = `(async () => {
  // Second layer of protection against double injection: even if the script
  // were injected twice into the same page, the second instance exits right
  // away. Two loops on the same account would enroll into the same quest
  // and trip each other's rate limits.
  if (window.__questBotActive) return { fatal: 'script already running in this tab' };
  window.__questBotActive = true;

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
  if (!wpRequire || !wpRequire.c) return { fatal: 'wpRequire.c missing' };

  const mods = Object.values(wpRequire.c);
  const findExport = (pred, key) => {
    const m = mods.find(pred);
    return m ? m.exports[key] : null;
  };

  // ── 2. Discord stores ─────────────────────────────────────────────────────
  const QuestsStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getQuest, 'A');
  if (!QuestsStore) return { fatal: 'QuestsStore not found' };

  const RunningGameStore = findExport(x => x && x.exports && x.exports.Ay && x.exports.Ay.getRunningGames, 'Ay');
  const ApplicationStreamingStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getStreamerActiveStreamMetadata, 'A');
  const ChannelStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getAllThreadsForParent, 'A');
  const GuildChannelStore = findExport(x => x && x.exports && x.exports.Ay && x.exports.Ay.getSFWDefaultChannel, 'Ay');
  const FluxDispatcher = findExport(x => x && x.exports && x.exports.h && x.exports.h.__proto__ && x.exports.h.__proto__.flushWaitQueue, 'h');
  const api = findExport(x => x && x.exports && x.exports.Bo && x.exports.Bo.get, 'Bo');
  const UserStore = findExport(x => x && x.exports && x.exports.A && x.exports.A.__proto__ && x.exports.A.__proto__.getCurrentUser, 'A');

  if (!api) return { fatal: 'api module not found' };

  // Account identity for the panel (username, avatar, email)
  try {
    const u = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
    if (u) R({
      t: 'user',
      username: u.username,
      globalName: u.globalName || u.global_name || null,
      id: u.id,
      discriminator: u.discriminator,
      avatar: u.avatar || null,
      email: u.email || null,
    });
  } catch(_) {}

  // DiscordNative stub – unlocks the PLAY/STREAM code path in the client
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

  // ── 3. Wait for quests ────────────────────────────────────────────────────
  for (let i = 0; i < 45 && QuestsStore.quests.size === 0; i++) await sleep(1000);

  // The store hands out camelCase objects, the raw API answers in snake_case.
  // Normalising once means nothing downstream has to care which one it got.
  const camel = (v) => {
    if (Array.isArray(v)) return v.map(camel);
    if (v && typeof v === 'object' && v.constructor === Object) {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase())] = camel(v[k]);
      }
      return out;
    }
    return v;
  };

  // On some accounts the client never pushes the quest list into the store -
  // it only fetches it once something asks. Asking the API directly beats
  // reporting "no quests" on an account that has plenty.
  let apiQuests = [];
  if (QuestsStore.quests.size === 0) {
    try {
      const res = await api.get({ url: '/quests/@me' });
      const raw = (res && res.body && (res.body.quests || res.body)) || [];
      apiQuests = (Array.isArray(raw) ? raw : []).map(camel);
      log('QuestsStore stayed empty - fetched ' + apiQuests.length + ' quest(s) from the API');
    } catch(e) {
      log('QuestsStore is empty and /quests/@me failed: ' + ((e && e.message) || e));
    }
  }

  const SUPPORTED = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];

  const opts = window.__questOpts || {};
  const onlyOrbs = !!opts.onlyOrbs;

  const rewardsOf = (q) => {
    try {
      const rc = q.config.rewardsConfig || q.config.rewards_config;
      const r = rc && rc.rewards;
      return Array.isArray(r) ? r : [];
    } catch(_) { return []; }
  };

  // Orbs have their own quantity field. The previous version also summed the
  // generic 'quantity' field, which made cosmetic rewards (avatar frames,
  // profile effects) count as orbs.
  const orbsOf = (q) => {
    let sum = 0;
    for (const r of rewardsOf(q)) {
      const n = r.orbQuantity != null ? r.orbQuantity : r.orb_quantity;
      if (typeof n === 'number') sum += n;
    }
    return sum;
  };

  // Reward description for the panel and for diagnostics – lets you verify
  // orb detection against real data.
  const rewardInfo = (q) => rewardsOf(q).map(r => ({
    type: r.type,
    orbs: r.orbQuantity != null ? r.orbQuantity : r.orb_quantity,
    name: (r.messages && (r.messages.name || r.messages.nameWithArticle)) || r.name || null,
  }));

  const all = apiQuests.length ? apiQuests : [...QuestsStore.quests.values()];
  const pending = all.filter(q => {
    const tc = q.config && (q.config.taskConfig || q.config.taskConfigV2);
    return q.config && !(q.userStatus && q.userStatus.completedAt)
        && new Date(q.config.expiresAt).getTime() > Date.now()
        && tc && tc.tasks
        && SUPPORTED.some(t => t in tc.tasks);
  });

  // Order: video (seconds) -> activity -> game. Fast and reliable first, so
  // one stuck game quest doesn't hold up the rest.
  const PRIORITY = { WATCH_VIDEO: 0, WATCH_VIDEO_ON_MOBILE: 0, PLAY_ACTIVITY: 1, PLAY_ON_DESKTOP: 2, STREAM_ON_DESKTOP: 3 };
  const taskOf = q => {
    const tc = q.config.taskConfig || q.config.taskConfigV2;
    return SUPPORTED.find(t => tc.tasks[t] != null);
  };
  pending.sort((a, b) => (PRIORITY[taskOf(a)] ?? 9) - (PRIORITY[taskOf(b)] ?? 9));

  // Skip quests without orbs (e.g. avatar frame only) – if configured that way
  const skipped = [];
  let selected = pending;
  if (onlyOrbs) {
    selected = [];
    for (const q of pending) {
      if (orbsOf(q) > 0) selected.push(q);
      else skipped.push(q);
    }
    if (skipped.length) {
      log('Skipped ' + skipped.length + ' quest(s) without orbs: '
        + skipped.map(q => (q.config.messages && q.config.messages.questName) || q.id).join(', '));
    }
  }

  R({ t: 'skipped', list: skipped.map(q => {
    const tc = q.config.taskConfig || q.config.taskConfigV2;
    const task = SUPPORTED.find(t => tc.tasks[t] != null);
    return {
      id: q.id,
      name: (q.config.messages && q.config.messages.questName) || q.id,
      task: task,
      target: tc.tasks[task].target,
      rewards: rewardInfo(q),
    };
  }) });

  R({ t: 'quests', total: all.length, pending: selected.length,
      list: selected.map(q => {
        const tc = q.config.taskConfig || q.config.taskConfigV2;
        const task = SUPPORTED.find(t => tc.tasks[t] != null);
        return {
          id: q.id,
          name: (q.config.messages && q.config.messages.questName) || q.id,
          task: task,
          target: tc.tasks[task].target,
          done: (q.userStatus && q.userStatus.progress && q.userStatus.progress[task] && q.userStatus.progress[task].value) || 0,
          orbs: orbsOf(q),
          rewards: rewardInfo(q),
          enrolled: !!(q.userStatus && q.userStatus.enrolledAt),
        };
      }) });

  // ── 4. Quest enrollment ───────────────────────────────────────────────────
  log('Found ' + selected.length + ' quest(s) to do (out of ' + all.length + ' visible)');

  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + (ms/1000) + 's: ' + label)), ms)),
  ]);

  const errMsg = e => (e && e.body && e.body.message) || (e && e.message) || ('HTTP ' + (e && e.status));

  const isRateLimit = (e) => {
    if (!e) return false;
    if (e.status === 429) return true;
    return /rate limit|tempo zosta|too many requests/i.test(String(errMsg(e)));
  };

  const retryAfterMs = (e) => {
    const ra = e && e.body && (e.body.retry_after != null ? e.body.retry_after : e.body.retryAfter);
    return typeof ra === 'number' ? Math.ceil(ra * 1000) + 500 : 6000;
  };

  // Every API call goes through: a timeout, plus patient waiting out of any
  // rate limit.
  const apiCall = async (method, url, body, label) => {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const p = method === 'GET' ? api.get({ url: url }) : api.post({ url: url, body: body });
        return await withTimeout(p, 30000, label);
      } catch(e) {
        lastErr = e;
        if (isRateLimit(e) && attempt < 4) {
          const wait = retryAfterMs(e);
          log('rate limited (' + label + ') - waiting ' + Math.round(wait/1000) + 's');
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  };

  let knownLoc = null;

  const enroll = async (quest) => {
    const base = [11, 10, 8, 4, 2, 1, 0];
    const locations = knownLoc != null
      ? [knownLoc].concat(base.filter(l => l !== knownLoc))
      : base;

    let lastErr = null;
    for (const loc of locations) {
      try {
        await apiCall('POST', '/quests/' + quest.id + '/enroll', { location: loc }, 'enroll');
        knownLoc = loc;
        return { ok: true, loc: loc };
      } catch(e) {
        const msg = errMsg(e);
        lastErr = msg;

        // Rate limited despite retries – trying more location values won't
        // help, since the value isn't the problem. Bail out and retry later.
        if (isRateLimit(e)) {
          return { ok: false, err: msg, rateLimited: true };
        }
        if (/captcha|verif/i.test(String(msg))) {
          return { ok: false, err: msg, captcha: true };
        }
        log('  enroll location=' + loc + ' -> ' + msg);
      }
    }

    try {
      await apiCall('POST', '/quests/' + quest.id + '/enroll', {}, 'enroll');
      return { ok: true, loc: 'empty' };
    } catch(e) {
      return { ok: false, err: lastErr || errMsg(e) };
    }
  };

  // ── 5. Single quest ───────────────────────────────────────────────────────
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
      log('Enrolling in quest...');
      const e = await enroll(quest);
      if (!e.ok) {
        // A CAPTCHA needs a human - there is nothing to come back to later.
        if (e.captcha) {
          R({ t: 'qerr', id: quest.id, err: 'enroll: ' + e.err, captcha: true });
          return;
        }
        return { retry: true, err: 'enroll: ' + e.err, rateLimited: !!e.rateLimited };
      }
      log('Enrolled: ' + name + ' (location=' + e.loc + ')');
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
        const t0 = Date.now();
        let res;
        try {
          res = await apiCall('POST', '/quests/' + quest.id + '/video-progress',
            { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }, 'video-progress');
        } catch(e) {
          const msg = errMsg(e);
          log('video-progress failed after ' + Math.round((Date.now()-t0)/1000) + 's: ' + msg);
          return { retry: true, err: 'video-progress: ' + msg, rateLimited: isRateLimit(e) };
        }
        completed = res.body && res.body.completed_at != null;
        secondsDone = Math.min(secondsNeeded, timestamp);
        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });
        log('video ' + secondsDone + '/' + secondsNeeded + 's (' + (Date.now()-t0) + 'ms)');
        if (timestamp >= secondsNeeded) break;
      }
      if (!completed) {
        try {
          await apiCall('POST', '/quests/' + quest.id + '/video-progress',
            { timestamp: secondsNeeded }, 'video-progress final');
        } catch(_) {}
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
      if (!channelId) { R({ t: 'qerr', id: quest.id, err: 'no voice channel available' }); return; }

      const streamKey = 'call:' + channelId + ':1';
      let stalledA = 0;
      let okA = false;
      let errA = null;

      while (true) {
        let res;
        try {
          res = await apiCall('POST', '/quests/' + quest.id + '/heartbeat',
            { stream_key: streamKey, terminal: false }, 'heartbeat');
        } catch(e) {
          errA = errMsg(e);
          break;
        }

        const progress = (res.body && res.body.progress && res.body.progress.PLAY_ACTIVITY && res.body.progress.PLAY_ACTIVITY.value) || 0;
        if (progress > secondsDone) { secondsDone = progress; stalledA = 0; }
        else { stalledA += 20; }

        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });

        if (secondsDone >= secondsNeeded) {
          try {
            await apiCall('POST', '/quests/' + quest.id + '/heartbeat',
              { stream_key: streamKey, terminal: true }, 'heartbeat final');
          } catch(_) {}
          okA = true;
          break;
        }

        if (stalledA >= 120) { errA = 'backend is not tracking progress (0s for 2 min)'; break; }
        await sleep(20000);
      }

      if (!okA) return { retry: true, err: errA || 'unknown error' };
      R({ t: 'qdone', id: quest.id, orbs: orbs });
      return;
    }

    // ── PLAY_ON_DESKTOP ─────────────────────────────────────────────────────
    if (taskName === 'PLAY_ON_DESKTOP') {
      if (!RunningGameStore || !FluxDispatcher) {
        R({ t: 'qerr', id: quest.id, err: 'RunningGameStore/FluxDispatcher not found' }); return;
      }
      const pid = Math.floor(Math.random() * 30000) + 1000;
      const res = await apiCall('GET', '/applications/public?application_ids=' + applicationId, null, 'applications');
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

      // The web client doesn't run its own heartbeat loop for games, so we
      // send them ourselves - just like the desktop client does.
      log('Impersonating game: ' + appData.name);

      let stalled = 0;
      let ok = false;
      let failErr = null;

      while (true) {
        let res2;
        try {
          res2 = await apiCall('POST', '/quests/' + quest.id + '/heartbeat',
            { stream_key: null, terminal: false }, 'heartbeat');
        } catch(e) {
          failErr = errMsg(e);
          break;
        }

        const prog = res2.body && res2.body.progress && res2.body.progress.PLAY_ON_DESKTOP;
        const p = (prog && prog.value) || 0;

        if (p > secondsDone) { secondsDone = p; stalled = 0; }
        else { stalled += 20; }

        R({ t: 'qprog', id: quest.id, done: secondsDone, target: secondsNeeded });

        if (secondsDone >= secondsNeeded) {
          try {
            await apiCall('POST', '/quests/' + quest.id + '/heartbeat',
              { stream_key: null, terminal: true }, 'heartbeat final');
          } catch(_) {}
          ok = true;
          break;
        }

        // Backend isn't tracking progress – further waiting won't help
        if (stalled >= 120) {
          failErr = 'backend is not tracking progress for the web client (0s for 2 min)';
          break;
        }

        await sleep(20000);
      }

      restore();
      if (!ok) return { retry: true, err: failErr || 'unknown error' };
      R({ t: 'qdone', id: quest.id, orbs: orbs });
      return;
    }

    // ── STREAM_ON_DESKTOP ───────────────────────────────────────────────────
    if (taskName === 'STREAM_ON_DESKTOP') {
      R({ t: 'qerr', id: quest.id, err: 'skipped - requires streaming in a voice channel with another person' });
      return;
    }
  };

  // ── 6. Queue ──────────────────────────────────────────────────────────────
  // A quest that fails is parked at the back of the queue rather than written
  // off: the same quest that errors on one account goes through on the next,
  // and often goes through on this one too once the account has done
  // something else in between. Only a failure a human has to clear (a CAPTCHA,
  // a missing voice channel) is final straight away.
  const MAX_ATTEMPTS = 3;
  const RETRY_PAUSE = 30000;

  const nameOf = q => (q.config && q.config.messages && q.config.messages.questName) || q.id;

  // Spacing between quests keeps us below the rate-limit threshold.
  const queue = selected.slice();
  const attempts = {};
  let first = true;

  while (queue.length) {
    const quest = queue.shift();
    if (!first) await sleep(3000);
    first = false;

    let outcome = null;
    try {
      outcome = await doQuest(quest);
    } catch(e) {
      outcome = { retry: true, err: errMsg(e), rateLimited: isRateLimit(e) };
    }

    // Finished, or already reported as permanently failed.
    if (!outcome || !outcome.retry) continue;

    attempts[quest.id] = (attempts[quest.id] || 0) + 1;
    const used = attempts[quest.id];
    const qname = nameOf(quest);

    if (used >= MAX_ATTEMPTS) {
      R({ t: 'qerr', id: quest.id,
          err: outcome.err + ' (gave up after ' + used + ' attempts)' });
      log('Giving up on ' + qname + ' after ' + used + ' attempts: ' + outcome.err);
      continue;
    }

    R({ t: 'qretry', id: quest.id, err: outcome.err, attempt: used, max: MAX_ATTEMPTS,
        rateLimited: !!outcome.rateLimited });
    log((outcome.rateLimited ? 'Rate limited on ' : 'Failed: ') + qname
        + ' (' + outcome.err + ') - moving on, will come back to it ['
        + used + '/' + MAX_ATTEMPTS + ']');
    queue.push(quest);

    // It was the last one, so there is nothing else to get on with in the
    // meantime - wait instead of retrying the same thing immediately.
    if (queue.length === 1) {
      log('Nothing else queued - waiting ' + (RETRY_PAUSE / 1000) + 's before retrying ' + qname);
      await sleep(RETRY_PAUSE);
    }
  }

  R({ t: 'finished' });
  window.__questBotActive = false;
  return { ok: true };
})()`;
