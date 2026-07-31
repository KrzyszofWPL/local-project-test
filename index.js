const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0.9165 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
const FALLBACK_BUILD_NUMBER = 332858;

let currentBuildNumber = FALLBACK_BUILD_NUMBER;
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

// Pobiera aktualny numer build Discorda ze stron klienta webowego.
// Discord nie zwraca questów klientom z nieaktualnym build number.
async function fetchDiscordBuildNumber() {
	try {
		const res = await fetch('https://discord.com/login', {
			headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36' }
		});
		const html = await res.text();

		// Wyodrębnij nazwy plików JS z atrybutów src
		const scripts = [...html.matchAll(/src="\/assets\/([a-f0-9]+\.js)"/g)].map(m => m[1]);

		// Build number jest zwykle w jednym z ostatnich chunków
		const toCheck = scripts.slice(-5).reverse();
		for (const file of toCheck) {
			const jsRes = await fetch(`https://discord.com/assets/${file}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36' }
			});
			const js = await jsRes.text();
			const match = js.match(/Build Number:\s*(\d+)/);
			if (match) return parseInt(match[1]);
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

		const res = await fetch(`https://discord.com/api/v9${endpoint}`, {
			...options,
			headers
		});
		const contentType = res.headers.get('content-type');
		let data = null;
		if (contentType && contentType.includes('application/json')) {
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

// Nawiązuje sesję Gateway (Identify → READY) i zwraca obiekt sesji.
// Nie otwiera nowego połączenia per quest – zamiast tego używa op:3 do zmiany presence.
function createGatewaySession(token) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
		let heartbeatInterval = null;
		let resolved = false;

		const cleanup = () => {
			clearInterval(heartbeatInterval);
			ws.close();
		};

		const timeoutId = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				cleanup();
				reject(new Error('Gateway READY timeout (30s)'));
			}
		}, 30000);

		ws.onopen = () => {};

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data);
			const { op, d } = data;

			// op:10 Hello – uruchom heartbeat i wyślij Identify
			if (op === 10) {
				heartbeatInterval = setInterval(() => {
					ws.send(JSON.stringify({ op: 1, d: null }));
				}, d.heartbeat_interval);

				ws.send(JSON.stringify({
					op: 2,
					d: {
						token: token.trim(),
						capabilities: 30717,
						properties: JSON.parse(Buffer.from(superProperties, 'base64').toString('ascii')),
						presence: {
							status: "online",
							since: 0,
							activities: [],
							afk: false
						}
					}
				}));
			}

			// op:0 READY – sesja aktywna, można teraz wywołać REST
			if (op === 0 && data.t === 'READY' && !resolved) {
				resolved = true;
				clearTimeout(timeoutId);
				resolve({
					// Zmień presence na istniejącym połączeniu (op:3) zamiast otwierać nowe WS
					setPresence: (appId, gameName) => {
						ws.send(JSON.stringify({
							op: 3,
							d: {
								status: "online",
								since: 0,
								activities: [{
									name: gameName,
									type: 0,
									application_id: appId,
									timestamps: { start: Date.now() }
								}],
								afk: false
							}
						}));
					},
					stop: () => {
						clearTimeout(timeoutId);
						cleanup();
					}
				});
			}
		};

		ws.onerror = (err) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeoutId);
				cleanup();
				reject(err);
			}
		};
	});
}

async function processAccount(token, index, total) {
	const fetcher = createFetcher(token);
	console.log(`========================================`);
	console.log(`[Konto ${index}/${total}] Token: ${token.substring(0, 12)}...`);

	let gatewaySession = null;

	try {
		// Krok 1: Nawiąż sesję Gateway przed wywołaniem REST
		try {
			gatewaySession = await createGatewaySession(token);
			console.log(`  [WS] Połączono z Gateway – sesja aktywna.`);
		} catch (e) {
			console.log(`  [!] Błąd połączenia Gateway WS: ${e.message}`);
		}

		// Krok 2: Pobierz questy PO ustanowieniu sesji Gateway.
		// /quests/@me zwraca tylko zapisane questy. Dostępne (niezapisane) questy
		// odkrywamy przez endpoint placement, który zasila zakładkę Discover → Quests.
		let quests = [];
		try {
			const seen = new Set();

			const addQuests = (list) => {
				for (const q of (Array.isArray(list) ? list : [])) {
					if (q?.id && !seen.has(q.id)) {
						seen.add(q.id);
						quests.push(q);
					}
				}
			};

			// Questy zapisane (in-progress)
			const meData = await fetcher('/quests/@me');
			if (Array.isArray(meData)) {
				addQuests(meData);
			} else if (meData && typeof meData === 'object') {
				addQuests(meData.quests);
				addQuests(meData.eligible_quests);
			}

			// Questy dostępne do odkrycia (zakładka Discover → Quests)
			for (const placement of ['QUESTS_TAB', 'QUEST_BAR', 'LIBRARY_CONTEXTUAL_QUEST']) {
				try {
					const placementData = await fetcher(`/quests/decision?placement=${placement}`);
					if (placementData?.quest) addQuests([placementData.quest]);
					addQuests(placementData?.quests);
				} catch (_) { /* placement może nie istnieć */ }
			}
		} catch (err) {
			if (err.status === 401) throw err;
			console.error(`  [!] Błąd pobierania questów: ${err.message}`);
		}

		console.log(`  [Info] Znaleziono questów łącznie: ${quests.length}`);

		const pendingQuests = quests.filter((x) =>
			!x.userStatus?.completedAt &&
			new Date(x.config?.expiresAt).getTime() > Date.now()
		);

		if (pendingQuests.length === 0) {
			console.log("  [Info] Brak aktywnych/nieukończonych questów na tym koncie.");
			return;
		}

		for (const quest of pendingQuests) {
			const questName = quest.config?.messages?.questName ?? "Nieznany Quest";
			const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
			if (!taskConfig || !taskConfig.tasks) continue;

			const taskName = Object.keys(taskConfig.tasks)[0];
			const taskData = taskConfig.tasks[taskName];
			const appId = quest.config?.application?.id ?? taskData?.applications?.[0]?.id;
			const targetSeconds = taskData.target;
			let doneSeconds = quest.userStatus?.progress?.[taskName]?.value ?? 0;
			const gameName = quest.config?.application?.name ?? "Game";

			if (!quest.userStatus?.enrolledAt) {
				try {
					await fetcher(`/quests/${quest.id}/enroll`, {
						method: 'POST',
						body: JSON.stringify({ location: "QUESTS_TAB" })
					});
					console.log(`  [+] Zapisano konto do questu: ${questName}`);
				} catch (e) {
					console.log(`  [!] Nie udało się zapisać do questu: ${e.message}`);
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

					doneSeconds = res?.userStatus?.progress?.[taskName]?.value ?? (doneSeconds + 20);
					console.log(`      Postęp: ${Math.min(doneSeconds, targetSeconds)}/${targetSeconds}s`);

					if (doneSeconds >= targetSeconds) {
						await fetcher(`/quests/${quest.id}/heartbeat`, {
							method: 'POST',
							body: JSON.stringify({ stream_key: "call:0:1", terminal: true })
						});
						break;
					}
				} catch (err) {
					console.error(`      [!] Błąd wysyłania postępu heartbeat: ${err.message}`);
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

	// Pobierz aktualny numer build przed uruchomieniem
	process.stdout.write('[Init] Pobieranie aktualnego build number Discord... ');
	const buildNumber = await fetchDiscordBuildNumber();
	if (buildNumber && buildNumber !== FALLBACK_BUILD_NUMBER) {
		currentBuildNumber = buildNumber;
		superProperties = makeSuperProperties(buildNumber);
		console.log(`OK (${buildNumber})`);
	} else if (buildNumber) {
		console.log(`OK (${buildNumber}, bez zmian)`);
	} else {
		console.log(`nieudane, używam fallback: ${FALLBACK_BUILD_NUMBER}`);
	}

	const tokens = fs.readFileSync(TOKENS_FILE, 'utf-8')
		.split('\n')
		.map(t => t.trim())
		.filter(t => t.length > 0);

	console.log(`Wczytano ${tokens.length} tokenów. Rozpoczynanie procesu...\n`);

	for (let i = 0; i < tokens.length; i++) {
		await processAccount(tokens[i], i + 1, tokens.length);
		await delay(2000);
	}

	console.log("\n[DONE] Wrzucanie zakończone dla wszystkich kont.");
}

main();
