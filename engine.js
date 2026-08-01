/**
 * Engine that manages Discord accounts.
 *
 * Keeps each account's state in memory, starts/stops accounts independently,
 * and receives live progress from the injected script through exposeFunction.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const INJECT_SCRIPT = require('./inject.js');
const { loadProxies, proxyUrl, PROXY_FILE } = require('./proxies.js');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const STATE_FILE = path.join(__dirname, 'state.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36';

const CLIENT_VERSION = '1.0.9165';
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) discord/' + CLIENT_VERSION
  + ' Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

/**
 * Replaces only the client-identity fields in the X-Super-Properties header,
 * keeping everything else intact – most importantly client_build_number.
 *
 * Building this header from scratch is a trap: with a stale build number
 * Discord stops returning any quests at all.
 */
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
    ...props,                       // client_build_number etc. stay current
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

/**
 * Playwright errors carry a multi-line call log and ANSI colours – neither
 * belongs in a toast or a log line.
 */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function shortError(e) {
  return String(e && e.message ? e.message : e)
    .replace(ANSI, '')
    .split('\n')[0]
    .trim();
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.accounts = [];
    // One browser process per proxy mode: Chromium only honours a
    // per-context proxy when the browser itself was launched with one.
    this._browsers = { plain: null, proxied: null };
    this.concurrency = parseInt(process.env.CONCURRENCY || '5', 10);
    this.headless = process.env.HEADLESS !== 'false';
    this.desktopMode = process.env.DESKTOP_MODE === 'true';
    this.onlyOrbs = process.env.ONLY_ORBS !== 'false';
    this.useProxies = process.env.USE_PROXIES !== 'false';
    this.totals = { questsCompleted: 0, orbsEarned: 0 };
    this.proxyList = { file: PROXY_FILE, exists: false, proxies: [], errors: [] };
    this._loadState();
    this.loadProxies();
    this.loadTokens();
  }

  // ── Persistent state (running totals across restarts) ──────────────────────
  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      this.totals = { questsCompleted: 0, orbsEarned: 0, ...s.totals };
      this._history = s.history ?? {};
    } catch (_) {
      this._history = {};
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        totals: this.totals,
        history: this._history,
      }, null, 2));
    } catch (_) {}
  }

  // ── Tokens ───────────────────────────────────────────────────────────────
  loadTokens() {
    let tokens = [];
    try {
      tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
        .split('\n').map(t => t.trim()).filter(Boolean);
    } catch (_) {}

    this.accounts = tokens.map((token, i) => {
      const id = String(i);
      const prev = this._history[id] ?? {};
      return {
        id,
        token,
        label: token.substring(0, 14) + '…',
        username: prev.username ?? null,
        globalName: prev.globalName ?? null,
        discordId: prev.discordId ?? null,
        avatar: prev.avatar ?? null,
        email: prev.email ?? null,
        status: 'idle',          // idle | starting | running | done | error | stopped
        message: '',
        quests: [],              // { id, name, task, target, done, orbs, state }
        questsDone: prev.questsDone ?? 0,
        orbs: prev.orbs ?? 0,
        logs: [],
        needsCaptcha: false,
        proxy: null,             // filled in by _assignProxies()
        proxyIp: prev.proxyIp ?? null,
        proxyError: null,
        _context: null,
      };
    });
    this._assignProxies();
    this.emit('update');
  }

  /** Full token for a given account id – used only by the copy-token action. */
  getToken(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    return acc.token;
  }

  // ── Proxies ──────────────────────────────────────────────────────────────
  loadProxies() {
    this.proxyList = loadProxies();
    this._assignProxies();
    this.emit('update');
  }

  /**
   * Account #n gets proxy #n. With fewer proxies than accounts the list wraps
   * around – accounts then share an exit IP, which is exactly what the panel
   * warns about, since avoiding that is the whole point of the feature.
   */
  _assignProxies() {
    const list = this.proxyList.proxies;
    const on = this.useProxies && list.length > 0;
    this.accounts.forEach((acc, i) => {
      const next = on ? list[i % list.length] : null;
      // A different proxy means the previously measured exit IP is stale.
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

  /** Full proxy URL (with credentials) for one account – copy action only. */
  getProxyUrl(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    if (!acc.proxy) throw new Error('No proxy assigned to this account');
    return proxyUrl(acc.proxy);
  }

  /** Sends one request through the account's proxy and reports the exit IP. */
  async testProxy(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('No such account: ' + id);
    if (!acc.proxy) throw new Error('No proxy assigned to this account');

    let request;
    try {
      ({ request } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright is not installed. Run: npm install');
    }

    const ctx = await request.newContext({
      proxy: {
        server: acc.proxy.server,
        username: acc.proxy.username ?? undefined,
        password: acc.proxy.password ?? undefined,
      },
      timeout: 20000,
      ignoreHTTPSErrors: true,
    });
    try {
      const res = await ctx.get('https://api.ipify.org?format=json');
      if (!res.ok()) throw new Error('proxy answered with HTTP ' + res.status());
      const ip = (await res.json()).ip;
      this._push(acc, { proxyIp: ip, proxyError: null });
      this._log(acc, `Proxy ${acc.proxy.label} works – exit IP ${ip}`);
      return ip;
    } catch (e) {
      const why = shortError(e);
      this._push(acc, { proxyIp: null, proxyError: why });
      this._log(acc, `Proxy ${acc.proxy.label} failed: ${why}`);
      throw new Error(why);
    } finally {
      try { await ctx.dispose(); } catch (_) {}
    }
  }

  // ── View for the panel (no tokens or browser handles) ──────────────────────
  snapshot() {
    return {
      totals: this.totals,
      concurrency: this.concurrency,
      headless: this.headless,
      desktopMode: this.desktopMode,
      onlyOrbs: this.onlyOrbs,
      proxies: {
        enabled: this.useProxies,
        count: this.proxyList.proxies.length,
        fileExists: this.proxyList.exists,
        fileName: path.basename(this.proxyList.file),
        errors: this.proxyList.errors,
        // Distinct exit IPs would be ideal; distinct entries is what we can
        // know without dialing every proxy.
        shared: this.useProxies && this.proxyList.proxies.length > 0
          && this.accounts.length > this.proxyList.proxies.length,
      },
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
          // Label only – the panel never receives proxy credentials.
          proxy: a.proxy ? { label: a.proxy.label, scheme: a.proxy.scheme, auth: a.proxy.auth } : null,
          proxyIp: a.proxyIp,
          proxyError: a.proxyError,
          needsCaptcha: a.needsCaptcha,
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

  _log(acc, msg) {
    acc.logs.push({ ts: Date.now(), msg: String(msg) });
    if (acc.logs.length > 300) acc.logs.shift();
    this.emit('update');
  }

  // ── Shared browsers ─────────────────────────────────────────────────────
  /**
   * Chromium ignores a per-context proxy unless the browser was launched with
   * one, so proxied and direct accounts get separate browser processes. The
   * launch-level server is a placeholder – every context overrides it.
   */
  async _ensureBrowser(proxied) {
    const key = proxied ? 'proxied' : 'plain';
    const current = this._browsers[key];
    if (current && current.isConnected()) return current;

    // Import lazily – the panel should still run even before playwright is
    // installed, so it can show a readable message instead of crashing.
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright is not installed. Run: npm install');
    }

    const browser = await chromium.launch({
      headless: this.headless,
      proxy: proxied ? { server: 'http://per-context' } : undefined,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--disable-background-networking',
        '--disable-default-apps', '--disable-extensions', '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    this._browsers[key] = browser;
    return browser;
  }

  /**
   * Settings like headless or the proxy toggle only take effect on launch, so
   * drop idle browsers to let the next start pick the new settings up.
   */
  _closeIdleBrowsers() {
    if (this.accounts.some(a => a._running || a._context)) return;
    for (const key of Object.keys(this._browsers)) {
      const b = this._browsers[key];
      this._browsers[key] = null;
      if (b) { try { b.close(); } catch (_) {} }
    }
  }

  // ── Control ──────────────────────────────────────────────────────────────
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
    const ctx = acc._context;
    acc._context = null;
    if (ctx) { try { await ctx.close(); } catch (_) {} }
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

  // ── Actual work for one account ─────────────────────────────────────────
  async _run(acc) {
    // The only real guard: the panel's status can be stale due to a race
    // between /api/start and /api/start-all, so we check again here.
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
    const browser = await this._ensureBrowser(!!proxy);

    // Persistent profile = a CAPTCHA solved once stays solved
    const profileDir = path.join(PROFILES_DIR, acc.id);
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await browser.newContext({
      // Discord rejects game-quest heartbeats with 401 unless the User-Agent
      // contains an Electron version. The header itself decides this, not
      // just X-Super-Properties.
      userAgent: this.desktopMode ? ELECTRON_UA : UA,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      viewport: { width: 1280, height: 800 },
      // Every account leaves through its own IP – this is what keeps Discord
      // from rate limiting (429) the whole batch at once.
      proxy: proxy ? {
        server: proxy.server,
        username: proxy.username ?? undefined,
        password: proxy.password ?? undefined,
      } : undefined,
      storageState: fs.existsSync(path.join(profileDir, 'state.json'))
        ? path.join(profileDir, 'state.json')
        : undefined,
    });
    acc._context = context;

    try {
      // Confirm the exit IP before touching Discord: a dead proxy should be
      // reported as such instead of looking like a login failure.
      if (proxy) {
        this._push(acc, { message: `Connecting through ${proxy.label}…` });
        try {
          const res = await context.request.get('https://api.ipify.org?format=json',
            { timeout: 20000 });
          if (!res.ok()) throw new Error('HTTP ' + res.status());
          const ip = (await res.json()).ip;
          this._push(acc, { proxyIp: ip, proxyError: null });
          this._history[acc.id] = { ...(this._history[acc.id] ?? {}), proxyIp: ip };
          this._log(acc, `Proxy ${proxy.label} – exit IP ${ip}`);
        } catch (e) {
          const why = shortError(e);
          this._push(acc, { proxyIp: null, proxyError: why });
          this._log(acc, `Proxy ${proxy.label} did not respond: ${why}`);
          throw new Error(`Proxy ${proxy.label} is not reachable: ${why}`);
        }
      }

      // Desktop mode: spoofs the session as the desktop client, which is a
      // prerequisite for PLAY_ON_DESKTOP quests to accrue. Off by default
      // because it touches the headers that fetching the quest list itself
      // depends on.
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

      const page = await context.newPage();
      page.setDefaultTimeout(0);
      page.on('dialog', d => d.dismiss().catch(() => {}));

      // Receive reports from the injected script
      await page.exposeFunction('__questReport', (ev) => this._onReport(acc, ev));

      this._push(acc, { status: 'running', message: 'Logging in…' });

      await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
      await page.evaluate(tk => {
        let ls = window.localStorage;
        if (!ls) {
          const iframe = document.createElement('iframe');
          document.body.appendChild(iframe);
          ls = iframe.contentWindow.localStorage;
        }
        ls.setItem('token', JSON.stringify(tk));
      }, acc.token.trim());

      this._push(acc, { message: 'Loading Discord…' });
      await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.webpackChunkdiscord_app);
      await page.waitForTimeout(12000);

      this._push(acc, { message: 'Looking for quests…' });
      await page.evaluate(o => { window.__questOpts = o; }, { onlyOrbs: this.onlyOrbs });
      const result = await page.evaluate(INJECT_SCRIPT);

      // Save the session so the next start doesn't need re-verification
      try { await context.storageState({ path: path.join(profileDir, 'state.json') }); } catch (_) {}

      if (result?.fatal) {
        this._push(acc, { status: 'error', message: result.fatal });
      } else if (acc.status === 'running') {
        this._push(acc, { status: 'done', message: 'Finished' });
      }
    } finally {
      if (acc._context === context) {
        acc._context = null;
        try { await context.close(); } catch (_) {}
      }
      this._saveState();
    }
  }

  // ── Events from the browser ──────────────────────────────────────────────
  _onReport(acc, ev) {
    if (!ev || typeof ev !== 'object') return;

    switch (ev.t) {
      case 'log':
        this._log(acc, ev.m);
        break;

      case 'user':
        this._push(acc, {
          username: ev.username,
          globalName: ev.globalName ?? null,
          discordId: ev.id ?? null,
          avatar: ev.avatar ?? null,
          email: ev.email ?? null,
        });
        this._history[acc.id] = {
          ...(this._history[acc.id] ?? {}),
          username: ev.username,
          globalName: ev.globalName ?? null,
          discordId: ev.id ?? null,
          avatar: ev.avatar ?? null,
          email: ev.email ?? null,
        };
        this._saveState();
        break;

      case 'skipped':
        acc.skipped = (ev.list ?? []).map(q => ({ ...q, state: 'skipped' }));
        this.emit('update');
        break;

      case 'quests':
        // Preserve the state of quests already completed in this session
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
        if (q) Object.assign(q, { state: 'running', done: ev.done, target: ev.target });
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

      case 'qretry': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'waiting'; q.error = ev.err; }
        this._log(acc, 'Rate limited – will retry shortly');
        break;
      }

      case 'qerr': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'error'; q.error = ev.err; }
        if (ev.captcha) this._push(acc, { needsCaptcha: true });
        this._log(acc, 'Error: ' + ev.err);

        // Discord refuses to track game-type quests for the web client.
        // Desktop mode spoofs the session as the app and is the only way
        // to get these quests moving at all – worth flagging it.
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
