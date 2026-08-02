const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const INJECT_SCRIPT = require('./inject.js');
const { loadProxies, proxyUrl, normalizeScheme, applyScheme, PROXY_FILE } = require('./proxies.js');
const {
  playwrightProxy, detectScheme, lastErrorFor, closeAll: closeBridges,
} = require('./socks-bridge.js');
const { fingerprintFor, fingerprintLabel, initScript } = require('./fingerprint.js');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const STATE_FILE = path.join(__dirname, 'state.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

const PROXY_CHECK_URL = process.env.PROXY_CHECK_URL || 'https://api.ipify.org?format=json';

// Keep WebRTC from punching UDP straight out of the box and revealing the real
// IP while every HTTP request goes through the proxy. Only applied to proxied
// browsers – without a proxy there is nothing to leak past.
const WEBRTC_ARGS = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const CLIENT_VERSION = '1.0.9165';
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) discord/' + CLIENT_VERSION
  + ' Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
function toDesktopSuperProperties(originalB64) {
  if (!originalB64) return null;
  let props;
  try {
    props = JSON.parse(Buffer.from(originalB64, 'base64').toString('utf-8'));
  } catch (_) {
    return null;
  }
  if (!props || typeof props !== 'object') return null;

  return Buffer.from(JSON.stringify({
    ...props,                       
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: props.release_channel ?? 'stable',
    client_version: CLIENT_VERSION,
    os_version: '10.0.26100',
    os_arch: 'x64',
    app_arch: 'x64',
    browser_user_agent: ELECTRON_UA,
    browser_version: '32.2.7',
    native_build_number: 55903,
  })).toString('base64');
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

// Browser profiles used to live in profiles/<line number>, so deleting or
// reordering a line in tokens.txt silently gave an account another account's
// cookies – logged in as one user while presenting a second user's session
// through a third user's proxy. Key them by the token instead.
function profileDirFor(token) {
  return path.join(PROFILES_DIR,
    crypto.createHash('sha256').update(String(token).trim()).digest('hex').slice(0, 16));
}

// One-time move of the old index-named directories onto token-based names. Only
// safe while tokens.txt is still in the order the old code used, so it runs once
// and leaves a marker behind.
function migrateProfiles(tokens) {
  const marker = path.join(PROFILES_DIR, '.keyed-by-token');
  try {
    if (!fs.existsSync(PROFILES_DIR) || fs.existsSync(marker)) return;
    tokens.forEach((token, i) => {
      const legacy = path.join(PROFILES_DIR, String(i));
      const target = profileDirFor(token);
      if (fs.existsSync(legacy) && !fs.existsSync(target)) {
        try { fs.renameSync(legacy, target); } catch (_) {}
      }
    });
    fs.writeFileSync(marker, 'profiles are keyed by token hash\n');
  } catch (_) {}
}

function shortError(e) {
  return String(e && e.message ? e.message : e)
    .replace(ANSI, '')
    .split('\n')[0]
    .replace(/^apiRequestContext\.\w+:\s*/, '')
    .trim();
}

// A SOCKS5 proxy is reached through a local bridge, so Chromium can only ever
// report "the bridge said 502". Swap in the reason the bridge actually hit.
function proxyError(e, proxy) {
  const msg = shortError(e);
  const real = lastErrorFor(proxy);
  return real && /502|bad gateway|socket hang up|ECONNRESET/i.test(msg)
    ? `${real} (via SOCKS5 bridge)`
    : msg;
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.accounts = [];
    this._browsers = { plain: null, proxied: null };
    this.concurrency = parseInt(process.env.CONCURRENCY || '5', 10);
    this.headless = process.env.HEADLESS !== 'false';
    this.desktopMode = process.env.DESKTOP_MODE === 'true';
    this.onlyOrbs = process.env.ONLY_ORBS !== 'false';
    this.useProxies = process.env.USE_PROXIES !== 'false';
    // Protocol used for ip.txt lines that have no `scheme://` prefix (e.g. the
    // bare `ip:port:user:pass` template). Persisted UI choice wins over the env
    // default. SOCKS5 here makes an unprefixed list route through the bridge.
    this.defaultProxyScheme = normalizeScheme(process.env.PROXY_SCHEME || 'auto');
    this.totals = { questsCompleted: 0, orbsEarned: 0 };
    this.proxyList = { file: PROXY_FILE, exists: false, proxies: [], errors: [] };
    this.proxyTest = { running: false, done: 0, total: 0, ok: 0, results: [] };
    this._verifyQueue = [];
    this._verifyCurrent = null;
    this._loadState();
    this.loadProxies();
    this.loadTokens();
  }

  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      this.totals = { questsCompleted: 0, orbsEarned: 0, ...s.totals };
      this._history = s.history ?? {};
      if (s.settings && s.settings.defaultProxyScheme) {
        this.defaultProxyScheme = normalizeScheme(s.settings.defaultProxyScheme);
      }
    } catch (_) {
      this._history = {};
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        totals: this.totals,
        history: this._history,
        settings: { defaultProxyScheme: this.defaultProxyScheme },
      }, null, 2));
    } catch (_) {}
  }

  loadTokens() {
    let tokens = [];
    try {
      tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
        .split('\n').map(t => t.trim()).filter(Boolean);
    } catch (_) {}

    migrateProfiles(tokens);

    this.accounts = tokens.map((token, i) => {
      const id = String(i);
      const prev = this._history[id] ?? {};
      return {
        id,
        token,
        label: token.substring(0, 14) + '…',
        fingerprint: fingerprintFor(token),
        // Keyed by the token, not by its line number: reordering tokens.txt must
        // not hand an account someone else's cookies.
        profileDir: profileDirFor(token),
        username: prev.username ?? null,
        globalName: prev.globalName ?? null,
        discordId: prev.discordId ?? null,
        avatar: prev.avatar ?? null,
        email: prev.email ?? null,
        status: 'idle',
        message: '',
        quests: [],
        questsDone: prev.questsDone ?? 0,
        orbs: prev.orbs ?? 0,
        logs: [],
        needsCaptcha: false,
        proxy: null,
        proxyIp: prev.proxyIp ?? null,
        proxyError: null,
        _context: null,
      };
    });
    this._assignProxies();
    this.emit('update');
  }

  getToken(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    return acc.token;
  }

  loadProxies() {
    this.proxyList = loadProxies(PROXY_FILE, this.defaultProxyScheme);
    if (!this.proxyTest.running) {
      this.proxyTest = { running: false, done: 0, total: 0, ok: 0, results: [] };
    }
    this._assignProxies();
    this.emit('update');
  }

  _assignProxies() {
    const list = this.proxyList.proxies;
    const on = this.useProxies && list.length > 0;
    this.accounts.forEach((acc, i) => {
      const next = on ? list[i % list.length] : null
      if (!acc.proxy || !next || acc.proxy.server !== next.server) {
        acc.proxyIp = null;
        acc.proxyError = null;
      }
      acc.proxy = next;
    });
  }

  setUseProxies(v) {
    this.useProxies = !!v;
    this._assignProxies();
    this._closeIdleBrowsers();
    this.emit('update');
  }

  setDefaultProxyScheme(v) {
    this.defaultProxyScheme = normalizeScheme(v);
    this._saveState();
    this.loadProxies();          // re-parse ip.txt under the new default
    this._closeIdleBrowsers();
    this.emit('update');
    return this.defaultProxyScheme;
  }

  getProxyUrl(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    if (!acc.proxy) throw new Error('No proxy assigned to this account');
    return proxyUrl(acc.proxy);
  }

  // A bare `ip:port:user:pass` line says nothing about the protocol. Rather than
  // guess HTTP – which silently resets against every SOCKS5 proxy – ask the
  // endpoint once and remember the answer.
  async _resolveScheme(proxy) {
    if (!proxy || !proxy.pending) return proxy;
    const found = await detectScheme(proxy).catch(() => null);
    if (found && found !== proxy.scheme) {
      applyScheme(proxy, found);
      this._logAll(`Detected ${proxy.label} as ${found.toUpperCase()}`);
    } else if (found) {
      applyScheme(proxy, found);
    } else {
      // Undetectable: leave the assumed scheme but stop re-probing every call.
      proxy.pending = false;
    }
    this.emit('update');
    return proxy;
  }

  _logAll(msg) {
    for (const acc of this.accounts) {
      if (acc.proxy && acc.proxy.label && msg.includes(acc.proxy.label)) this._log(acc, msg);
    }
  }

  async _probeProxy(proxy, timeout = 20000) {
    await this._resolveScheme(proxy);
    let request;
    try {
      ({ request } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright is not installed. Run: npm install');
    }

    const ctx = await request.newContext({
      proxy: await playwrightProxy(proxy),
      timeout,
    });
    try {
      const res = await ctx.get(PROXY_CHECK_URL);
      if (!res.ok()) throw new Error('proxy answered with HTTP ' + res.status());
      return (await res.json()).ip;
    } finally {
      try { await ctx.dispose(); } catch (_) {}
    }
  }

  _applyProbe(proxy, ip, error) {
    for (const acc of this.accounts) {
      if (!acc.proxy || acc.proxy.server !== proxy.server) continue;
      Object.assign(acc, { proxyIp: ip, proxyError: error });
      this._log(acc, ip
        ? `Proxy ${proxy.label} works – exit IP ${ip}`
        : `Proxy ${proxy.label} failed: ${error}`);
    }
    this.emit('update');
  }

  async refreshIdentity(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);

    let request;
    try {
      ({ request } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright is not installed. Run: npm install');
    }

    await this._resolveScheme(acc.proxy);
    const api = await request.newContext({
      proxy: await playwrightProxy(acc.proxy),
      timeout: 20000,
    });
    try {
      return await this._fetchIdentity(acc, { request: api });
    } finally {
      try { await api.dispose(); } catch (_) {}
    }
  }

  async refreshAllIdentities() {
    const queue = this.accounts.slice();
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const acc = queue[next++];
        try { await this.refreshIdentity(acc.id); } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
    return this.accounts.filter(a => a.username).length;
  }

  async testProxy(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    if (!acc.proxy) throw new Error('No proxy assigned to this account');

    try {
      const ip = await this._probeProxy(acc.proxy);
      this._applyProbe(acc.proxy, ip, null);
      return ip;
    } catch (e) {
      const why = proxyError(e, acc.proxy);
      this._applyProbe(acc.proxy, null, why);
      throw new Error(why);
    }
  }

  testAllProxies() {
    if (this.proxyTest.running) return this.proxyTest;
    const list = this.proxyList.proxies;
    if (!list.length) throw new Error('No proxies in ip.txt');

    this.proxyTest = { running: true, done: 0, total: list.length, ok: 0, results: [] };
    this.emit('update');

    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const proxy = list[next++];
        let entry;
        try {
          const ip = await this._probeProxy(proxy, 15000);
          this._applyProbe(proxy, ip, null);
          entry = { label: proxy.label, ok: true, ip };
          this.proxyTest.ok += 1;
        } catch (e) {
          const why = proxyError(e, proxy);
          this._applyProbe(proxy, null, why);
          entry = { label: proxy.label, ok: false, error: why };
        }
        this.proxyTest.done += 1;
        this.proxyTest.results.push(entry);
        this.emit('update');
      }
    };

    const workers = Array.from({ length: Math.min(8, list.length) }, worker);
    Promise.all(workers).finally(() => {
      this.proxyTest.running = false;
      this.proxyTest.finishedAt = Date.now();
      this.emit('update');
    });

    return this.proxyTest;
  }

  snapshot() {
    return {
      totals: this.totals,
      concurrency: this.concurrency,
      headless: this.headless,
      desktopMode: this.desktopMode,
      onlyOrbs: this.onlyOrbs,
      proxies: {
        enabled: this.useProxies,
        defaultScheme: this.defaultProxyScheme,
        count: this.proxyList.proxies.length,
        fileExists: this.proxyList.exists,
        fileName: path.basename(this.proxyList.file),
        errors: this.proxyList.errors,
        shared: this.useProxies && this.proxyList.proxies.length > 0
          && this.accounts.length > this.proxyList.proxies.length,
        test: this.proxyTest,
      },
      verify: this.verifyStatus(),
      accounts: this.accounts.map(a => {
        const target = a.quests.reduce((s, q) => s + (q.target || 0), 0);
        const done = a.quests.reduce((s, q) => s + Math.min(q.done || 0, q.target || 0), 0);
        return {
          id: a.id,
          label: a.label,
          username: a.username,
          globalName: a.globalName,
          discordId: a.discordId,
          avatar: a.avatar,
          email: a.email,
          status: a.status,
          message: a.message,
          proxy: a.proxy ? { label: a.proxy.label, scheme: a.proxy.scheme, auth: a.proxy.auth } : null,
          fingerprint: a.fingerprint ? fingerprintLabel(a.fingerprint) : null,
          proxyIp: a.proxyIp,
          proxyError: a.proxyError,
          needsCaptcha: a.needsCaptcha,
          verifyState: a.verifyState ?? null,
          verifyReason: a.verifyReason ?? null,
          desktopHint: !!a.desktopHint && !this.desktopMode,
          questsDone: a.questsDone,
          orbs: a.orbs,
          percent: target > 0 ? Math.round((done / target) * 100) : 0,
          quests: a.quests,
          skipped: a.skipped ?? [],
          logs: a.logs.slice(-40),
        };
      }),
    };
  }

  _push(acc, patch) {
    Object.assign(acc, patch);
    this.emit('update');
  }

  _setIdentity(acc, id) {
    this._push(acc, id);
    this._history[acc.id] = { ...(this._history[acc.id] ?? {}), ...id };
    this._saveState();
  }

  async _fetchIdentity(acc, context) {
    try {
      const res = await context.request.get('https://discord.com/api/v9/users/@me', {
        headers: { authorization: acc.token.trim() },
        timeout: 20000,
      });
      if (res.status() === 401) throw new Error('token rejected (401) – invalid or expired');
      if (!res.ok()) throw new Error('HTTP ' + res.status());

      const u = await res.json();
      this._setIdentity(acc, {
        username: u.username ?? null,
        globalName: u.global_name ?? null,
        discordId: u.id ?? null,
        avatar: u.avatar ?? null,
        email: u.email ?? null,
      });
      this._log(acc, `Signed in as ${u.global_name || u.username}`
        + ` (${u.email || 'e-mail hidden'})`);
      return true;
    } catch (e) {
      this._log(acc, 'Could not read account details: ' + shortError(e));
      return false;
    }
  }

  // Manual verification lane, width 1.
  //
  // A CAPTCHA has to be solved by a person, in the account's own browser, so the
  // challenge travels over that account's proxy. With 100 accounts that must be
  // strictly serialised – otherwise every account that hits a CAPTCHA pops a
  // window at the same moment. Accounts queue here and are handed over one at a
  // time; the panel shows whose turn it is and the run resumes once you confirm.
  _enterVerifyQueue(acc, reason) {
    const entry = { acc, reason, resolve: null, at: Date.now() };
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    entry.promise = promise;
    this._verifyQueue.push(entry);
    this._push(acc, { verifyState: 'waiting', verifyReason: reason });
    this._pumpVerifyQueue();
    return promise;
  }

  _pumpVerifyQueue() {
    if (this._verifyCurrent || !this._verifyQueue.length) return;
    const entry = this._verifyQueue.shift();
    // Drop entries whose account was stopped while queueing.
    if (!entry.acc._context) {
      entry.resolve({ ok: false, reason: 'account stopped' });
      return this._pumpVerifyQueue();
    }
    this._verifyCurrent = entry;
    this._push(entry.acc, { verifyState: 'active' });
    this._log(entry.acc, `Your turn: ${entry.reason}. Solve it in the open window, `
      + 'then press "I solved it" in the panel.');

    if (this.headless) {
      this._log(entry.acc, 'Note: headless mode is on, so no window is visible. '
        + 'Turn off headless mode to solve verification by hand.');
    }
    this.emit('update');
  }

  // Called from the panel when the person is done with the current account.
  resolveVerification(id, ok = true) {
    const cur = this._verifyCurrent;
    if (!cur) throw new Error('Nothing is waiting for verification');
    if (id != null && String(id) !== String(cur.acc.id)) {
      throw new Error('That is not the account currently being verified');
    }
    this._verifyCurrent = null;
    this._push(cur.acc, { verifyState: null, verifyReason: null,
                          needsCaptcha: ok ? false : cur.acc.needsCaptcha });
    cur.resolve({ ok });
    this._pumpVerifyQueue();
    return cur.acc.id;
  }

  // Position in the queue, for the panel.
  verifyStatus() {
    return {
      current: this._verifyCurrent ? {
        id: this._verifyCurrent.acc.id,
        label: this._verifyCurrent.acc.username || this._verifyCurrent.acc.label,
        reason: this._verifyCurrent.reason,
        since: this._verifyCurrent.at,
      } : null,
      waiting: this._verifyQueue.map(e => ({
        id: e.acc.id,
        label: e.acc.username || e.acc.label,
      })),
    };
  }

  _log(acc, msg) {
    acc.logs.push({ ts: Date.now(), msg: String(msg) });
    if (acc.logs.length > 300) acc.logs.shift();
    this.emit('update');
  }

  // A persistent context keeps cookies, cache, IndexedDB and service workers in
  // the account's own directory, so a session that is still valid is reused
  // instead of logging in with the raw token on every run.
  async _openProfile(acc, proxy, profileDir) {
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright is not installed. Run: npm install');
    }

    const fp = acc.fingerprint || fingerprintFor(acc.token);
    fs.mkdirSync(profileDir, { recursive: true });

    return chromium.launchPersistentContext(path.join(profileDir, 'browser'), {
      headless: this.headless,
      proxy: await playwrightProxy(proxy),
      userAgent: this.desktopMode ? ELECTRON_UA : fp.userAgent,
      locale: fp.locale,
      timezoneId: fp.timezoneId,
      viewport: fp.viewport,
      screen: fp.screen,
      deviceScaleFactor: fp.deviceScaleFactor,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--disable-background-networking',
        '--disable-default-apps', '--disable-extensions', '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        ...(proxy ? WEBRTC_ARGS : []),
      ],
    });
  }

  // Write the raw token into localStorage so Discord logs in with it. Used only
  // for a fresh profile or when a resumed session has expired.
  async _injectToken(page, token) {
    await page.evaluate(tk => {
      let ls = window.localStorage;
      if (!ls) {
        const iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        ls = iframe.contentWindow.localStorage;
      }
      ls.setItem('token', JSON.stringify(tk));
    }, token.trim());
  }

  _closeIdleBrowsers() {
    if (this.accounts.some(a => a._running || a._context)) return;
    for (const key of Object.keys(this._browsers)) {
      const b = this._browsers[key];
      this._browsers[key] = null;
      if (b) { try { b.close(); } catch (_) {} }
    }
  }

  async start(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    if (acc._running || acc.status === 'running' || acc.status === 'starting') return;
    this._push(acc, { status: 'starting', message: '', needsCaptcha: false,
                      desktopHint: false, quests: [], skipped: [] });
    acc._desktopHintShown = false;
    this._run(acc).catch(e => {
      this._push(acc, { status: 'error', message: e.message });
    });
  }

  async stop(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) return;
    // Never leave a stopped account holding the verification lane.
    if (this._verifyCurrent && this._verifyCurrent.acc.id === acc.id) {
      try { this.resolveVerification(acc.id, false); } catch (_) {}
    }
    this._verifyQueue = this._verifyQueue.filter((e) => {
      if (e.acc.id !== acc.id) return true;
      e.resolve({ ok: false, reason: 'stopped' });
      return false;
    });
    this._push(acc, { verifyState: null, verifyReason: null });

    const ctx = acc._context;
    acc._context = null;
    if (ctx) {
      // Keep whatever verification this session already passed.
      await this._saveSession(acc, ctx, acc.profileDir || profileDirFor(acc.token));
      try { await ctx.close(); } catch (_) {}
    }
    this._push(acc, { status: 'stopped', message: 'Stopped manually' });
  }

  async startAll() {
    const queue = this.accounts.filter(a =>
      !a._running && !['running', 'starting', 'done'].includes(a.status));
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const acc = queue[idx++];
        this._push(acc, { status: 'starting', message: '', needsCaptcha: false, quests: [] });
        try { await this._run(acc); }
        catch (e) { this._push(acc, { status: 'error', message: e.message }); }
      }
    };
    const workers = Array.from(
      { length: Math.min(this.concurrency, queue.length) }, worker
    );
    await Promise.all(workers);
  }

  async stopAll() {
    await Promise.all(this.accounts.map(a => this.stop(a.id)));
    for (const key of Object.keys(this._browsers)) {
      const b = this._browsers[key];
      this._browsers[key] = null;
      if (b) { try { await b.close(); } catch (_) {} }
    }
    await closeBridges().catch(() => {});
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(50, parseInt(n, 10) || 5));
    this.emit('update');
  }

  setHeadless(v) {
    this.headless = !!v;
    this._closeIdleBrowsers();
    this.emit('update');
  }

  setDesktopMode(v) {
    this.desktopMode = !!v;
    this.emit('update');
  }

  setOnlyOrbs(v) {
    this.onlyOrbs = !!v;
    this.emit('update');
  }

  async _run(acc) {
    if (acc._running) return;
    acc._running = true;

    try {
      await this._runInner(acc);
    } finally {
      acc._running = false;
    }
  }

  async _runInner(acc) {
    const proxy = acc.proxy;
    await this._resolveScheme(proxy);

    const profileDir = acc.profileDir || profileDirFor(acc.token);
    const fp = acc.fingerprint || fingerprintFor(acc.token);

    const context = await this._openProfile(acc, proxy, profileDir);
    acc._context = context;

    // Line the JS-visible fingerprint up with the context options before any
    // Discord script runs.
    try { await context.addInitScript(initScript(fp)); } catch (_) {}

    try {
      if (proxy) {
        this._push(acc, { message: `Connecting through ${proxy.label}…` });
        try {
          const res = await context.request.get(PROXY_CHECK_URL, { timeout: 20000 });
          if (!res.ok()) throw new Error('HTTP ' + res.status());
          const ip = (await res.json()).ip;
          this._push(acc, { proxyIp: ip, proxyError: null });
          this._history[acc.id] = { ...(this._history[acc.id] ?? {}), proxyIp: ip };
          this._log(acc, `Proxy ${proxy.label} – exit IP ${ip}`);
        } catch (e) {
          const why = proxyError(e, proxy);
          this._push(acc, { proxyIp: null, proxyError: why });
          this._log(acc, `Proxy ${proxy.label} did not respond: ${why}`);
          throw new Error(`Proxy ${proxy.label} is not reachable: ${why}`);
        }
      }

      if (this.desktopMode) {
        await context.route('**/api/v*/**', async (route) => {
          try {
            const headers = { ...route.request().headers() };
            const patched = toDesktopSuperProperties(headers['x-super-properties']);
            if (patched) headers['x-super-properties'] = patched;
            headers['user-agent'] = ELECTRON_UA;
            await route.continue({ headers });
          } catch (_) {
            try { await route.continue(); } catch (_) {}
          }
        });
      }

      this._push(acc, { message: 'Checking the account…' });
      await this._fetchIdentity(acc, context);

      // A persistent profile already has a page open; reuse it so the profile's
      // cookies and storage stay attached to the same browsing context.
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(0);
      page.on('dialog', d => d.dismiss().catch(() => {}));

      await page.exposeFunction('__questReport', (ev) => this._onReport(acc, ev));

      // Page → queue → you. The injected script calls this when Discord demands
      // a CAPTCHA (to enroll or to claim); it resolves once you confirm in the
      // panel, and only one account holds the lane at a time.
      await page.exposeFunction('__questAwaitVerify', async (questId, reason) => {
        const { ok } = await this._enterVerifyQueue(acc, reason || 'Verification required');
        return !!ok;
      });

      this._push(acc, { status: 'running', message: 'Opening Discord…' });

      await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });

      // Reuse the stored session when the profile still holds one; only fall
      // back to the raw token when there is nothing to resume.
      const hadSession = await page.evaluate(() => {
        try { return !!(window.localStorage && window.localStorage.getItem('token')); }
        catch (_) { return false; }
      });

      if (hadSession) {
        this._log(acc, 'Resuming the saved session from this profile (no token login)');
      } else {
        this._log(acc, 'No stored session in this profile – signing in with the token once');
        await this._injectToken(page, acc.token);
      }

      this._push(acc, { message: 'Loading Discord…' });
      await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded' });

      // A resumed session can be expired – Discord then bounces back to /login.
      // Detect that and log in with the token once, rather than silently sitting
      // on the login page and reporting "no quests".
      if (hadSession && /\/login/.test(page.url())) {
        this._log(acc, 'Saved session has expired – signing in with the token');
        await this._injectToken(page, acc.token);
        await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded' });
      }

      await page.waitForFunction(() => !!window.webpackChunkdiscord_app);
      await page.waitForTimeout(12000);

      this._push(acc, { message: 'Looking for quests…' });
      await page.evaluate(o => { window.__questOpts = o; }, { onlyOrbs: this.onlyOrbs });
      const result = await page.evaluate(INJECT_SCRIPT);

      if (result?.fatal) {
        this._push(acc, { status: 'error', message: result.fatal });
      } else if (acc.status === 'running') {
        this._push(acc, { status: 'done', message: 'Finished' });
      }
    } finally {
      // Save unconditionally, before closing. The runs worth persisting are the
      // ones that did NOT finish cleanly – a CAPTCHA you just solved by hand, or
      // an account stopped mid-quest. Saving only on success threw exactly those
      // sessions away and asked for the CAPTCHA again on the next run.
      await this._saveSession(acc, context, profileDir);
      if (acc._context === context) {
        acc._context = null;
        try { await context.close(); } catch (_) {}
      }
      this._saveState();
    }
  }

  async _saveSession(acc, context, profileDir) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      await context.storageState({ path: path.join(profileDir, 'state.json') });
    } catch (_) {}
  }

  _onReport(acc, ev) {
    if (!ev || typeof ev !== 'object') return;

    switch (ev.t) {
      case 'log':
        this._log(acc, ev.m);
        break;

      case 'user':
        this._setIdentity(acc, {
          username: ev.username,
          globalName: ev.globalName ?? null,
          discordId: ev.id ?? null,
          avatar: ev.avatar ?? null,
          email: ev.email ?? null,
        });
        break;

      case 'skipped':
        acc.skipped = (ev.list ?? []).map(q => ({ ...q, state: 'skipped' }));
        this.emit('update');
        break;

      case 'quests':
        {
          const prev = new Map(acc.quests.map(q => [q.id, q]));
          acc.quests = (ev.list ?? []).map(q => {
            const old = prev.get(q.id);
            return old && old.state === 'done' ? old : { ...q, state: 'pending' };
          });
        }
        this._push(acc, {
          message: `${ev.pending} quest(s) to do (out of ${ev.total} visible)`,
        });
        break;

      case 'qstart': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) Object.assign(q, { state: 'running', done: ev.done, target: ev.target,
                                  error: null });
        this._push(acc, { message: 'In progress: ' + ev.name });
        break;
      }

      case 'qprog': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) Object.assign(q, { done: ev.done, target: ev.target, state: 'running' });
        this.emit('update');
        break;
      }

      case 'qdone': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'done'; q.done = q.target; }
        acc.questsDone += 1;
        acc.orbs += ev.orbs || 0;
        this.totals.questsCompleted += 1;
        this.totals.orbsEarned += ev.orbs || 0;
        this._history[acc.id] = {
          ...(this._history[acc.id] ?? {}),
          questsDone: acc.questsDone,
          orbs: acc.orbs,
        };
        this._saveState();
        this._log(acc, 'Quest completed' + (ev.orbs ? ` (+${ev.orbs} orbs)` : ''));
        break;
      }

      case 'qclaim': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) q.claimState = ev.state;
        const msg = {
          claimed: ev.already ? 'Reward already claimed' : 'Reward claimed',
          captcha: 'Reward needs verification – solve it in the browser',
          'captcha-again': 'Reward still needs verification',
          unclaimed: 'Reward left unclaimed (verification skipped)',
          error: 'Could not claim reward: ' + (ev.err || 'unknown'),
        }[ev.state] || ('claim: ' + ev.state);
        this._log(acc, msg + (q ? ` – ${q.name}` : ''));
        this.emit('update');
        break;
      }

      case 'qretry': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) {
          q.state = 'waiting';
          q.error = ev.err;
          q.attempt = ev.attempt;
          q.maxAttempts = ev.max;
          q.rateLimited = !!ev.rateLimited;
        }
        this.emit('update');
        break;
      }

      case 'qerr': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'error'; q.error = ev.err; }
        // The injected script drives the verification queue itself (via
        // __questAwaitVerify) and will retry, so here we only flag it.
        if (ev.captcha) this._push(acc, { needsCaptcha: true });
        this._log(acc, 'Error: ' + ev.err);

        const isGameTask = q && ['PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP'].includes(q.task);
        const unauthorized = /autoryz|unauthorized|401/i.test(String(ev.err));
        if (isGameTask && unauthorized && !this.desktopMode && !acc._desktopHintShown) {
          acc._desktopHintShown = true;
          this._push(acc, { desktopHint: true });
          this._log(acc, 'Hint: enable "Desktop mode" above and restart – '
            + 'without it Discord will not track game-type quests.');
        }
        break;
      }

      case 'finished':
        this._push(acc, { status: 'done', message: 'Finished' });
        break;
    }
  }
}

module.exports = { Engine };
