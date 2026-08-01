/**
 * Proxy list – ip.txt
 *
 * One proxy per line. Every common format you get from a proxy vendor is
 * accepted, so a list can be pasted in as-is:
 *
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   user:pass:host:port
 *   http://user:pass@host:port
 *   socks5://host:port
 *
 * Lines starting with # or // are ignored, so the file can carry notes.
 * Without a scheme the proxy is assumed to be HTTP, which is what virtually
 * every residential/datacenter vendor hands out.
 */

const fs = require('fs');
const path = require('path');

const PROXY_FILE = path.join(__dirname, 'ip.txt');
const SCHEMES = ['http', 'https', 'socks5', 'socks4'];

const isPort = (s) => /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;

/** Parses a single line into a proxy object, or throws with a readable reason. */
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

  // user:pass@host:port – split on the last @ so passwords may contain one.
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const creds = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
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
    // Colon-separated credentials: either host:port:user:pass or
    // user:pass:host:port. The numeric field decides which one it is.
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
    /** What Playwright wants – credentials are passed separately. */
    server: `${scheme}://${host}:${port}`,
    /** Safe to show in the panel: never contains credentials. */
    label: `${host}:${port}`,
    auth: !!username,
  };
}

/**
 * Reads ip.txt.
 *
 * Never throws: a missing or broken file must not take the panel down, so
 * problems come back as data the UI can show.
 */
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

/** Full proxy URL including credentials – only for the copy action. */
function proxyUrl(proxy) {
  if (!proxy) return '';
  const creds = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.scheme}://${creds}${proxy.host}:${proxy.port}`;
}

module.exports = { loadProxies, parseLine, proxyUrl, PROXY_FILE };
