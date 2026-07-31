const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0.9165 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
const FALLBACK_BUILD_NUMBER = 332858;

let superProperties = makeSuperProperties(FALLBACK_BUILD_NUMBER);

function makeSuperProperties(buildNumber) {
	return Buffer.from(JSON.stringify({
		os: "Windows",
		browser: "Discord Client",
		release_channel: "stable",
		client_version: "1.0.9165",
		os_version: "10.0.26100",
		system_locale: "pl",
		browser_user_agent: BASE_USER_AGENT,
		client_build_number: buildNumber,
		native_build_number: 55903
	})).toString('base64');
}

// Discord API zwraca pola w snake_case; obsłuż obie konwencje.
function questField(obj, camel, snake) {
	return obj?.[camel] ?? obj?.[snake];
}

function getExpiresAt(quest) {
	return questField(quest.config, 'expiresAt', 'expires_at');
}

function getUserStatus(quest) {
	return questField(quest, 'userStatus', 'user_status') ?? {};
}

function getTaskConfig(quest) {
	return questField(quest.config, 'taskConfig', 'task_config')
		?? questField(quest.config, 'taskConfigV2', 'task_config_v2');
}

async function fetchDiscordBuildNumber() {
	try {
		const res = await fetch('https://discord.com/login', {
			headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36' }
		});
		const html = await res.text();

		// Próbuj różne wzorce nazewnictwa plików JS (hexowe i alfanumeryczne)
		const scripts = [
			...[...html.matchAll(/src="\/assets\/([a-f0-9]+\.js)"/g)].map(m => m[1]),
			...[...html.matchAll(/src="\/assets\/([a-zA-Z0-9]+\.js)"/g)].map(m => m[1]),
		];
		const unique = [...new Set(scripts)];

		for (const file of unique.slice(-8).reverse()) {
			try {
				const jsRes = await fetch(`https://discord.com/assets/${file}`, {
					headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36' }
				});
				const js = await jsRes.text();
				// Kilka wzorców jak Discord może osadzić numer build
				const match = js.match(/[Bb]uild\s*[Nn]umber['":\s]+(\d{4,7})/)
					?? js.match(/buildNumber['":\s]+(\d{4,7})/)
					?? js.match(/CLIENT_BUILD_NUMBER['":\s]+(\d{4,7})/);
				if (match) return parseInt(match[1]);
			} catch (_) { /* pomiń plik */ }
		}
	} catch (_) { /* ciche niepowodzenie */ }
	return null;
}

function createFetcher(token) {
	return async (endpoint, options = {}) => {
		const headers = {
			'Authorization': token.trim(),
			'Content-Type': 'application/json',
			'User-Agent': BASE_USER_AGENT,
			'X-Super-Properties': superProperties,
			'X-Discord-Locale': 'pl-PL',
			'X-Discord-Timezone': 'Europe/Warsaw',
			...options.headers
		};

		const res = await fetch(`https://discord.com/api/v9${endpoint}`, { ...options, headers });
		const contentType = res.headers.get('content-type');
		let data = null;
		if (contentType?.includes('application/json')) {
			data = await res.json();
		}
		if (!res.ok) {
			const err = new Error(res.statusText || `HTTP ${res.status}`);
			err.status = res.status;
			err.data = data;
			throw err;
		}
		return data;
	};
}

function createGatewaySession(token) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
		let heartbeatInterval = null;
		let resolved = false;

		const cleanup = () => { clearInterval(heartbeatInterval); ws.close(); };

		const timeoutId = setTimeout(() => {
			if (!resolved) { resolved = true; cleanup(); reject(new Error('Gateway READY timeout (30s)')); }
		}, 30000);

		ws.onopen = () => {};

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data);
			const { op, d } = data;

			if (op === 10) {
				heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), d.heartbeat_interval);
				ws.send(JSON.stringify({
					op: 2,
					d: {
						token: token.trim(),
						capabilities: 30717,
						properties: JSON.parse(Buffer.from(superProperties, 'base64').toString('ascii')),
						presence: { status: "online", since: 0, activities: [], afk: false }
					}
				}));
			}

			if (op === 0 && data.t === 'READY' && !resolved) {
				resolved = true;
				clearTimeout(timeoutId);
				resolve({
					setPresence: (appId, gameName) => {
						ws.send(JSON.stringify({
							op: 3,
							d: {
								status: "online",
								since: 0,
								activities: [{ name: gameName, type: 0, application_id: appId, timestamps: { start: Date.now() } }],
								afk: false
							}
						}));
					},
					stop: () => { clearTimeout(timeoutId); cleanup(); }
				});
			}
		};

		ws.onerror = (err) => {
			if (!resolved) { resolved = true; clearTimeout(timeoutId); cleanup(); reject(err); }
		};
	});
}

async function collectQuests(fetcher) {
	const seen = new Set();
	const quests = [];

	const add = (list) => {
		for (const q of (Array.isArray(list) ? list : [])) {
			if (q?.id && !seen.has(q.id)) { seen.add(q.id); quests.push(q); }
		}
	};

	// 1. Questy do których konto jest zapisane
	try {
		const me = await fetcher('/quests/@me');
		if (Array.isArray(me)) add(me);
		else if (me && typeof me === 'object') {
			add(me.quests);
			add(me.eligible_quests);
			console.log(`  [Debug] /quests/@me → ${JSON.stringify(me).substring(0, 180)}`);
		}
	} catch (e) { if (e.status === 401) throw e; }

	// 2. Questy do odkrycia przez placement (zasila zakładkę Discover → Quests)
	const placements = [
		'QUESTS_TAB', 'QUEST_BAR', 'LIBRARY_CONTEXTUAL_QUEST',
		'DISCOVER', 'LIBRARY', 'QUEST_HOME', 'GAME_LIBRARY', 'ACTIVITY'
	];
	for (const p of placements) {
		try {
			const r = await fetcher(`/quests/decision?placement=${p}`);
			if (r?.quest) add([r.quest]);
			add(r?.quests);
		} catch (_) { /* placement nieobsługiwany – ignoruj */ }
	}

	// 3. placement-alpha (eksperymentalny endpoint)
	try {
		const r = await fetcher('/quests/placement-alpha');
		if (r?.quest) add([r.quest]);
		add(r?.quests);
		if (r) console.log(`  [Debug] /quests/placement-alpha → ${JSON.stringify(r).substring(0, 180)}`);
	} catch (_) {}

	return quests;
}

async function processAccount(token, index, total) {
	const fetcher = createFetcher(token);
	console.log(`========================================`);
	console.log(`[Konto ${index}/${total}] Token: ${token.substring(0, 12)}...`);

	let gatewaySession = null;
	try {
		try {
			gatewaySession = await createGatewaySession(token);
			console.log(`  [WS] Połączono z Gateway – sesja aktywna.`);
		} catch (e) {
			console.log(`  [!] Błąd połączenia Gateway WS: ${e.message}`);
		}

		const quests = await collectQuests(fetcher);
		console.log(`  [Info] Znaleziono questów łącznie: ${quests.length}`);

		// Obsłuż zarówno camelCase jak i snake_case z API
		const now = Date.now();
		const pendingQuests = quests.filter((q) => {
			const status = getUserStatus(q);
			const expiresAt = getExpiresAt(q);
			const completedAt = status.completedAt ?? status.completed_at;
			const expires = new Date(expiresAt).getTime();
			return !completedAt && !isNaN(expires) && expires > now;
		});

		if (pendingQuests.length === 0) {
			if (quests.length === 0) {
				console.log("  [Info] Brak questów na koncie.");
				console.log("  [Wskazówka] Wejdź w Discord → Discover → Quests → kliknij 'Accept'");
				console.log("             na wybranym queście, a następnie uruchom skrypt ponownie.");
			} else {
				console.log("  [Info] Wszystkie znalezione questy są już ukończone lub wygasły.");
			}
			return;
		}

		for (const quest of pendingQuests) {
			const status = getUserStatus(quest);
			const taskConfig = getTaskConfig(quest);
			const questName = quest.config?.messages?.questName
				?? quest.config?.messages?.quest_name
				?? "Nieznany Quest";

			if (!taskConfig?.tasks) continue;

			const taskName = Object.keys(taskConfig.tasks)[0];
			const taskData = taskConfig.tasks[taskName];
			const appId = quest.config?.application?.id ?? taskData?.applications?.[0]?.id;
			const targetSeconds = taskData.target;
			const gameName = quest.config?.application?.name ?? "Game";

			const enrolledAt = status.enrolledAt ?? status.enrolled_at;
			const progressVal = (status.progress ?? status.progress)?.[taskName]?.value;
			let doneSeconds = progressVal ?? 0;

			if (!enrolledAt) {
				try {
					await fetcher(`/quests/${quest.id}/enroll`, {
						method: 'POST',
						body: JSON.stringify({ location: "QUESTS_TAB" })
					});
					console.log(`  [+] Zapisano do questu: ${questName}`);
				} catch (e) {
					console.log(`  [!] Nie udało się zapisać do questu: ${e.message} – pomijam.`);
					continue;
				}
			}

			if (appId && gatewaySession) {
				gatewaySession.setPresence(appId, gameName);
				console.log(`      [WS] Sfałszowano status gry: ${gameName}`);
			}

			console.log(`  [+] Uruchamianie spoofa dla: ${questName} (Wymagane: ${targetSeconds}s)`);

			while (doneSeconds < targetSeconds) {
				await delay(20 * 1000);
				try {
					const res = await fetcher(`/quests/${quest.id}/heartbeat`, {
						method: 'POST',
						body: JSON.stringify({ stream_key: "call:0:1", terminal: false })
					});

					const resStatus = res?.userStatus ?? res?.user_status ?? {};
					doneSeconds = resStatus?.progress?.[taskName]?.value ?? (doneSeconds + 20);
					console.log(`      Postęp: ${Math.min(doneSeconds, targetSeconds)}/${targetSeconds}s`);

					if (doneSeconds >= targetSeconds) {
						await fetcher(`/quests/${quest.id}/heartbeat`, {
							method: 'POST',
							body: JSON.stringify({ stream_key: "call:0:1", terminal: true })
						});
						break;
					}
				} catch (err) {
					console.error(`      [!] Błąd heartbeat: ${err.message}`);
					break;
				}
			}

			console.log(`  [✓] Sukces! Ukończono quest: ${questName}`);
		}

	} catch (err) {
		if (err.status === 401) {
			console.error(`  [ERR] Token nieprawidłowy lub wygasł (401 Unauthorized).`);
		} else {
			console.error(`  [ERR] Błąd konta: ${err.message}`);
		}
	} finally {
		if (gatewaySession) gatewaySession.stop();
	}
}

async function main() {
	if (!fs.existsSync(TOKENS_FILE)) {
		console.log("[!] Brak pliku tokens.txt");
		return;
	}

	process.stdout.write('[Init] Pobieranie aktualnego build number Discord... ');
	const buildNumber = await fetchDiscordBuildNumber();
	if (buildNumber) {
		superProperties = makeSuperProperties(buildNumber);
		console.log(`OK (${buildNumber})`);
	} else {
		console.log(`nieudane, używam fallback: ${FALLBACK_BUILD_NUMBER}`);
	}

	const tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
		.split('\n').map(t => t.trim()).filter(t => t.length > 0);

	console.log(`Wczytano ${tokens.length} tokenów. Rozpoczynanie procesu...\n`);

	for (let i = 0; i < tokens.length; i++) {
		await processAccount(tokens[i], i + 1, tokens.length);
		await delay(2000);
	}

	console.log("\n[DONE] Wrzucanie zakończone dla wszystkich kont.");
}

main();
