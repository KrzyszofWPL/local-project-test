/**
 * Testy regresji.  Uruchomienie:  node test.js
 *
 * Bez frameworka – wystarczy Node.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TOKENS = path.join(__dirname, 'tokens.txt');
const BACKUP = path.join(__dirname, 'tokens.txt.testbak');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
    failed++;
  }
}

// Podmień tokens.txt na testowe, oryginał odłóż na bok
function setupTokens() {
  if (fs.existsSync(TOKENS)) fs.copyFileSync(TOKENS, BACKUP);
  fs.writeFileSync(TOKENS, 'aaaa1111bbbb2222\ncccc3333dddd4444\n');
}
function restoreTokens() {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, TOKENS);
    fs.unlinkSync(BACKUP);
  }
}

(async () => {
  console.log('\nTesty regresji\n');
  setupTokens();

  const { Engine } = require('./engine.js');

  // ── Podwójne uruchomienie ────────────────────────────────────────────────
  await test('konto nie startuje dwa razy równolegle', async () => {
    const e = new Engine();
    let calls = 0;
    e._runInner = async (acc) => {
      calls++;
      acc.status = 'running';
      await new Promise(r => setTimeout(r, 200));
      acc.status = 'done';
    };

    e.start('0');
    e.start('0');
    e.start('0');
    e.startAll();
    e.start('1');

    await new Promise(r => setTimeout(r, 700));
    assert.strictEqual(calls, 2, `oczekiwano 2 uruchomień (po jednym na konto), było ${calls}`);
  });

  await test('konto można uruchomić ponownie po zakończeniu', async () => {
    const e = new Engine();
    let calls = 0;
    e._runInner = async (acc) => {
      calls++;
      await new Promise(r => setTimeout(r, 50));
      acc.status = 'done';
    };

    e.start('0');
    await new Promise(r => setTimeout(r, 200));
    e.start('0');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(calls, 2, `oczekiwano 2 uruchomień po sobie, było ${calls}`);
  });

  // ── Nagłówek X-Super-Properties ──────────────────────────────────────────
  await test('tryb desktop zachowuje client_build_number', async () => {
    delete require.cache[require.resolve('./engine.js')];
    const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf-8');
    assert.ok(src.includes('...props'),
      'nagłówek musi być łatany, nie budowany od zera – inaczej build number się zestarzeje');

    // Zbuduj oryginał tak, jak wysyła go klient webowy
    const original = Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', client_build_number: 999999,
      release_channel: 'stable',
    })).toString('base64');

    const m = src.match(/function toDesktopSuperProperties[\s\S]*?\n}/);
    assert.ok(m, 'nie znaleziono toDesktopSuperProperties');
    const consts = src.match(/const CLIENT_VERSION[\s\S]*?Safari\/537\.36';/)[0];
    const fn = new Function('Buffer', consts + '\n' + m[0] + '; return toDesktopSuperProperties;')(Buffer);

    const out = JSON.parse(Buffer.from(fn(original), 'base64').toString('utf-8'));
    assert.strictEqual(out.client_build_number, 999999, 'build number musi zostać zachowany');
    assert.strictEqual(out.browser, 'Discord Client', 'typ klienta musi zostać podmieniony');
  });

  await test('tryb desktop wysyła User-Agent z wersją Electrona', async () => {
    const s = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf-8');
    const ua = s.match(/const ELECTRON_UA =[\s\S]*?';\n/)[0];
    assert.ok(/Electron\/\d+\.\d+/.test(ua),
      'User-Agent musi zawierać wersję Electrona – bez niej Discord odrzuca '
      + 'heartbeaty questów-gier błędem 401');

    assert.ok(s.includes('this.desktopMode ? ELECTRON_UA : UA'),
      'kontekst przeglądarki musi używać Electron UA w trybie desktop');
    assert.ok(s.includes("headers['user-agent'] = ELECTRON_UA"),
      'żądania do API muszą mieć nadpisany User-Agent, nie tylko super properties');
  });

  // ── Skrypt wstrzykiwany ──────────────────────────────────────────────────
  await test('skrypt wstrzykiwany jest poprawnym JS-em', async () => {
    const s = require('./inject.js');
    require('vm').compileFunction('return ' + s);
  });

  await test('skrypt blokuje podwójne wstrzyknięcie', async () => {
    const s = require('./inject.js');
    assert.ok(s.includes('__questBotActive'), 'brak blokady podwójnego uruchomienia w stronie');
  });

  await test('każde wywołanie API ma limit czasu', async () => {
    const s = require('./inject.js');
    const m = s.match(/const apiCall = async[\s\S]*?\n  \};/);
    assert.ok(m, 'nie znaleziono warstwy apiCall');
    assert.ok(m[0].includes('withTimeout('),
      'apiCall musi opakowywać wywołanie limitem czasu');
  });

  await test('questy wideo mają pierwszeństwo przed grami', async () => {
    const s = require('./inject.js');
    assert.ok(s.includes('PRIORITY'), 'brak sortowania questów');
    const m = s.match(/PRIORITY = \{([^}]*)\}/);
    assert.ok(m, 'nie znaleziono definicji PRIORITY');
    const body = m[1];
    const video = body.match(/WATCH_VIDEO:\s*(\d)/)[1];
    const play = body.match(/PLAY_ON_DESKTOP:\s*(\d)/)[1];
    assert.ok(+video < +play, 'wideo musi mieć wyższy priorytet niż gra');
  });

  await test('limit zapytań jest odróżniany od odmowy', async () => {
    const s = require('./inject.js');
    assert.ok(s.includes('isRateLimit'), 'brak wykrywania limitu zapytań');
    assert.ok(s.includes('retryAfterMs'), 'brak odczytu retry_after z odpowiedzi');
    assert.ok(s.includes('rateLimited'),
      'limit zapytań musi być odróżniony od trwałego błędu zapisu');
  });

  await test('wszystkie wywołania API idą przez wspólną warstwę', async () => {
    const s = require('./inject.js');
    const m = s.match(/const apiCall = async[\s\S]*?\n  \};/);
    assert.ok(m, 'nie znaleziono warstwy apiCall');

    // Poza ciałem apiCall nie powinno być żadnych bezpośrednich wywołań –
    // inaczej omijają obsługę limitu zapytań i limit czasu.
    const outside = s.replace(m[0], '');
    const direct = (outside.match(/api\.(post|get)\(/g) || []).length;
    assert.strictEqual(direct, 0,
      `bezpośrednie wywołania api poza warstwą apiCall: ${direct}`);
  });

  // ── Panel ────────────────────────────────────────────────────────────────
  await test('JS panelu jest poprawny składniowo', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf-8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'brak sekcji <script> w panelu');
    require('vm').compileFunction(m[1]);
  });

  restoreTokens();

  console.log(`\n${passed} zaliczonych, ${failed} niezaliczonych\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  restoreTokens();
  console.error('Błąd testów:', e);
  process.exit(1);
});
