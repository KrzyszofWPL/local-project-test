/**
 * Control panel – http://localhost:3000
 *
 * No external dependencies besides playwright: plain http + SSE.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const engine = new Engine();

// ── SSE clients ──────────────────────────────────────────────────────────────
const clients = new Set();

let pending = false;
engine.on('update', () => {
  // Coalesce bursts of events into one send every ~200 ms
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    const payload = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch (_) { clients.delete(res); }
    }
  }, 200);
});

// ── Helpers ──────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Panel page
  if (p === '/' || p === '/index.html') {
    const file = path.join(__dirname, 'public', 'dashboard.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end('Missing public/dashboard.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // State stream
  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state') return json(res, 200, engine.snapshot());

  // Actions
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      switch (p) {
        // Full token is never part of the SSE snapshot (only the masked
        // label is) – this is the one place it's returned, on demand, for
        // the "Copy token" action in the Accounts view.
        case '/api/token':
          return json(res, 200, { token: engine.getToken(body.id) });

        // Same deal as the token: proxy credentials stay out of the snapshot
        // and are handed over only for an explicit copy action.
        case '/api/proxy-url':
          return json(res, 200, { url: engine.getProxyUrl(body.id) });

        case '/api/proxy-test':
          return json(res, 200, { ip: await engine.testProxy(body.id) });

        // Kicks the run off and answers straight away – progress reaches the
        // panel through the state stream.
        case '/api/proxy-test-all':
          return json(res, 200, { ok: true, total: engine.testAllProxies().total });

        case '/api/use-proxies':
          engine.setUseProxies(body.value);
          return json(res, 200, { ok: true });

        case '/api/reload-proxies':
          engine.loadProxies();
          return json(res, 200, { ok: true, count: engine.proxyList.proxies.length });

        case '/api/start':
          await engine.start(body.id);
          return json(res, 200, { ok: true });

        case '/api/stop':
          await engine.stop(body.id);
          return json(res, 200, { ok: true });

        case '/api/start-all':
          engine.startAll().catch(() => {});
          return json(res, 200, { ok: true });

        case '/api/stop-all':
          await engine.stopAll();
          return json(res, 200, { ok: true });

        case '/api/concurrency':
          engine.setConcurrency(body.value);
          return json(res, 200, { ok: true });

        case '/api/headless':
          engine.setHeadless(body.value);
          return json(res, 200, { ok: true });

        case '/api/desktop-mode':
          engine.setDesktopMode(body.value);
          return json(res, 200, { ok: true });

        case '/api/only-orbs':
          engine.setOnlyOrbs(body.value);
          return json(res, 200, { ok: true });

        case '/api/reload-tokens':
          engine.loadProxies();
          engine.loadTokens();
          return json(res, 200, { ok: true });
      }
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  Discord Quest Bot – control panel          │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Panel:     http://localhost:${PORT}`);
  console.log(`  Accounts:  ${engine.accounts.length}`);
  console.log(`  Proxies:   ${engine.proxyList.proxies.length}`
    + (engine.proxyList.exists ? ' (ip.txt)' : ' – no ip.txt, all accounts share this IP'));
  if (engine.proxyList.proxies.length
      && engine.accounts.length > engine.proxyList.proxies.length) {
    console.log('             note: fewer proxies than accounts – some accounts share an IP');
  }
  console.log('');
  console.log('  Close this window or press Ctrl+C to stop.');
  console.log('');
});

// Cleanup
const shutdown = async () => {
  console.log('\nStopping…');
  try { await engine.stopAll(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
