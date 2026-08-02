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

  await test('tryb desktop zachowuje client_build_number', async () => {
    delete require.cache[require.resolve('./engine.js')];
    const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf-8');
    assert.ok(src.includes('...props'),
      'nagłówek musi być łatany, nie budowany od zera – inaczej build number się zestarzeje');

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

    assert.ok(/this\.desktopMode \? ELECTRON_UA :/.test(s),
      'kontekst przeglądarki musi używać Electron UA w trybie desktop');
    assert.ok(s.includes("headers['user-agent'] = ELECTRON_UA"),
      'żądania do API muszą mieć nadpisany User-Agent, nie tylko super properties');
  });

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

    const outside = s.replace(m[0], '');
    const direct = (outside.match(/api\.(post|get)\(/g) || []).length;
    assert.strictEqual(direct, 0,
      `bezpośrednie wywołania api poza warstwą apiCall: ${direct}`);
  });

  await test('orbs liczone tylko z pola orb_quantity', async () => {
    const s = require('./inject.js');
    const m = s.match(/const orbsOf = \(q\) => \{[\s\S]*?\n  \};/);
    assert.ok(m, 'nie znaleziono orbsOf');
    assert.ok(!/r\.quantity|r\.amount/.test(m[0]),
      'orbsOf nie może sumować zwykłego quantity – nagrody kosmetyczne liczyłyby się jako orby');
    assert.ok(/orb_?[Qq]uantity/.test(m[0]), 'orbsOf musi czytać pole orb_quantity');
  });

  await test('questy bez orbs można pominąć', async () => {
    const s = require('./inject.js');
    assert.ok(s.includes('onlyOrbs'), 'brak opcji pomijania questów bez orbs');
    assert.ok(s.includes("t: 'skipped'"), 'pominięte questy muszą być raportowane do panelu');

    const eng = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf-8');
    assert.ok(eng.includes('window.__questOpts'),
      'opcje muszą być przekazane do strony przed wstrzyknięciem skryptu');
  });

  await test('JS panelu jest poprawny składniowo', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf-8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'brak sekcji <script> w panelu');
    require('vm').compileFunction(m[1]);
  });

  await test('fingerprint jest stały dla tokenu i różny między tokenami', async () => {
    const { fingerprintFor } = require('./fingerprint.js');
    const a = fingerprintFor('token-AAA');
    const b = fingerprintFor('token-AAA');
    const c = fingerprintFor('token-BBB');
    assert.deepStrictEqual(a, b, 'ten sam token musi dawać ten sam fingerprint (stabilność między uruchomieniami)');
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(c),
      'różne tokeny muszą mieć różne fingerprinty');
  });

  await test('init-script fingerprintu jest poprawnym JS-em i łata WebGL', async () => {
    const { fingerprintFor, initScript } = require('./fingerprint.js');
    const src = initScript(fingerprintFor('token-AAA'));
    require('vm').compileFunction(src);
    assert.ok(/37445|37446/.test(src), 'init-script musi nadpisywać WebGL vendor/renderer');
    assert.ok(src.includes('hardwareConcurrency'), 'init-script musi nadpisywać liczbę rdzeni');
  });

  await test('domyślny protokół zamienia goły ip:port:login:hasło na SOCKS5', async () => {
    const { parseLine } = require('./proxies.js');
    // Bez prefiksu i bez domyślnego schematu → HTTP (dotychczasowe zachowanie).
    assert.strictEqual(parseLine('83.97.117.98:1080:bob:pass').scheme, 'http');
    // Z domyślnym schematem socks5 ten sam wpis staje się SOCKS5…
    const p = parseLine('83.97.117.98:1080:bob:pass', 'socks5');
    assert.strictEqual(p.scheme, 'socks5');
    assert.strictEqual(p.username, 'bob');
    // …ale jawny prefiks na linii zawsze wygrywa z domyślnym.
    assert.strictEqual(parseLine('http://1.2.3.4:8080', 'socks5').scheme, 'http');
  });

  await test('ustawienie domyślnego protokołu przeładowuje listę proxy', async () => {
    const e = new Engine();
    const applied = e.setDefaultProxyScheme('socks5');
    assert.strictEqual(applied, 'socks5', 'setter musi zwrócić znormalizowany schemat');
    assert.strictEqual(e.snapshot().proxies.defaultScheme, 'socks5',
      'panel musi widzieć wybrany domyślny protokół');
    assert.strictEqual(e.setDefaultProxyScheme('bzdura'), 'http',
      'nieznany schemat musi wrócić do http');
  });

  await test('goła linia ip:port:login:hasło jest oznaczona do wykrycia protokołu', async () => {
    const { parseLine } = require('./proxies.js');
    const auto = parseLine('83.97.117.98:1080:bob:pass');
    assert.strictEqual(auto.pending, true, 'bez prefiksu protokół musi być dopiero wykryty');
    assert.strictEqual(auto.explicit, false);

    // Jawny prefiks jest pewny – nie wolno go nadpisywać wykrywaniem.
    const explicit = parseLine('socks5://83.97.117.98:1080:bob:pass');
    assert.strictEqual(explicit.pending, false);
    assert.strictEqual(explicit.explicit, true);
    assert.strictEqual(explicit.scheme, 'socks5');

    // Ręczny wybór protokołu też jest pewny.
    const forced = parseLine('83.97.117.98:1080:bob:pass', 'socks5');
    assert.strictEqual(forced.pending, false);
    assert.strictEqual(forced.scheme, 'socks5');
  });

  await test('wykrywanie rozpoznaje SOCKS5 i przełącza wpis na mostek', async () => {
    const net = require('net');
    const { parseLine, applyScheme } = require('./proxies.js');
    const { detectScheme } = require('./socks-bridge.js');

    // Serwer odpowiadający jak SOCKS5 (0x05 + wybrana metoda).
    const srv = net.createServer((c) => {
      c.on('error', () => {});
      c.on('data', () => c.write(Buffer.from([0x05, 0x02])));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const p = parseLine(`127.0.0.1:${srv.address().port}:bob:pass`);
    assert.strictEqual(p.scheme, 'http', 'przed wykryciem obowiązuje założenie');

    const found = await detectScheme(p, 4000);
    assert.strictEqual(found, 'socks5', 'endpoint mówiący 0x05 to SOCKS5');
    applyScheme(p, found);
    assert.strictEqual(p.server, `socks5://127.0.0.1:${srv.address().port}`,
      'server musi zostać przepisany na socks5://');
    assert.strictEqual(p.pending, false);
    srv.close();
  });

  await test('proxy SOCKS5 jest kierowane przez lokalny mostek (nie wprost)', async () => {
    const net = require('net');
    const { parseLine } = require('./proxies.js');
    const { playwrightProxy, closeAll } = require('./socks-bridge.js');

    // Mostek jest tworzony leniwie – potrzebny jest osiągalny host SOCKS.
    const stub = net.createServer(() => {});
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;

    const socks = parseLine(`socks5://127.0.0.1:${port}:bob:s3cret`);
    const pw = await playwrightProxy(socks);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(pw.server),
      'SOCKS5 musi trafić do lokalnego mostka http://127.0.0.1:*, dostałem: ' + pw.server);
    assert.strictEqual(pw.username, undefined,
      'dane logowania nie mogą wyciekać do Chromium – trzyma je mostek');

    const http = parseLine('http://u:p@1.2.3.4:8080');
    const pwHttp = await playwrightProxy(http);
    assert.strictEqual(pwHttp.server, 'http://1.2.3.4:8080',
      'proxy HTTP musi iść wprost do Chromium (Chromium obsługuje jego autoryzację)');
    assert.strictEqual(pwHttp.username, 'u', 'login proxy HTTP musi być zachowany');

    await closeAll();
    stub.close();
  });

  restoreTokens();

  console.log(`\n${passed} zaliczonych, ${failed} niezaliczonych\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  restoreTokens();
  console.error('Błąd testów:', e);
  process.exit(1);
});
