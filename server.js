/**
 * Panel sterowania – http://localhost:3000
 *
 * Bez zewnętrznych zależności poza playwright: czysty http + SSE.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const engine = new Engine();

// ── Klienci SSE ─────────────────────────────────────────────────────────────
const clients = new Set();

let pending = false;
engine.on('update', () => {
  // Zbijaj serie zdarzeń w jeden wysył co ~200 ms
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

// ── Pomocnicze ──────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});

// ── Serwer ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Strona panelu
  if (p === '/' || p === '/index.html') {
    const file = path.join(__dirname, 'public', 'dashboard.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end('Brak public/dashboard.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Strumień stanu
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

  // Akcje
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      switch (p) {
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
  console.log('  │  Discord Quest Bot – panel sterowania      │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Panel:  http://localhost:${PORT}`);
  console.log(`  Konta:  ${engine.accounts.length}`);
  console.log('');
  console.log('  Zamknij tym oknem lub Ctrl+C, aby zakończyć.');
  console.log('');
});

// Sprzątanie
const shutdown = async () => {
  console.log('\nZatrzymywanie…');
  try { await engine.stopAll(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
