const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const superProperties = Buffer.from(JSON.stringify({
	os: "Windows",
	browser: "Discord Client",
	release_channel: "stable",
	client_version: "1.0.9165",
	os_version: "10.0.26100",
	system_locale: "pl",
	browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0.9165 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
	client_build_number: 332858,
	native_build_number: 55903
})).toString('base64');

function createFetcher(token) {
	const headers = {
		'Authorization': token.trim(),
		'Content-Type': 'application/json',
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0.9165 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36',
		'X-Super-Properties': superProperties,
		'X-Discord-Locale': 'pl-PL'
	};

	return async (endpoint, options = {}) => {
		const res = await fetch(`https://discord.com/api/v9${endpoint}`, {
			...options,
			headers: { ...headers, ...options.headers }
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

function spoofGamePresence(token, appId, gameName) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
		let heartbeatInterval = null;

		ws.onopen = () => {};

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data);
			const { op, d } = data;

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
							activities: [{
								name: gameName,
								type: 0,
								application_id: appId,
								timestamps: { start: Date.now() }
							}],
							afk: false
						}
					}
				}));
			}

			if (op === 0 && data.t === 'READY') {
				resolve({
					stop: () => {
						clearInterval(heartbeatInterval);
						ws.close();
					}
				});
			}
		};

		ws.onerror = (err) => reject(err);
	});
}

async function processAccount(token, index, total) {
	const fetcher = createFetcher(token);
	console.log(`========================================`);
	console.log(`[Konto ${index}/${total}] Token: ${token.substring(0, 12)}...`);

	try {
		let quests = [];
		try {
			const data = await fetcher('/quests/@me');
			quests = Array.isArray(data) ? data : (data?.quests ?? []);
		} catch (err) {
			if (err.status === 401) throw err;
			console.error(`  [!] Błąd pobierania questów: ${err.message}`);
		}

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

			console.log(`  [+] Uruchamianie spoofa dla: ${questName} (Wymagane: ${targetSeconds}s)`);

			let presenceSession = null;
			if (appId) {
				try {
					presenceSession = await spoofGamePresence(token, appId, gameName);
					console.log(`      [WS] Połączono z Gateway – sfałszowano status gry: ${gameName}`);
				} catch (e) {
					console.log(`      [!] Błąd połączenia Gateway WS: ${e.message}`);
				}
			}

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

			if (presenceSession) presenceSession.stop();
			console.log(`  [✓] Sukces! Ukończono quest: ${questName}`);
		}

	} catch (err) {
		if (err.status === 401) {
			console.error(`  [ERR] Token nieprawidłowy lub wygasł (401 Unauthorized).`);
		} else {
			console.error(`  [ERR] Błąd konta: ${err.message}`);
		}
	}
}

async function main() {
	if (!fs.existsSync(TOKENS_FILE)) {
		console.log("[!] Brak pliku tokens.txt");
		return;
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