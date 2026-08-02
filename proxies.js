const fs = require('fs');
const path = require('path');

const PROXY_FILE = path.join(__dirname, 'ip.txt');
const SCHEMES = ['http', 'https', 'socks5', 'socks4'];

const isPort = (s) => /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;

function parseLine(line) {
  let rest = line.trim();
  let scheme = 'http';

  const withScheme = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (withScheme) {
    scheme = withScheme[1].toLowerCase();
    rest = withScheme[2];
    if (!SCHEMES.includes(scheme)) {
      throw new Error(`unsupported scheme "${scheme}" (use ${SCHEMES.join(', ')})`);
    }
  }
  rest = rest.replace(/\/+$/, '');
  if (!rest) throw new Error('empty entry');

  let username = null;
  let password = null;
  let hostPart = rest;

  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    const looksLikeHost = (s) => {
      const p = s.split(':');
      return p.length === 2 && isPort(p[1]);
    };

    let creds;
    if (looksLikeHost(right)) { creds = left; hostPart = right; }
    else if (looksLikeHost(left)) { creds = right; hostPart = left; }
    else { creds = left; hostPart = right; }

    const sep = creds.indexOf(':');
    if (sep === -1) throw new Error('credentials must be user:pass');
    username = decodeURIComponent(creds.slice(0, sep));
    password = decodeURIComponent(creds.slice(sep + 1));
  }

  const parts = hostPart.split(':');
  let host, port;

  if (parts.length === 2) {
    [host, port] = parts;
  } else if (parts.length === 4 && at === -1) {
    if (isPort(parts[1])) {
      [host, port, username, password] = parts;
    } else if (isPort(parts[3])) {
      [username, password, host, port] = parts;
    } else {
      throw new Error('cannot tell which field is the port');
    }
  } else {
    throw new Error('expected host:port (optionally with user:pass)');
  }

  host = String(host).trim();
  port = String(port).trim();
  if (!host) throw new Error('missing host');
  if (!isPort(port)) throw new Error(`invalid port "${port}"`);

  return {
    scheme,
    host,
    port: +port,
    username: username || null,
    password: password || null,
    server: `${scheme}://${host}:${port}`,
    label: `${host}:${port}`,
    auth: !!username,
  };
}

function loadProxies(file = PROXY_FILE) {
  const result = { file, exists: false, proxies: [], errors: [] };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
    result.exists = true;
  } catch (_) {
    return result;
  }

  const seen = new Set();
  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    try {
      const proxy = parseLine(trimmed);
      const key = `${proxy.server}|${proxy.username || ''}`;
      if (seen.has(key)) {
        result.errors.push({ line: i + 1, text: trimmed, error: 'duplicate – skipped' });
        return;
      }
      seen.add(key);
      result.proxies.push(proxy);
    } catch (e) {
      result.errors.push({ line: i + 1, text: trimmed, error: e.message });
    }
  });

  return result;
}

function proxyUrl(proxy) {
  if (!proxy) return '';
  const creds = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.scheme}://${creds}${proxy.host}:${proxy.port}`;
}

module.exports = { loadProxies, parseLine, proxyUrl, PROXY_FILE };
