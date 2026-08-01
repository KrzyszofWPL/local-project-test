/**
 * Discord Quest Bot – Account Panel (local web UI)
 *
 * Reads tokens from tokens.txt, fetches each account's profile from Discord,
 * and serves a small local web page that lists every account with:
 *   - a round Discord avatar
 *   - the full display name (+ @username)
 *   - the full email address
 *   - a "⋮" menu at the end of the row with a "Copy token" action
 *
 * Run:
 *   node panel.js                 (opens on http://localhost:4747)
 *   set PORT=8080 && node panel.js   (Windows – custom port)
 *   PORT=8080 node panel.js          (Linux/Mac – custom port)
 *
 * The panel is bound to localhost only, so it is reachable from this
 * machine and never exposed to the network.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const PORT = parseInt(process.env.PORT || '4747', 10);
const HOST = '127.0.0.1';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0.9165 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────────────────────────────────────
function readTokens() {
	if (!fs.existsSync(TOKENS_FILE)) return [];
	return fs.readFileSync(TOKENS_FILE, 'utf-8')
		.split('\n').map((t) => t.trim()).filter((t) => t.length > 0);
}

function buildAvatarUrl(user) {
	if (user.avatar) {
		const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
		return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
	}
	// Default (embed) avatar
	let index = 0;
	try {
		if (user.discriminator && user.discriminator !== '0') {
			index = parseInt(user.discriminator, 10) % 5;
		} else {
			index = Number((BigInt(user.id) >> 22n) % 6n);
		}
	} catch (_) { index = 0; }
	return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function fetchAccount(token, index) {
	const base = { index, token };
	try {
		const res = await fetch('https://discord.com/api/v9/users/@me', {
			headers: {
				'Authorization': token,
				'Content-Type': 'application/json',
				'User-Agent': USER_AGENT
			}
		});

		if (res.status === 401) return { ...base, ok: false, error: 'Invalid or expired token' };
		if (res.status === 429) return { ...base, ok: false, error: 'Rate limited – try again shortly' };
		if (!res.ok) return { ...base, ok: false, error: `Discord error (HTTP ${res.status})` };

		const u = await res.json();
		const username = u.discriminator && u.discriminator !== '0'
			? `${u.username}#${u.discriminator}`
			: u.username;

		return {
			...base,
			ok: true,
			id: u.id,
			displayName: u.global_name || u.username || 'Unknown',
			username,
			email: u.email || 'No email on this account',
			avatarUrl: buildAvatarUrl(u)
		};
	} catch (e) {
		return { ...base, ok: false, error: e.message || 'Network error' };
	}
}

async function getAccounts() {
	const tokens = readTokens();
	const results = new Array(tokens.length);
	const limit = Math.min(5, tokens.length || 1);
	let cursor = 0;
	const worker = async () => {
		while (cursor < tokens.length) {
			const i = cursor++;
			results[i] = await fetchAccount(tokens[i], i);
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));
	return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Front-end page (self-contained: inline CSS + JS, no external assets)
// ─────────────────────────────────────────────────────────────────────────────
const PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Account Panel · Discord Quest Bot</title>
<style>
	:root {
		--bg: #1e1f22;
		--panel: #2b2d31;
		--panel-2: #313338;
		--row-hover: #35373c;
		--text: #f2f3f5;
		--muted: #b5bac1;
		--faint: #949ba4;
		--accent: #5865f2;
		--accent-hover: #4752c4;
		--danger: #f23f42;
		--border: #3f4147;
		--ok: #23a55a;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		font-family: "gg sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		background: var(--bg);
		color: var(--text);
		-webkit-font-smoothing: antialiased;
	}
	.wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
	header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
	h1 { font-size: 22px; margin: 0; font-weight: 700; }
	.subtitle { color: var(--faint); font-size: 13px; margin-top: 4px; }
	.actions-top { display: flex; align-items: center; gap: 10px; }
	button.btn {
		background: var(--accent); color: #fff; border: 0; border-radius: 8px;
		padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
		transition: background .15s ease;
	}
	button.btn:hover { background: var(--accent-hover); }
	button.btn.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
	button.btn.secondary:hover { background: var(--row-hover); }

	.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: visible; }
	.list-head, .row {
		display: grid;
		grid-template-columns: 56px minmax(160px, 1.3fr) minmax(180px, 1.4fr) 48px;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
	}
	.list-head {
		color: var(--faint); font-size: 11px; text-transform: uppercase;
		letter-spacing: .5px; font-weight: 700; border-bottom: 1px solid var(--border);
	}
	.row { border-bottom: 1px solid var(--border); position: relative; }
	.row:last-child { border-bottom: 0; }
	.row:hover { background: var(--row-hover); }

	.avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--panel-2); }
	.avatar.placeholder { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 16px; }

	.name-cell { min-width: 0; }
	.display-name { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.username { color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.email-cell { color: var(--muted); font-size: 14px; word-break: break-all; }
	.email-cell.error { color: var(--danger); }

	.menu-cell { position: relative; display: flex; justify-content: flex-end; }
	.dots {
		width: 34px; height: 34px; border-radius: 8px; border: 0; cursor: pointer;
		background: transparent; color: var(--muted); font-size: 20px; line-height: 1;
		display: flex; align-items: center; justify-content: center; transition: background .15s ease;
	}
	.dots:hover, .dots.open { background: var(--panel-2); color: var(--text); }

	.menu {
		position: absolute; top: 40px; right: 0; z-index: 20;
		background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0,0,0,.4); min-width: 168px; padding: 6px;
		display: none;
	}
	.menu.open { display: block; }
	.menu-item {
		display: flex; align-items: center; gap: 8px; width: 100%;
		background: transparent; border: 0; color: var(--text); cursor: pointer;
		font-size: 14px; text-align: left; padding: 8px 10px; border-radius: 6px;
	}
	.menu-item:hover { background: var(--accent); color: #fff; }
	.menu-item:disabled { color: var(--faint); cursor: not-allowed; }
	.menu-item:disabled:hover { background: transparent; color: var(--faint); }

	.state { padding: 48px 16px; text-align: center; color: var(--faint); }
	.badge-error { display: inline-block; font-size: 11px; color: var(--danger); border: 1px solid var(--danger);
		border-radius: 20px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }

	.toast {
		position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
		background: var(--ok); color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 14px;
		font-weight: 600; opacity: 0; pointer-events: none; transition: all .25s ease; z-index: 100;
	}
	.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
	.toast.err { background: var(--danger); }

	.count { color: var(--faint); font-size: 13px; }
	@media (max-width: 640px) {
		.list-head { display: none; }
		.row { grid-template-columns: 48px 1fr 40px; grid-template-areas: "av name menu" "av email menu"; row-gap: 2px; }
		.avatar { grid-area: av; }
		.name-cell { grid-area: name; }
		.email-cell { grid-area: email; }
		.menu-cell { grid-area: menu; }
	}
</style>
</head>
<body>
<div class="wrap">
	<header>
		<div>
			<h1>Account Panel</h1>
			<div class="subtitle">Accounts loaded from <code>tokens.txt</code></div>
		</div>
		<div class="actions-top">
			<span class="count" id="count"></span>
			<button class="btn secondary" id="refresh">Refresh</button>
		</div>
	</header>

	<div class="card">
		<div class="list-head">
			<div>Avatar</div>
			<div>Account</div>
			<div>Email</div>
			<div></div>
		</div>
		<div id="rows">
			<div class="state">Loading accounts…</div>
		</div>
	</div>
</div>

<div class="toast" id="toast"></div>

<script>
const rowsEl = document.getElementById('rows');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');
let openMenu = null;

function showToast(msg, isError) {
	toastEl.textContent = msg;
	toastEl.className = 'toast show' + (isError ? ' err' : '');
	clearTimeout(showToast._t);
	showToast._t = setTimeout(() => { toastEl.className = 'toast'; }, 2000);
}

async function copyToken(token, btn) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(token);
		} else {
			const ta = document.createElement('textarea');
			ta.value = token;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.focus(); ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		}
		showToast('Token copied to clipboard');
	} catch (e) {
		showToast('Could not copy token', true);
	}
	closeMenu();
}

function closeMenu() {
	if (openMenu) {
		openMenu.menu.classList.remove('open');
		openMenu.dots.classList.remove('open');
		openMenu = null;
	}
}

document.addEventListener('click', () => closeMenu());

function makeRow(acc) {
	const row = document.createElement('div');
	row.className = 'row';

	// Avatar
	if (acc.ok && acc.avatarUrl) {
		const img = document.createElement('img');
		img.className = 'avatar';
		img.src = acc.avatarUrl;
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		img.onerror = () => { img.replaceWith(placeholderAvatar()); };
		row.appendChild(img);
	} else {
		row.appendChild(placeholderAvatar());
	}

	// Name
	const nameCell = document.createElement('div');
	nameCell.className = 'name-cell';
	const dn = document.createElement('div');
	dn.className = 'display-name';
	if (acc.ok) {
		dn.textContent = acc.displayName;
	} else {
		dn.textContent = 'Unknown account';
		const badge = document.createElement('span');
		badge.className = 'badge-error';
		badge.textContent = 'error';
		dn.appendChild(badge);
	}
	const un = document.createElement('div');
	un.className = 'username';
	un.textContent = acc.ok ? '@' + acc.username : 'Token #' + (acc.index + 1);
	nameCell.appendChild(dn);
	nameCell.appendChild(un);
	row.appendChild(nameCell);

	// Email
	const emailCell = document.createElement('div');
	emailCell.className = 'email-cell' + (acc.ok ? '' : ' error');
	emailCell.textContent = acc.ok ? acc.email : acc.error;
	row.appendChild(emailCell);

	// Menu (three dots)
	const menuCell = document.createElement('div');
	menuCell.className = 'menu-cell';

	const dots = document.createElement('button');
	dots.className = 'dots';
	dots.type = 'button';
	dots.title = 'More';
	dots.textContent = '⋮';

	const menu = document.createElement('div');
	menu.className = 'menu';

	const copyBtn = document.createElement('button');
	copyBtn.className = 'menu-item';
	copyBtn.type = 'button';
	copyBtn.textContent = 'Copy token';
	copyBtn.disabled = !acc.token;
	copyBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		copyToken(acc.token, copyBtn);
	});

	menu.appendChild(copyBtn);

	dots.addEventListener('click', (e) => {
		e.stopPropagation();
		const isOpen = openMenu && openMenu.menu === menu;
		closeMenu();
		if (!isOpen) {
			menu.classList.add('open');
			dots.classList.add('open');
			openMenu = { menu, dots };
		}
	});

	menuCell.appendChild(dots);
	menuCell.appendChild(menu);
	row.appendChild(menuCell);

	return row;
}

function placeholderAvatar() {
	const el = document.createElement('div');
	el.className = 'avatar placeholder';
	el.textContent = '?';
	return el;
}

async function load() {
	rowsEl.innerHTML = '<div class="state">Loading accounts…</div>';
	countEl.textContent = '';
	try {
		const res = await fetch('/api/accounts');
		const accounts = await res.json();
		rowsEl.innerHTML = '';
		if (!accounts.length) {
			rowsEl.innerHTML = '<div class="state">No accounts found. Add tokens to <code>tokens.txt</code> (one per line).</div>';
			return;
		}
		for (const acc of accounts) rowsEl.appendChild(makeRow(acc));
		const okCount = accounts.filter((a) => a.ok).length;
		countEl.textContent = okCount + ' of ' + accounts.length + ' account(s) loaded';
	} catch (e) {
		rowsEl.innerHTML = '<div class="state">Failed to load accounts. Is the server still running?</div>';
	}
}

document.getElementById('refresh').addEventListener('click', load);
load();
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
	const url = (req.url || '/').split('?')[0];

	if (url === '/' || url === '/index.html') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(PAGE);
		return;
	}

	if (url === '/api/accounts') {
		try {
			const accounts = await getAccounts();
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(accounts));
		} catch (e) {
			res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end('Not found');
});

function openBrowser(target) {
	const platform = process.platform;
	const cmd = platform === 'win32' ? `start "" "${target}"`
		: platform === 'darwin' ? `open "${target}"`
		: `xdg-open "${target}"`;
	exec(cmd, () => { /* best-effort; ignore failures */ });
}

server.listen(PORT, HOST, () => {
	const tokenCount = readTokens().length;
	const target = `http://localhost:${PORT}`;
	console.log('╔══════════════════════════════════════════════════╗');
	console.log('║   Discord Quest Bot  –  Account Panel            ║');
	console.log('╚══════════════════════════════════════════════════╝');
	console.log(`Accounts in tokens.txt : ${tokenCount}`);
	console.log(`Panel URL              : ${target}`);
	console.log('Press Ctrl+C to stop the panel.\n');
	openBrowser(target);
});
