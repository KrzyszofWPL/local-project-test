/**
 * Silnik zarządzający kontami Discord.
 *
 * Trzyma stan każdego konta w pamięci, uruchamia/zatrzymuje je niezależnie,
 * a postęp z wstrzykniętego skryptu odbiera na żywo przez exposeFunction.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const INJECT_SCRIPT = require('./inject.js');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const STATE_FILE = path.join(__dirname, 'state.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36';

const CLIENT_VERSION = '1.0.9165';
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) discord/' + CLIENT_VERSION
  + ' Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

/**
 * Podmienia w nagłówku X-Super-Properties wyłącznie pola opisujące typ
 * klienta, zachowując resztę – przede wszystkim client_build_number.
 *
 * Budowanie tego nagłówka od zera jest pułapką: przy nieaktualnym numerze
 * builda Discord przestaje zwracać jakiekolwiek questy.
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
    ...props,                       // client_build_number itd. zostają aktualne
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

class Engine extends EventEmitter {
  constructor() {
    super();
    this.accounts = [];
    this.browser = null;
    this.concurrency = parseInt(process.env.CONCURRENCY || '5', 10);
    this.headless = process.env.HEADLESS !== 'false';
    this.desktopMode = process.env.DESKTOP_MODE === 'true';
    this.onlyOrbs = process.env.ONLY_ORBS !== 'false';
    this.totals = { questsCompleted: 0, orbsEarned: 0 };
    this._loadState();
    this.loadTokens();
  }

  // ── Trwały stan (sumy narastające między uruchomieniami) ──────────────────
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

  // ── Tokeny ────────────────────────────────────────────────────────────────
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
        status: 'idle',          // idle | starting | running | done | error | stopped
        message: '',
        quests: [],              // { id, name, task, target, done, orbs, state }
        questsDone: prev.questsDone ?? 0,
        orbs: prev.orbs ?? 0,
        logs: [],
        needsCaptcha: false,
        _context: null,
      };
    });
    this.emit('update');
  }

  // ── Widok dla panelu (bez tokenów i uchwytów przeglądarki) ────────────────
  snapshot() {
    return {
      totals: this.totals,
      concurrency: this.concurrency,
      headless: this.headless,
      desktopMode: this.desktopMode,
      onlyOrbs: this.onlyOrbs,
      accounts: this.accounts.map(a => {
        const target = a.quests.reduce((s, q) => s + (q.target || 0), 0);
        const done = a.quests.reduce((s, q) => s + Math.min(q.done || 0, q.target || 0), 0);
        return {
          id: a.id,
          label: a.label,
          username: a.username,
          status: a.status,
          message: a.message,
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

  // ── Przeglądarka współdzielona ────────────────────────────────────────────
  async _ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;

    // Import dopiero tutaj – panel ma działać nawet zanim playwright zostanie
    // zainstalowany, żeby dało się zobaczyć czytelny komunikat zamiast crasha.
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (_) {
      throw new Error('Playwright nie jest zainstalowany. Uruchom: pnpm install');
    }

    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--disable-background-networking',
        '--disable-default-apps', '--disable-extensions', '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    return this.browser;
  }

  // ── Sterowanie ────────────────────────────────────────────────────────────
  async start(id) {
    const acc = this.accounts.find(a => a.id === String(id));
    if (!acc) throw new Error('Nie ma konta ' + id);
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
    this._push(acc, { status: 'stopped', message: 'Zatrzymane ręcznie' });
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
    if (this.browser) { try { await this.browser.close(); } catch (_) {} this.browser = null; }
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(50, parseInt(n, 10) || 5));
    this.emit('update');
  }

  setHeadless(v) {
    this.headless = !!v;
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

  // ── Właściwa praca dla jednego konta ──────────────────────────────────────
  async _run(acc) {
    // Jedyna prawdziwa blokada: status w panelu moze byc nieaktualny przez
    // wyscig miedzy /api/start a /api/start-all, wiec pilnujemy tego tutaj.
    if (acc._running) return;
    acc._running = true;

    try {
      await this._runInner(acc);
    } finally {
      acc._running = false;
    }
  }

  async _runInner(acc) {
    const browser = await this._ensureBrowser();

    // Trwały profil = CAPTCHA rozwiązana raz zostaje rozwiązana
    const profileDir = path.join(PROFILES_DIR, acc.id);
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await browser.newContext({
      // Discord odrzuca heartbeaty questow-gier bledem 401, jesli User-Agent
      // nie zawiera wersji Electrona. To sam naglowek decyduje, nie tylko
      // X-Super-Properties.
      userAgent: this.desktopMode ? ELECTRON_UA : UA,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      viewport: { width: 1280, height: 800 },
      storageState: fs.existsSync(path.join(profileDir, 'state.json'))
        ? path.join(profileDir, 'state.json')
        : undefined,
    });
    acc._context = context;

    // Tryb desktop: podszywa sesję pod klienta desktopowego, co jest warunkiem
    // naliczania questów PLAY_ON_DESKTOP. Domyślnie wyłączony, bo ingeruje
    // w nagłówki, od których zależy też samo pobranie listy questów.
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

    // Odbiór raportów z wstrzykniętego skryptu
    await page.exposeFunction('__questReport', (ev) => this._onReport(acc, ev));

    try {
      this._push(acc, { status: 'running', message: 'Logowanie…' });

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

      this._push(acc, { message: 'Ładowanie Discorda…' });
      await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.webpackChunkdiscord_app);
      await page.waitForTimeout(12000);

      this._push(acc, { message: 'Szukanie questów…' });
      await page.evaluate(o => { window.__questOpts = o; }, { onlyOrbs: this.onlyOrbs });
      const result = await page.evaluate(INJECT_SCRIPT);

      // Zapisz sesję, żeby kolejny start nie wymagał ponownej weryfikacji
      try { await context.storageState({ path: path.join(profileDir, 'state.json') }); } catch (_) {}

      if (result?.fatal) {
        this._push(acc, { status: 'error', message: result.fatal });
      } else if (acc.status === 'running') {
        this._push(acc, { status: 'done', message: 'Zakończone' });
      }
    } finally {
      if (acc._context === context) {
        acc._context = null;
        try { await context.close(); } catch (_) {}
      }
      this._saveState();
    }
  }

  // ── Zdarzenia z przeglądarki ──────────────────────────────────────────────
  _onReport(acc, ev) {
    if (!ev || typeof ev !== 'object') return;

    switch (ev.t) {
      case 'log':
        this._log(acc, ev.m);
        break;

      case 'user':
        this._push(acc, { username: ev.username });
        this._history[acc.id] = { ...(this._history[acc.id] ?? {}), username: ev.username };
        break;

      case 'skipped':
        acc.skipped = (ev.list ?? []).map(q => ({ ...q, state: 'skipped' }));
        this.emit('update');
        break;

      case 'quests':
        // Zachowaj stan questow juz ukonczonych w tej sesji
        {
          const prev = new Map(acc.quests.map(q => [q.id, q]));
          acc.quests = (ev.list ?? []).map(q => {
            const old = prev.get(q.id);
            return old && old.state === 'done' ? old : { ...q, state: 'pending' };
          });
        }
        this._push(acc, {
          message: `${ev.pending} questów do zrobienia (z ${ev.total} widocznych)`,
        });
        break;

      case 'qstart': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) Object.assign(q, { state: 'running', done: ev.done, target: ev.target });
        this._push(acc, { message: 'W trakcie: ' + ev.name });
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
        this._log(acc, 'Ukończono quest' + (ev.orbs ? ` (+${ev.orbs} orbs)` : ''));
        break;
      }

      case 'qretry': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'waiting'; q.error = ev.err; }
        this._log(acc, 'Limit zapytań – ponowię za chwilę');
        break;
      }

      case 'qerr': {
        const q = acc.quests.find(x => x.id === ev.id);
        if (q) { q.state = 'error'; q.error = ev.err; }
        if (ev.captcha) this._push(acc, { needsCaptcha: true });
        this._log(acc, 'Błąd: ' + ev.err);

        // Discord odmawia naliczania questów typu gra klientowi webowemu.
        // Tryb desktop podszywa sesję pod aplikację i jest jedyną szansą,
        // żeby te questy w ogóle ruszyły – warto o nim przypomnieć.
        const isGameTask = q && ['PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP'].includes(q.task);
        const unauthorized = /autoryz|unauthorized|401/i.test(String(ev.err));
        if (isGameTask && unauthorized && !this.desktopMode && !acc._desktopHintShown) {
          acc._desktopHintShown = true;
          this._push(acc, { desktopHint: true });
          this._log(acc, 'Wskazówka: włącz „Tryb desktop” u góry i uruchom ponownie – '
            + 'bez niego Discord nie nalicza questów typu gra.');
        }
        break;
      }

      case 'finished':
        this._push(acc, { status: 'done', message: 'Zakończone' });
        break;
    }
  }
}

module.exports = { Engine };
