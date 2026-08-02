// Local HTTP-proxy → SOCKS5 bridge.
//
// Chromium (and therefore Playwright) can route through a SOCKS5 proxy, but it
// cannot authenticate to one – there is no way to hand Chromium a SOCKS5
// username/password. Proxies sold as `{ip}:{port}:{login}:{password}` therefore
// fail with `read ECONNRESET`, because the browser opens the socket and never
// sends the credentials the proxy is waiting for.
//
// This module works around that. For every authenticated SOCKS5 proxy we start
// a tiny HTTP proxy on 127.0.0.1 that Chromium *can* talk to (plain HTTP proxy,
// no auth). Each request/CONNECT is forwarded through a real SOCKS5 handshake –
// including RFC 1929 user/pass auth – to the upstream proxy. Playwright is then
// pointed at `http://127.0.0.1:<port>` instead of the SOCKS proxy directly.
//
// Pure Node (net + http), no extra dependencies.

const net = require('net');
const http = require('http');

const SOCKS_REPLY = {
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

// Perform a SOCKS5 CONNECT (with optional user/pass auth) to destHost:destPort
// through `proxy`. Resolves with { socket, leftover } – a live TCP socket ready
// for tunnelling and any bytes the proxy already sent after the reply.
function socks5Connect(proxy, destHost, destPort, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const timer = setTimeout(() => finish(new Error('SOCKS5 handshake timed out')), timeout);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { sock.destroy(); reject(err); }
      else resolve(result);
    };

    sock.once('error', (e) => finish(e));
    sock.once('close', () => finish(new Error('SOCKS5 connection closed during handshake')));

    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const wantAuth = !!proxy.username;

    sock.once('connect', () => {
      const methods = wantAuth ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    const sendAuth = () => {
      const u = Buffer.from(String(proxy.username), 'utf8');
      const p = Buffer.from(String(proxy.password || ''), 'utf8');
      if (u.length > 255 || p.length > 255) return finish(new Error('SOCKS5 credentials too long'));
      sock.write(Buffer.concat([
        Buffer.from([0x01, u.length]), u,
        Buffer.from([p.length]), p,
      ]));
    };

    const sendRequest = () => {
      stage = 'reply';
      const host = Buffer.from(destHost, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(destPort & 0xffff);
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port,
      ]));
    };

    sock.on('data', (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return finish(new Error('not a SOCKS5 proxy (bad version byte)'));
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0x00) { stage = 'request'; sendRequest(); }
        else if (method === 0x02) {
          if (!wantAuth) return finish(new Error('proxy demands authentication but no login was given'));
          stage = 'auth'; sendAuth();
        } else if (method === 0xff) {
          return finish(new Error('proxy rejected our auth methods (wrong or missing credentials?)'));
        } else {
          return finish(new Error('proxy chose unsupported SOCKS5 auth method ' + method));
        }
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1];
        buf = buf.slice(2);
        if (status !== 0x00) return finish(new Error('SOCKS5 authentication failed (bad login/password)'));
        stage = 'request';
        sendRequest();
        return;
      }

      if (stage === 'reply') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          return finish(new Error('SOCKS5 connect failed: ' + (SOCKS_REPLY[buf[1]] || 'code ' + buf[1])));
        }
        const atyp = buf[3];
        let need = 4;
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x04) need += 16 + 2;
        else if (atyp === 0x03) { if (buf.length < 5) return; need += 1 + buf[4] + 2; }
        else return finish(new Error('SOCKS5 reply used unknown address type ' + atyp));
        if (buf.length < need) return;

        const leftover = buf.slice(need);
        sock.removeAllListeners('data');
        sock.removeAllListeners('close');
        finish(null, { socket: sock, leftover });
      }
    });
  });
}

// Build (but do not yet listen on) the local HTTP proxy that fronts `proxy`.
function createBridgeServer(proxy) {
  const server = http.createServer();

  // Plain HTTP (http:// targets): Chromium sends an absolute-form request line.
  // Let Node's HTTP client own the framing and just feed it a socket that is
  // already tunnelled through SOCKS5.
  server.on('request', (req, res) => {
    let target;
    try { target = new URL(req.url); } catch (_) {
      res.writeHead(400); return res.end();
    }
    const port = +(target.port || 80);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];

    const upstream = http.request({
      method: req.method,
      path: (target.pathname || '/') + (target.search || ''),
      headers,
      createConnection: (_opts, cb) => {
        socks5Connect(proxy, target.hostname, port)
          .then(({ socket }) => cb(null, socket))
          .catch((err) => cb(err));
      },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('error', () => { try { res.writeHead(502); res.end(); } catch (_) {} });
    req.pipe(upstream);
  });

  // HTTPS (and anything else): Chromium issues CONNECT host:port and then speaks
  // TLS straight through. We just tunnel raw bytes across the SOCKS socket.
  server.on('connect', (req, clientSocket, head) => {
    const idx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, idx);
    const port = +req.url.slice(idx + 1);
    socks5Connect(proxy, host, port).then(({ socket, leftover }) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (leftover && leftover.length) clientSocket.write(leftover);
      if (head && head.length) socket.write(head);
      socket.pipe(clientSocket);
      clientSocket.pipe(socket);
      const bail = () => { socket.destroy(); clientSocket.destroy(); };
      socket.on('error', bail);
      clientSocket.on('error', bail);
    }).catch((err) => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.write(String(err && err.message ? err.message : err));
      } catch (_) {}
      clientSocket.destroy();
    });
  });

  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch (_) {} });
  return server;
}

// One bridge per unique upstream proxy, cached and reused across contexts.
const bridges = new Map();
const bridgeKey = (p) => `${p.host}:${p.port}:${p.username || ''}:${p.password || ''}`;

// Only SOCKS5 needs the bridge – Chromium handles HTTP/HTTPS proxies (incl.
// auth) natively, and SOCKS4 has no username/password to smuggle.
function needsBridge(proxy) {
  return !!proxy && proxy.scheme === 'socks5';
}

function startBridge(proxy) {
  return new Promise((resolve, reject) => {
    const server = createBridgeServer(proxy);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function getBridge(proxy) {
  const key = bridgeKey(proxy);
  let bridge = bridges.get(key);
  if (bridge) return bridge;
  bridge = await startBridge(proxy);
  bridges.set(key, bridge);
  return bridge;
}

// Turn a parsed proxy into the object Playwright's `proxy` option expects.
// SOCKS5 proxies are transparently routed through a local bridge; everything
// else is passed straight to Chromium.
async function playwrightProxy(proxy) {
  if (!proxy) return undefined;
  if (needsBridge(proxy)) {
    const bridge = await getBridge(proxy);
    return { server: bridge.url };
  }
  return {
    server: proxy.server,
    username: proxy.username ?? undefined,
    password: proxy.password ?? undefined,
  };
}

async function closeAll() {
  const all = [...bridges.values()];
  bridges.clear();
  await Promise.all(all.map((b) => b.close().catch(() => {})));
}

process.on('exit', () => {
  for (const b of bridges.values()) { try { b.server.close(); } catch (_) {} }
});

module.exports = { playwrightProxy, needsBridge, socks5Connect, closeAll };
