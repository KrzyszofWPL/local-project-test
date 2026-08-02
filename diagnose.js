// Raw proxy diagnostics – answers "what is actually wrong with my proxies?"
//
//   node diagnose.js                 – check the first 10 entries of ip.txt
//   node diagnose.js --all           – check every entry
//   node diagnose.js 1.2.3.4:1080:user:pass
//
// This deliberately bypasses Playwright, Chromium and the bridge and speaks to
// the endpoint over a plain TCP socket, so the result is about the proxy alone.
// For each entry it answers, in order:
//
//   1. Does TCP even connect?          (refused / timeout / reset)
//   2. Does it speak SOCKS5?           (version byte + chosen auth method)
//   3. Do the credentials pass?        (RFC 1929 reply)
//   4. Can it reach the internet?      (CONNECT to discord.com:443)
//   5. If it is not SOCKS5 – is it actually an HTTP proxy?
//
// Passwords are never printed.

const net = require('net');
const { loadProxies, parseLine, PROXY_FILE } = require('./proxies.js');

const TIMEOUT = parseInt(process.env.DIAG_TIMEOUT || '10000', 10);
const TEST_HOST = process.env.DIAG_HOST || 'discord.com';
const TEST_PORT = parseInt(process.env.DIAG_PORT || '443', 10);

const SOCKS_REPLY = {
  1: 'general SOCKS server failure', 2: 'connection not allowed by ruleset',
  3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused',
  6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

// Open a TCP socket and classify the failure precisely.
function tcpConnect(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const settle = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { sock.destroy(); resolve({ ok: false, error: err }); }
      else resolve({ ok: true, sock });
    };
    const timer = setTimeout(() => settle('timeout after ' + TIMEOUT + 'ms (port filtered / host down)'), TIMEOUT);
    sock.once('connect', () => settle(null));
    sock.once('error', (e) => {
      const map = {
        ECONNREFUSED: 'connection refused (nothing listening on this port)',
        ECONNRESET: 'reset immediately (blocked, or your IP is not authorised)',
        EHOSTUNREACH: 'host unreachable',
        ENETUNREACH: 'network unreachable',
        ETIMEDOUT: 'timed out',
        ENOTFOUND: 'hostname does not resolve',
      };
      settle(map[e.code] || (e.code || e.message));
    });
  });
}

// Read exactly n bytes (or fail) – SOCKS replies are short and fixed-width.
function readBytes(sock, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('no reply within ' + TIMEOUT + 'ms')); }, TIMEOUT);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) { cleanup(); resolve(buf); }
    };
    const onErr = (e) => {
      cleanup();
      reject(new Error(e.code === 'ECONNRESET'
        ? 'connection reset while waiting for a reply (endpoint is not SOCKS5, or rejected us)'
        : (e.code || e.message)));
    };
    const onEnd = () => { cleanup(); reject(new Error('closed without replying')); };
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd);
    };
    sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd);
  });
}

// Is this endpoint an ordinary HTTP proxy? Used when SOCKS5 is ruled out, so a
// mislabelled list can be identified rather than just "broken".
async function probeHttpProxy(proxy) {
  const c = await tcpConnect(proxy.host, proxy.port);
  if (!c.ok) return null;
  const sock = c.sock;
  try {
    const auth = proxy.username
      ? 'Proxy-Authorization: Basic '
        + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64') + '\r\n'
      : '';
    sock.write(`CONNECT ${TEST_HOST}:${TEST_PORT} HTTP/1.1\r\n`
      + `Host: ${TEST_HOST}:${TEST_PORT}\r\n` + auth + '\r\n');
    const head = await readBytes(sock, 12);
    const line = head.toString('latin1').split('\r\n')[0].trim();
    return /^HTTP\//i.test(line) ? line : null;
  } catch (_) {
    return null;
  } finally {
    sock.destroy();
  }
}

async function diagnose(proxy) {
  const out = { label: `${proxy.host}:${proxy.port}`, steps: [], verdict: '', hint: '' };
  const step = (s) => out.steps.push(s);

  // 1 – TCP
  const c = await tcpConnect(proxy.host, proxy.port);
  if (!c.ok) {
    step('TCP: ✗ ' + c.error);
    out.verdict = 'unreachable';
    out.hint = /refused|timeout|filtered/.test(c.error)
      ? 'Port is closed or the proxy is dead. Verify host/port with your vendor.'
      : 'Often means your current IP is not whitelisted with the vendor.';
    return out;
  }
  step('TCP: ✓ connected');
  const sock = c.sock;

  try {
    // 2 – SOCKS5 greeting
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    let greet;
    try {
      greet = await readBytes(sock, 2);
    } catch (e) {
      step('SOCKS5 greeting: ✗ ' + e.message);
      sock.destroy();
      const http = await probeHttpProxy(proxy);
      if (http) {
        step('HTTP proxy probe: ✓ replied "' + http + '"');
        out.verdict = 'is-http-proxy';
        out.hint = 'This is an HTTP proxy, not SOCKS5. Set the protocol to HTTP.';
      } else {
        out.verdict = 'not-socks5';
        out.hint = 'Speaks neither SOCKS5 nor HTTP proxy – wrong port, or your IP is not authorised.';
      }
      return out;
    }

    if (greet[0] !== 0x05) {
      step('SOCKS5 greeting: ✗ replied version 0x' + greet[0].toString(16) + ', not SOCKS5');
      sock.destroy();
      const http = await probeHttpProxy(proxy);
      out.verdict = http ? 'is-http-proxy' : 'not-socks5';
      out.hint = http
        ? 'This is an HTTP proxy, not SOCKS5. Set the protocol to HTTP.'
        : 'Not a SOCKS5 endpoint.';
      if (http) step('HTTP proxy probe: ✓ replied "' + http + '"');
      return out;
    }

    const method = greet[1];
    if (method === 0xff) {
      step('SOCKS5 greeting: ✗ no acceptable auth method (0xFF)');
      out.verdict = 'auth-rejected';
      out.hint = proxy.username
        ? 'The proxy refused user/pass auth – wrong credentials, or it wants IP whitelisting instead.'
        : 'This proxy requires a login, but the line has none. Use ip:port:user:pass.';
      return out;
    }
    step('SOCKS5 greeting: ✓ chose method 0x' + method.toString(16).padStart(2, '0')
      + (method === 0x02 ? ' (user/pass)' : ' (no auth)'));

    // 3 – credentials
    if (method === 0x02) {
      if (!proxy.username) {
        out.verdict = 'needs-credentials';
        out.hint = 'Proxy demands a login but none was supplied.';
        return out;
      }
      const u = Buffer.from(proxy.username, 'utf8');
      const p = Buffer.from(proxy.password || '', 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const authRes = await readBytes(sock, 2);
      if (authRes[1] !== 0x00) {
        step('Credentials: ✗ rejected');
        out.verdict = 'bad-credentials';
        out.hint = 'Login or password is wrong for this proxy.';
        return out;
      }
      step('Credentials: ✓ accepted');
    }

    // 4 – can it actually reach the internet?
    const host = Buffer.from(TEST_HOST, 'utf8');
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(TEST_PORT);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, portBuf]));
    const reply = await readBytes(sock, 4);
    if (reply[1] !== 0x00) {
      step(`CONNECT ${TEST_HOST}: ✗ ` + (SOCKS_REPLY[reply[1]] || 'code ' + reply[1]));
      out.verdict = 'connect-failed';
      out.hint = 'Handshake fine, but the proxy could not open the outbound connection.';
      return out;
    }
    step(`CONNECT ${TEST_HOST}:${TEST_PORT}: ✓ established`);
    out.verdict = 'ok';
    return out;
  } catch (e) {
    step('✗ ' + e.message);
    out.verdict = 'handshake-failed';
    out.hint = 'The endpoint dropped us mid-handshake – typically not SOCKS5, or IP not authorised.';
    return out;
  } finally {
    sock.destroy();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const inline = args.filter(a => !a.startsWith('--'));

  const scheme = process.env.PROXY_SCHEME || 'socks5';
  let list;
  if (inline.length) {
    list = inline.map(l => parseLine(l, scheme));
  } else {
    const loaded = loadProxies(PROXY_FILE, scheme);
    if (!loaded.exists) {
      console.error('No ip.txt found next to diagnose.js');
      process.exit(1);
    }
    list = loaded.proxies;
    if (loaded.errors.length) {
      console.log(`(${loaded.errors.length} unparseable line(s) in ip.txt)\n`);
    }
  }
  if (!list.length) { console.error('No proxies to check.'); process.exit(1); }

  const subset = all || inline.length ? list : list.slice(0, 10);
  console.log(`\nDiagnosing ${subset.length} of ${list.length} proxies as ${scheme.toUpperCase()}`);
  console.log(`Target: ${TEST_HOST}:${TEST_PORT}   (passwords are never printed)\n`);

  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < subset.length) {
      const p = subset[next++];
      const r = await diagnose(p);
      results.push(r);
      console.log(`── ${r.label}  [${r.verdict}]`);
      r.steps.forEach(s => console.log('   ' + s));
      if (r.hint) console.log('   → ' + r.hint);
      console.log('');
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, subset.length) }, worker));

  const byVerdict = results.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {});
  console.log('─'.repeat(60));
  console.log('Summary:');
  Object.entries(byVerdict).sort((a, b) => b[1] - a[1])
    .forEach(([v, n]) => console.log(`  ${String(n).padStart(4)}  ${v}`));

  const worst = Object.entries(byVerdict).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[0] !== 'ok') {
    console.log('\nEvery/most entries share one verdict, so this is a property of the');
    console.log('proxy list itself, not of how the bot dials it.');
    if (worst[0] === 'is-http-proxy') {
      console.log('→ Switch the protocol to HTTP in the panel.');
    } else if (worst[0] === 'unreachable' || worst[0] === 'not-socks5' || worst[0] === 'handshake-failed') {
      console.log('→ Ask the vendor: is the list still active, and does it require');
      console.log('  IP whitelisting? Add your current public IP in their dashboard.');
    } else if (worst[0] === 'bad-credentials' || worst[0] === 'auth-rejected') {
      console.log('→ The login/password is not being accepted. Re-copy them from the vendor.');
    }
  }
  console.log('');
}

main().catch(e => { console.error('diagnose failed:', e.message); process.exit(1); });
