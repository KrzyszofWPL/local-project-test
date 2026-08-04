module.exports = `(async () => {
  // Second layer of protection against double injection
  if (window.__questBotActive) return { fatal: 'script already running in this tab' };
  window.__questBotActive = true;

  // ─────────────────────────────────────────────────────────────────────────
  // WERSJA SKRYPTU - podnies przy KAZDEJ zmianie w tym pliku.
  // Wypisywana jako pierwsza linia logu: jesli w panelu widzisz stary numer,
  // proces node'a trzyma poprzedni inject.js w cache require() i trzeba go
  // zrestartowac (samo Stop/Start w UI nie przeladowuje tego pliku).
  const VERSION = 'v2.4';
  // ─────────────────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const R = (o) => { try { window.__questReport(o); } catch(_) {} };
  const log = m => R({ t: 'log', m: String(m) });

  // Szczegolowy log. Domyslnie wlaczony; wylaczyc przez QUEST_DEBUG=false.
  const DEBUG = window.__questDebug !== false;
  const dbg = m => { if (DEBUG) R({ t: 'log', m: '  · ' + String(m) }); };

  R({ t: 'version', version: VERSION });
  log('══ inject ' + VERSION + ' start ══ ' + new Date().toISOString()
      + ' | debug=' + (DEBUG ? 'on' : 'off'));
  dbg('URL: ' + location.href);
  dbg('UA: ' + navigator.userAgent);

  // ── Podsluch naglowkow ────────────────────────────────────────────────────
  // Klient Discorda dokleja do kazdego zadania zestaw naglowkow (autoryzacja,
  // odcisk klienta, strefa czasowa). Goly fetch ich nie ma, wiec podgladamy je
  // na prawdziwych zadaniach i doklejamy do wlasnych. Instalujemy to JAK
  // NAJWCZESNIEJ, zanim zaczniemy cokolwiek wysylac.
  const seenHeaders = {};
  const WANTED = ['authorization', 'x-super-properties', 'x-discord-locale',
                  'x-discord-timezone', 'x-debug-options'];

  const noteHeader = (url, k, v) => {
    try {
      if (String(url || '').indexOf('/api/') === -1) return;
      const key = String(k).toLowerCase();
      if (WANTED.indexOf(key) !== -1 && v) seenHeaders[key] = String(v);
    } catch(_) {}
  };

  try {
    const xopen = XMLHttpRequest.prototype.open;
    const xset = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(m, u) {
      try { this.__qUrl = u; } catch(_) {}
      return xopen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
      noteHeader(this && this.__qUrl, k, v);
      return xset.apply(this, arguments);
    };
  } catch(_) {}

  try {
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url);
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof h.forEach === 'function') h.forEach((v, k) => noteHeader(url, k, v));
          else for (const k of Object.keys(h)) noteHeader(url, k, h[k]);
        }
      } catch(_) {}
      return origFetch.apply(this, arguments);
    };
  } catch(_) {}

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

  // Ktore moduly znalezione, a ktore nie - brakujacy store tlumaczy pozniejsze
  // "not found" przy konkretnych typach zadan, zamiast zostawiac to w domysle.
  dbg('moduły: ' + [
    ['QuestsStore', QuestsStore], ['api', api], ['UserStore', UserStore],
    ['RunningGameStore', RunningGameStore], ['FluxDispatcher', FluxDispatcher],
    ['ChannelStore', ChannelStore], ['GuildChannelStore', GuildChannelStore],
    ['ApplicationStreamingStore', ApplicationStreamingStore],
  ].map(p => p[0] + '=' + (p[1] ? 'ok' : 'BRAK')).join(' '));
  dbg('modułów w webpacku: ' + mods.length);

  // ── API call layer ────────────────────────────────────────────────────────
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + (ms/1000) + 's: ' + label)), ms)),
  ]);

  // Discord przy 400 (50035 Invalid Form Body) podaje w body.errors DOKLADNIE
  // to pole, ktore mu sie nie podoba. Bez tego widac tylko "Nieprawidlowa tresc
  // formularza" i nie da sie zgadnac, czego brakuje.
  const formErrors = (e) => {
    const errs = e && e.body && e.body.errors;
    if (!errs || typeof errs !== 'object') return '';
    const out = [];
    const walk = (node, pathStr) => {
      if (!node || typeof node !== 'object' || out.length >= 6) return;
      if (Array.isArray(node._errors)) {
        for (const x of node._errors) {
          out.push(pathStr + ': ' + ((x && (x.message || x.code)) || 'błąd'));
        }
        return;
      }
      for (const k of Object.keys(node)) {
        walk(node[k], pathStr ? pathStr + '.' + k : k);
      }
    };
    walk(errs, '');
    return out.length ? ' {' + out.join('; ') + '}' : '';
  };

  const errMsg = e => ((e && e.body && e.body.message) || (e && e.message)
    || ('HTTP ' + (e && e.status))) + formErrors(e);

  // Kompaktowy podglad obiektu do logu: dlugie wartosci (np. zapieczetowany
  // blob) skracane, zeby jeden request nie zajmowal calego panelu.
  const summarize = (o) => {
    try {
      if (o == null) return String(o);
      if (typeof o !== 'object') return String(o).slice(0, 80);
      const parts = [];
      for (const k of Object.keys(o).slice(0, 10)) {
        const v = o[k];
        let s;
        if (v == null) s = String(v);
        else if (typeof v === 'object') s = Array.isArray(v) ? '[' + v.length + ']' : '{…}';
        else s = String(v);
        if (s.length > 24) s = s.slice(0, 21) + '…(' + s.length + ')';
        parts.push(k + '=' + s);
      }
      if (Object.keys(o).length > 10) parts.push('…');
      return '{' + parts.join(' ') + '}';
    } catch(_) { return '{?}'; }
  };

  const isRateLimit = (e) => {
    if (!e) return false;
    if (e.status === 429) return true;
    return /rate limit|tempo zosta|too many requests/i.test(String(errMsg(e)));
  };

  const retryAfterMs = (e) => {
    const ra = e && e.body && (e.body.retry_after != null ? e.body.retry_after : e.body.retryAfter);
    return typeof ra === 'number' ? Math.ceil(ra * 1000) + 500 : 6000;
  };

  // ── Cooldowny ─────────────────────────────────────────────────────────────
  // Wszystkie zapisy ida przez JEDNA kolejke: nigdy dwa rownolegle requesty
  // i zawsze odstep miedzy nimi. Bez tego 13 questow wali w /claim-reward
  // w tej samej sekundzie i Discord odbija to rate limitem.
  const COOLDOWN = (window.__questCooldowns || {});
  const CD = {
    minGap:      COOLDOWN.minGap      != null ? COOLDOWN.minGap      : 1500,  // min. odstep miedzy zapisami
    jitter:      COOLDOWN.jitter      != null ? COOLDOWN.jitter      : 1200,  // losowy dodatek do odstepu
    beforeClaim: COOLDOWN.beforeClaim != null ? COOLDOWN.beforeClaim : 4000,  // pauza przed kazdym claimem
    betweenQuests: COOLDOWN.betweenQuests != null ? COOLDOWN.betweenQuests : 9000,
    afterRateLimit: COOLDOWN.afterRateLimit != null ? COOLDOWN.afterRateLimit : 2000,
  };

  let _chain = Promise.resolve();
  let _lastWrite = 0;
  let _penalty = 0;   // rosnie po kazdym 429, schodzi po udanym requescie

  // Serializacja: kolejne wywolania ustawiaja sie w ogonku jednego lancucha.
  const _serialize = (fn) => {
    const run = _chain.then(fn, fn);
    _chain = run.then(() => {}, () => {});
    return run;
  };

  const _waitTurn = async (isWrite) => {
    if (!isWrite) return;
    const gap = CD.minGap + Math.random() * CD.jitter + _penalty;
    const since = Date.now() - _lastWrite;
    if (since < gap) await sleep(Math.ceil(gap - since));
    _lastWrite = Date.now();
  };

  const apiCall = (method, url, body, label, timeoutMs) => _serialize(async () => {
    const isWrite = method !== 'GET';
    let lastErr = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      await _waitTurn(isWrite);
      const t0 = Date.now();
      dbg('→ ' + method + ' ' + url + ' [' + label + ']'
          + (attempt ? ' (próba ' + (attempt + 1) + ')' : '')
          + (isWrite && body ? ' body=' + summarize(body) : ''));
      try {
        const p = method === 'GET' ? api.get({ url: url }) : api.post({ url: url, body: body });
        const res = await withTimeout(p, timeoutMs || 30000, label);
        _penalty = Math.max(0, _penalty - 500);
        dbg('← ' + (res && res.status) + ' ' + label + ' (' + (Date.now() - t0) + 'ms)'
            + (res && res.body ? ' ' + summarize(res.body) : ''));
        return res;
      } catch(e) {
        dbg('← BŁĄD ' + label + ' po ' + (Date.now() - t0) + 'ms: '
            + (e && e.status ? '[' + e.status + '] ' : '') + errMsg(e));
        lastErr = e;
        if (isRateLimit(e) && attempt < 4) {
          // Kazdy 429 podnosi staly odstep dla WSZYSTKICH kolejnych zapisow,
          // zeby nie wpasc w ten sam limit przy nastepnym questcie.
          _penalty = Math.min(15000, _penalty + CD.afterRateLimit);
          const wait = retryAfterMs(e);
          log('rate limited (' + label + ') - czekam ' + Math.round(wait/1000)
              + 's (globalny odstep: ' + Math.round((CD.minGap + _penalty)/1000) + 's)');
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  });

  // ── Diagnostyka zawieszonych requestow ────────────────────────────────────
  // Warstwa API klienta Discorda przy captchy NIE odrzuca requestu - zawiesza
  // go i czeka, az uzytkownik rozwiaze modal. Bez przegladarkowego usera taki
  // request wisi w nieskonczonosc i widac tylko nasz timeout. Trzeba odroznic
  // ten przypadek od zwyklego problemu sieciowego (np. wolne SOCKS5).
  const captchaVisible = () => {
    try {
      const sel = 'iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"],'
                + ' [class*="captcha" i], [id*="captcha" i]';
      return !!document.querySelector(sel);
    } catch(_) { return false; }
  };

  // Discord usuwa window.localStorage, zeby utrudnic czytanie tokenu.
  // Ta sama sztuczka co w engine.js: swiezy iframe ma wlasny, nietkniety obiekt.
  const readToken = () => {
    try {
      let ls = window.localStorage;
      if (!ls) {
        const f = document.createElement('iframe');
        document.body.appendChild(f);
        ls = f.contentWindow.localStorage;
        f.remove();
      }
      const raw = ls && ls.getItem('token');
      return raw ? JSON.parse(raw) : null;
    } catch(_) { return null; }
  };

  // Zapasowy POST z pominieciem modulu API Discorda - goly fetch nie da sie
  // zawiesic na modalu captchy, wiec zwraca PRAWDZIWY status i tresc bledu.
  const rawApiPost = async (path, body) => {
    const headers = { 'content-type': 'application/json' };
    for (const k of Object.keys(seenHeaders)) headers[k] = seenHeaders[k];
    if (!headers.authorization) {
      const token = readToken();
      if (!token) throw new Error('brak tokenu i brak podsłuchanej autoryzacji');
      headers.authorization = token;
    }

    dbg('→ RAW POST /api/v9' + path + ' nagłówki=' + Object.keys(headers).join(','));
    const t0 = Date.now();
    const res = await fetch('/api/v9' + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      credentials: 'include',
    });

    let parsed = null;
    let text = '';
    try {
      text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch(_) {}

    // Pelna tresc odpowiedzi - to jedyne miejsce, gdzie widac prawdziwy powod
    // odrzucenia (warstwa API klienta polyka to i zawiesza request).
    dbg('← RAW ' + res.status + ' (' + (Date.now() - t0) + 'ms) '
        + (text ? text.slice(0, 400) : '<puste ciało>'));

    return { status: res.status, body: parsed, raw: text,
             ok: res.status >= 200 && res.status < 300 };
  };

  // ── Odczyt stanu z ODPOWIEDZI SERWERA (nie z lokalnych liczników) ─────────
  const progressOf = (body, taskName) => {
    if (!body) return null;
    const sources = [
      body.progress,
      body.userStatus && body.userStatus.progress,
      body.user_status && body.user_status.progress,
    ];
    for (const p of sources) {
      if (p && p[taskName] && typeof p[taskName].value === 'number') return p[taskName].value;
    }
    return null;
  };

  const completedOf = (body) => {
    if (!body) return false;
    const sources = [body, body.userStatus, body.user_status];
    for (const s of sources) {
      if (s && (s.completed_at != null || s.completedAt != null)) return true;
    }
    return false;
  };

  // Identity
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

  if (typeof DiscordNative === 'undefined') {
    try {
      window.DiscordNative = {
        process: { platform: 'win32', arch: 'x64' },
        app: { getModuleVersions: () => ({}), getPath: () => 'C:\\\\\\\\Users' },
        os: { release: '10.0.26100' },
        window: { setDevtoolsCallbacks: () => {} },
      };
    } catch(_) {}
  }

  // ── 3. Wait for quests ────────────────────────────────────────────────────
  for (let i = 0; i < 45 && QuestsStore.quests.size === 0; i++) await sleep(1000);

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

  // Discord dokleja do listy questow zapieczetowany blob atrybucyjny, ktory
  // prawdziwy klient odsyla z powrotem przy /enroll i /claim-reward.
  // Bez niego oba requesty moga byc odrzucone - dlatego pobieramy liste ZAWSZE.
  let sealedByQuest = {};
  let sealedGlobal = null;

  const pickSealed = (o) => {
    if (!o || typeof o !== 'object') return null;
    return o.traffic_metadata_sealed || o.trafficMetadataSealed || null;
  };

  let apiQuests = [];
  try {
    const res = await apiCall('GET', '/quests/@me', null, 'quests-list');
    const body = (res && res.body) || {};
    const raw = body.quests || (Array.isArray(body) ? body : []) || [];
    const rawList = Array.isArray(raw) ? raw : [];

    sealedGlobal = pickSealed(body);
    for (const rq of rawList) {
      const s = pickSealed(rq);
      if (rq && rq.id && s) sealedByQuest[rq.id] = s;
    }
    log('Blob atrybucyjny: globalny=' + (sealedGlobal ? 'jest' : 'brak')
        + ', per-quest=' + Object.keys(sealedByQuest).length);

    if (QuestsStore.quests.size === 0) {
      apiQuests = rawList.map(camel);
      log('QuestsStore stayed empty - fetched ' + apiQuests.length + ' quest(s) from API');
    }
  } catch(e) {
    log('/quests/@me failed: ' + ((e && e.message) || e));
  }

  // Kanoniczne zrodlo bloba to rekord questa w QuestsStore (camelCase).
  // Lista z /quests/@me sluzy tylko jako zapasowe zrodlo.
  const sealedFor = (questId) => {
    try {
      const q = QuestsStore.getQuest && QuestsStore.getQuest(questId);
      const s = q && (q.trafficMetadataSealed || q.traffic_metadata_sealed);
      if (s) return s;
    } catch(_) {}
    return sealedByQuest[questId] || sealedGlobal || null;
  };

  const SUPPORTED = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];

  const rewardsOf = (q) => {
    try {
      const rc = q.config.rewardsConfig || q.config.rewards_config;
      const r = rc && rc.rewards;
      return Array.isArray(r) ? r : [];
    } catch(_) { return []; }
  };

  const orbsOf = (q) => {
    let sum = 0;
    for (const r of rewardsOf(q)) {
      const n = r.orbQuantity != null ? r.orbQuantity : r.orb_quantity;
      if (typeof n === 'number') sum += n;
    }
    return sum;
  };

  const rewardInfo = (q) => rewardsOf(q).map(r => ({
    type: r.type,
    orbs: r.orbQuantity != null ? r.orbQuantity : r.orb_quantity,
    name: (r.messages && (r.messages.name || r.messages.nameWithArticle)) || r.name || null,
  }));

  const all = apiQuests.length ? apiQuests : [...QuestsStore.quests.values()];

  dbg('źródło listy: ' + (apiQuests.length ? '/quests/@me' : 'QuestsStore')
      + ', questów łącznie: ' + all.length);

  // Zliczamy powody odrzucenia - inaczej "13 z 34" nic nie mowi.
  const rejected = { claimed: 0, expired: 0, noConfig: 0, unsupportedTask: 0 };

  const pending = all.filter(q => {
    const tc = q.config && (q.config.taskConfig || q.config.taskConfigV2);
    const isClaimed = !!(q.userStatus && q.userStatus.claimedAt);

    if (!q.config) { rejected.noConfig++; return false; }
    if (isClaimed) { rejected.claimed++; return false; }
    if (!(new Date(q.config.expiresAt).getTime() > Date.now())) { rejected.expired++; return false; }
    if (!tc || !tc.tasks || !SUPPORTED.some(t => t in tc.tasks)) {
      rejected.unsupportedTask++;
      return false;
    }
    return true;
  });

  dbg('odrzucone: odebrane=' + rejected.claimed + ' wygasłe=' + rejected.expired
      + ' bez configu=' + rejected.noConfig
      + ' nieobsługiwany typ=' + rejected.unsupportedTask
      + ' → do zrobienia: ' + pending.length);

  const PRIORITY = { WATCH_VIDEO: 0, WATCH_VIDEO_ON_MOBILE: 0, PLAY_ACTIVITY: 1, PLAY_ON_DESKTOP: 2, STREAM_ON_DESKTOP: 3 };
  const taskOf = q => {
    const tc = q.config.taskConfig || q.config.taskConfigV2;
    return SUPPORTED.find(t => tc.tasks[t] != null);
  };
  pending.sort((a, b) => (PRIORITY[taskOf(a)] ?? 9) - (PRIORITY[taskOf(b)] ?? 9));

  let selected = pending;

  R({ t: 'skipped', list: [] });

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
  log('Found ' + selected.length + ' quest(s) to process');

  // Test lacznosci z solverem. Bez niego "brak wiadomosci po stronie Pythona"
  // jest nieodroznialne od: solver nigdy nie zostal wywolany, CSP zablokowalo
  // polaczenie, albo serwer nie stoi. Robimy to RAZ, na starcie.
  (async () => {
    // GET na /openapi.json: FastAPI serwuje to zawsze, nie dotyka modelu i nie
    // przechodzi przez walidacje Pydantic (POST bez image_data dalby mylace 422).
    const url = 'http://127.0.0.1:5000/openapi.json';
    try {
      const res = await fetch(url, { method: 'GET' });
      log('[GPU-AI] Solver osiągalny: HTTP ' + res.status + ' (' + url + ')');
    } catch (e) {
      const m = String((e && e.message) || e);
      log('[GPU-AI] Solver NIEOSIĄGALNY: ' + m
          + (/content security policy|csp|refused to connect/i.test(m)
              ? ' -> blokuje CSP Discorda, nie zapora. Z poziomu strony się nie da.'
              : ' -> sprawdź, czy serwer Pythona stoi na 127.0.0.1:5000.'));
    }
  })();

  let knownLoc = null;

  const enroll = async (quest) => {
    const base = [11, 10, 8, 4, 2, 1, 0];
    const locations = knownLoc != null
      ? [knownLoc].concat(base.filter(l => l !== knownLoc))
      : base;

    const sealed = sealedFor(quest.id);

    let lastErr = null;
    for (const loc of locations) {
      try {
        // Pelny ksztalt body prawdziwego klienta - Discord odrzuca niekompletne.
        const body = {
          location: loc,
          is_targeted: false,
          metadata_sealed: null,
          traffic_metadata_sealed: sealed,
        };
        await apiCall('POST', '/quests/' + quest.id + '/enroll', body, 'enroll');
        knownLoc = loc;
        return { ok: true, loc: loc };
      } catch(e) {
        const msg = errMsg(e);
        lastErr = msg;
        if (isRateLimit(e)) return { ok: false, err: msg, rateLimited: true };
        if (/captcha|verif/i.test(String(msg))) return { ok: false, err: msg, captcha: true };
      }
    }

    try {
      await apiCall('POST', '/quests/' + quest.id + '/enroll', {}, 'enroll');
      return { ok: true, loc: 'empty' };
    } catch(e) {
      return { ok: false, err: lastErr || errMsg(e) };
    }
  };

  // ── 5. Single quest logic ──────────────────────────────────────────────────
  const finishQuest = async (quest, orbs) => {
    const success = await claimReward(quest);
    if (success) {
      // orbs pochodzi z configu questa (wartosc nominalna), nie z odpowiedzi claimu.
      R({ t: 'qdone', id: quest.id, name: nameOf(quest), orbs: orbs, verified: !!success.verified });
      log('Quest zaliczony i nagroda odebrana: ' + nameOf(quest)
          + (success.verified ? ' (potwierdzone)' : ' (NIEpotwierdzone)'));
    } else {
      log('Nie udało się odebrać nagrody dla: ' + nameOf(quest) + ' - pomijam dodawanie orbów.');
    }
  };

  const doQuest = async (quest) => {
    const name = (quest.config.messages && quest.config.messages.questName) || quest.id;
    const tc = quest.config.taskConfig || quest.config.taskConfigV2;
    const taskName = SUPPORTED.find(t => tc.tasks[t] != null);
    const taskData = tc.tasks[taskName];
    const secondsNeeded = taskData.target;
    const applicationId = (quest.config.application && quest.config.application.id)
                        || (taskData.applications && taskData.applications[0] && taskData.applications[0].id)
                        || "1070163152288542720";
    let secondsDone = (quest.userStatus && quest.userStatus.progress && quest.userStatus.progress[taskName] && quest.userStatus.progress[taskName].value) || 0;
    const orbs = orbsOf(quest);

    R({ t: 'qstart', id: quest.id, name: name, task: taskName, target: secondsNeeded, done: secondsDone, orbs: orbs });

    if (quest.userStatus && quest.userStatus.completedAt) {
      log('Quest "' + name + '" jest juz ukończony! Odbieranie nagrody...');
      await finishQuest(quest, orbs);
      return;
    }

    log('Start: ' + name + ' [' + taskName + '] ' + secondsDone + '/' + secondsNeeded + 's');

    if (!(quest.userStatus && quest.userStatus.enrolledAt)) {
      log('Enrolling in quest...');
      const e = await enroll(quest);
      if (!e.ok) {
        if (e.captcha) {
          R({ t: 'qerr', id: quest.id, err: 'enroll: ' + e.err, captcha: true });
          return;
        }
        return { retry: true, err: 'enroll: ' + e.err, rateLimited: !!e.rateLimited };
      }
      log('Enrolled: ' + name + ' (location=' + e.loc + ')');
      await sleep(500);
    }

    if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
      const speed = 7;
      let completed = false;
      let serverDone = secondsDone;
      let stalledVideo = 0;
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
        completed = completedOf(res.body);

        // Postep raportowany przez serwer - to jedyne zrodlo prawdy.
        const srv = progressOf(res.body, taskName);
        if (srv != null) {
          if (srv > serverDone) { serverDone = srv; stalledVideo = 0; }
          else { stalledVideo += speed; }
        }

        // Licznik lokalny sluzy WYLACZNIE do tempa wysylki, nie do raportowania.
        secondsDone = Math.min(secondsNeeded, timestamp);

        R({ t: 'qprog', id: quest.id, done: srv != null ? serverDone : null,
            target: secondsNeeded, sent: secondsDone, serverTracked: srv != null });
        log('video: serwer ' + (srv != null ? serverDone : '?') + '/' + secondsNeeded
            + 's | wyslano ' + secondsDone + 's (' + (Date.now()-t0) + 'ms)');

        if (completed) break;
        if (stalledVideo >= 60) {
          return { retry: true, err: 'serwer nie nalicza postepu video (0s przez ' + stalledVideo + 's)' };
        }
        if (timestamp >= secondsNeeded) break;
      }
      if (!completed) {
        try {
          const fin = await apiCall('POST', '/quests/' + quest.id + '/video-progress',
            { timestamp: secondsNeeded }, 'video-progress final');
          completed = completedOf(fin && fin.body);
        } catch(e) {
          log('video-progress final nie powiodl sie: ' + errMsg(e));
        }
      }
      if (!completed) {
        // Bez potwierdzenia z serwera NIE probujemy claimu i NIE raportujemy sukcesu.
        R({ t: 'qerr', id: quest.id, err: 'serwer nie oznaczyl questa jako ukonczony - nagroda nie odebrana' });
        return { retry: true, err: 'video: brak completed_at z serwera' };
      }
      await finishQuest(quest, orbs);
      return;
    }

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

        const progress = progressOf(res.body, 'PLAY_ACTIVITY') || 0;
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
      await finishQuest(quest, orbs);
      return;
    }

    if (taskName === 'PLAY_ON_DESKTOP') {
      if (!RunningGameStore || !FluxDispatcher) {
        R({ t: 'qerr', id: quest.id, err: 'RunningGameStore/FluxDispatcher not found' }); return;
      }
      const pid = Math.floor(Math.random() * 30000) + 1000;
      
      let appName = (quest.config && quest.config.application && quest.config.application.name) || name;
      let exeName = appName.replace(/[^a-zA-Z0-9]/g, '') + '.exe';

      // Safe fetch app details without breaking on missing auth/application
      if (applicationId) {
        try {
          const res = await apiCall('GET', '/applications/' + applicationId + '/public', null, 'applications');
          if (res && res.body) {
            if (res.body.name) appName = res.body.name;
            const exe = res.body.executables && res.body.executables.find(x => x.os === 'win32');
            if (exe && exe.name) exeName = exe.name.replace('>', '');
          }
        } catch(_) {
          log('Ignoruję błąd autoryzacji publicznego API gier, używam domyślnej nazwy: ' + appName);
        }
      }

      const fakeGame = {
        cmdLine: 'C:\\\\\\\\Program Files\\\\\\\\CustomGame\\\\\\\\' + exeName,
        exeName: exeName,
        exePath: 'c:/program files/customgame/' + exeName,
        hidden: false, isLauncher: false, id: applicationId, name: appName,
        pid: pid, pidPath: [pid], processName: appName, start: Date.now(),
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

      log('Impersonating game: ' + appName);

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

        const p = progressOf(res2.body, 'PLAY_ON_DESKTOP') || 0;

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

        if (stalled >= 120) {
          failErr = 'backend is not tracking progress for the web client (0s for 2 min)';
          break;
        }

        await sleep(20000);
      }

      restore();
      if (!ok) return { retry: true, err: failErr || 'unknown error' };
      await finishQuest(quest, orbs);
      return;
    }

    if (taskName === 'STREAM_ON_DESKTOP') {
      R({ t: 'qerr', id: quest.id, err: 'skipped - requires streaming in a voice channel with another person' });
      return;
    }
  };

  const MAX_ATTEMPTS = 3;
  const RETRY_PAUSE = 30000;
  const nameOf = q => (q.config && q.config.messages && q.config.messages.questName) || q.id;

  // ── Auto-solve AI via local GPU ──────────────────────────────────────
  const LOCAL_AI_ENDPOINT = 'http://127.0.0.1:5000/analyze-captcha';

  // Dawny solver dzialajacy w kontekscie strony zostal usuniety: czytal ramke
  // hCaptcha przez iframe.contentWindow.document, co dla cross-origin zawsze
  // konczylo sie SecurityError. Zastapil go mostek w captcha.js, wolany przez
  // window.__questSolveCaptcha wystawione z Playwrighta.

  const attemptClaim = async (quest, captchaKey = null, rqtoken = null) => {
    const sealed = sealedFor(quest.id);

    // Dokladny ksztalt body prawdziwego klienta. Wszystkie piec pol jest
    // wymagane - samo traffic_metadata_sealed daje 400 Invalid Form Body.
    const payloads = [{
      platform: 0,
      location: knownLoc != null ? knownLoc : 11,
      is_targeted: false,
      metadata_sealed: null,
      traffic_metadata_sealed: sealed,
    }];

    // Pauza przed claimem - ukonczone questy inaczej strzelaja seria w tej samej sekundzie.
    await sleep(CD.beforeClaim + Math.random() * CD.jitter);

    const path = '/quests/' + quest.id + '/claim-reward';
    const body = { ...payloads[0] };
    // Discord wiaze rozwiazanie z konkretnym wyzwaniem: sam token nie wystarczy,
    // trzeba odeslac takze rqtoken z odpowiedzi, ktora to wyzwanie wystawila.
    if (captchaKey) body.captcha_key = captchaKey;
    if (rqtoken) body.captcha_rqtoken = rqtoken;

    // GOLY FETCH JAKO SCIEZKA GLOWNA.
    // Warstwa API klienta Discorda przechwytuje odpowiedz z wyzwaniem captcha:
    // zamiast odrzucic obietnice, zawiesza ja i czeka na rozwiazanie modala,
    // ktorego w trybie headless nikt nie rozwiaze. Na drucie widac wtedy 400,
    // a skrypt siedzi do wlasnego timeoutu. Goly fetch nie da sie zawiesic.
    let raw = null;
    try {
      raw = await _serialize(async () => {
        await _waitTurn(true);
        return rawApiPost(path, body);
      });
    } catch (e) {
      log('Zapasowy claim nie wystartował (' + ((e && e.message) || e)
          + ') - wracam do modułu API klienta.');
    }

    if (raw) {
      if (raw.ok) return { ok: true, status: raw.status, body: raw.body };

      const b = raw.body || {};
      const looksLikeCaptcha = !!(b.captcha_key || b.captcha_sitekey || b.captcha_service
                                  || /captcha/i.test(String(b.message || raw.raw || '')));
      if (looksLikeCaptcha) {
        log('Claim wymaga CAPTCHA (HTTP ' + raw.status + ', usługa: '
            + (b.captcha_service || '?') + ', sitekey: ' + (b.captcha_sitekey || '?') + ')');
        return { captcha: true, sitekey: b.captcha_sitekey || null,
                 service: b.captcha_service || null, rqdata: b.captcha_rqdata || null,
                 rqtoken: b.captcha_rqtoken || null,
                 sessionId: b.captcha_session_id || null };
      }

      return {
        ok: false,
        status: raw.status,
        err: (b.message || ('HTTP ' + raw.status)) + formErrors({ body: b }),
      };
    }

    // Sciezka zapasowa: modul API klienta (moze zawisnac - stad krotszy timeout).
    try {
      const res = await apiCall('POST', path, body, 'claim', 45000);
      return { ok: true, status: res.status, body: res.body };
    } catch (e) {
      const msg = errMsg(e);
      if (/captcha|verif/i.test(String(msg))
          || (e && e.status === 400 && e.body && e.body.captcha_key)) {
        return { captcha: true };
      }
      if (/^timeout /.test(String(msg))) {
        log('Moduł API klienta zawiesił claim (modal captchy w DOM: '
            + (captchaVisible() ? 'TAK' : 'nie') + ')');
      }
      return { ok: false, err: msg, status: e ? e.status : null };
    }
  };

  // Potwierdzenie u zrodla: czy quest ma faktycznie ustawione claimedAt?
  // null = nie udalo sie sprawdzic, true/false = odpowiedz serwera.
  const verifyClaimed = async (questId) => {
    try {
      const res = await apiCall('GET', '/quests/@me', null, 'verify-claim');
      const raw = (res && res.body && (res.body.quests || res.body)) || [];
      const list = (Array.isArray(raw) ? raw : []).map(camel);
      const q = list.find(x => x && x.id === questId);
      if (!q || !q.userStatus) return null;
      return !!q.userStatus.claimedAt;
    } catch(_) {
      return null;
    }
  };

  const claimReward = async (quest) => {
    if (!sealedFor(quest.id)) {
      log('Uwaga: brak traffic_metadata_sealed dla "' + nameOf(quest)
          + '" - Discord może odrzucić claim jako niekompletny formularz.');
    }
    log('Próba odebrania nagrody dla: ' + nameOf(quest));
    let r = await attemptClaim(quest);

    if (r.captcha) {
      R({ t: 'qclaim', id: quest.id, state: 'captcha' });

      // Rozwiazywanie idzie do Playwrighta - ramka hCaptcha jest cross-origin,
      // wiec z tego kontekstu nie da sie jej ani odczytac, ani kliknac.
      let realCaptchaKey = null;
      if (typeof window.__questSolveCaptcha === 'function') {
        log('[GPU-AI] CAPTCHA - przekazuję do mostka Playwrighta...');
        try {
          realCaptchaKey = await window.__questSolveCaptcha({
            sitekey: r.sitekey || null,
            rqdata: r.rqdata || null,
            service: r.service || null,
          });
        } catch(e) {
          log('[GPU-AI] Mostek zwrócił błąd: ' + ((e && e.message) || e));
        }
      } else {
        log('[GPU-AI] Mostek captchy niedostępny (stary engine?) - pomijam.');
      }

      if (!realCaptchaKey) {
        log('[GPU-AI] Brak tokenu - nagroda zostaje nieodebrana.');
        R({ t: 'qclaim', id: quest.id, state: 'unclaimed' });
        return false;
      }

      log('[GPU-AI] Token uzyskany, ponawiam claim...');
      r = await attemptClaim(quest, realCaptchaKey, r.rqtoken || null);
    }

    if (r.ok) {
      const verified = await verifyClaimed(quest.id);

      if (verified === false) {
        // Serwer przyjal request, ale claimedAt sie nie pojawilo - nagrody NIE ma.
        R({ t: 'qclaim', id: quest.id, state: 'unclaimed',
            err: 'serwer nie potwierdził odbioru (brak claimedAt)' });
        log('Claim przeszedł po HTTP, ale serwer nie potwierdził odbioru - NIE liczę tego questa.');
        return false;
      }

      R({ t: 'qclaim', id: quest.id, state: 'claimed', verified: verified === true, status: r.status });
      log(verified === true
        ? 'Nagroda odebrana i potwierdzona przez serwer.'
        : 'Nagroda zgłoszona (HTTP ' + r.status + '), ale nie udało się zweryfikować stanu u Discorda.');

      const delay = Math.floor(CD.betweenQuests + Math.random() * 4000);
      log('Czekam ' + Math.round(delay / 1000) + 's przed kolejnym zadaniem...');
      await sleep(delay);
      return { verified: verified === true };
    } else {
      R({ t: 'qclaim', id: quest.id, state: 'error', err: (r.status ? '[' + r.status + '] ' : '') + r.err });
      log('Błąd odbioru: ' + (r.status ? '[' + r.status + '] ' : '') + r.err);
      return false;
    }
  };

  // ── Pętla wykonawcza ──────────────────────────────────────────────────
  for (const q of selected) {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      let res;
      try {
        res = await doQuest(q);
      } catch(e) {
        // Wczesniej kazdy nieobsluzony wyjatek konczyl CALY skrypt bez zadnego raportu.
        const msg = (e && e.message) || String(e);
        R({ t: 'qerr', id: q.id, err: 'wyjątek: ' + msg });
        log('Nieoczekiwany błąd przy ' + nameOf(q) + ': ' + msg);
        res = { retry: attempts < MAX_ATTEMPTS, err: msg };
      }
      if (!res || !res.retry) break;
      log('Retry ' + attempts + '/' + MAX_ATTEMPTS + ' for ' + nameOf(q) + ': ' + res.err);
      await sleep(RETRY_PAUSE);
    }

    // Cooldown miedzy questami - obowiazuje takze po bledzie i po questach
    // juz ukonczonych, ktore inaczej przelatuja caly szereg w jednej sekundzie.
    if (q !== selected[selected.length - 1]) {
      const gap = Math.floor(CD.betweenQuests + Math.random() * CD.jitter);
      log('Cooldown ' + Math.round(gap / 1000) + 's przed kolejnym questem...');
      await sleep(gap);
    }
  }

  R({ t: 'finished', processed: selected.length });

})();
`;
