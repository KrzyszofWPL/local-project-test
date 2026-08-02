const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const engine = new Engine();

const clients = new Set();

let pending = false;
engine.on('update', () => {
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

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    const file = path.join(__dirname, 'public', 'dashboard.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end('Missing public/dashboard.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

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

  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      switch (p) {
        case '/api/token':
          return json(res, 200, { token: engine.getToken(body.id) });

        case '/api/proxy-url':
          return json(res, 200, { url: engine.getProxyUrl(body.id) });

        case '/api/proxy-test':
          return json(res, 200, { ip: await engine.testProxy(body.id) });

        case '/api/proxy-test-all':
          return json(res, 200, { ok: true, total: engine.testAllProxies().total });

        case '/api/refresh-account':
          await engine.refreshIdentity(body.id);
          return json(res, 200, { ok: true });

        case '/api/refresh-accounts':
          return json(res, 200, { ok: true, known: await engine.refreshAllIdentities() });

        case '/api/use-proxies':
          engine.setUseProxies(body.value);
          return json(res, 200, { ok: true });

        case '/api/verify-done':
          return json(res, 200, { ok: true, id: engine.resolveVerification(body.id, true) });

        case '/api/verify-skip':
          return json(res, 200, { ok: true, id: engine.resolveVerification(body.id, false) });

        case '/api/proxy-scheme':
          return json(res, 200, { ok: true, scheme: engine.setDefaultProxyScheme(body.value) });

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

const shutdown = async () => {
  console.log('\nStopping…');
  try { await engine.stopAll(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
