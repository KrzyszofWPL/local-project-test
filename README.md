# Discord Quest Bot

Local control panel that completes Discord quests for several accounts at once.
Everything runs on your own machine – nothing is uploaded anywhere.

## Running it

```
npm install          # once
npm start            # panel on http://localhost:3000
```

On Windows, double-clicking `start.bat` does both and opens the browser for you.

| Command         | What it does                                    |
| --------------- | ----------------------------------------------- |
| `npm start`     | Control panel on <http://localhost:3000>        |
| `npm run cli`   | Same work without a UI, straight in the console |

## Accounts – `tokens.txt`

One account token per line. The **Accounts** view then shows, for every account:
its avatar, its full display name and `@handle`, its full e-mail address, the
proxy it uses, its state, quest count and orbs. The `⋮` menu at the end of each
row copies the token, the e-mail or the user ID, and can test the proxy.

Tokens are never part of the live state the page receives – the panel asks the
server for one only when you click **Copy token**.

## Proxies – `ip.txt`

Discord rate limits per IP address (`429`), so running several accounts from one
connection throttles all of them and looks like exactly what it is. Put one proxy
per line in `ip.txt` and account #1 leaves through proxy #1, account #2 through
proxy #2, and so on:

```
host:port
host:port:user:pass
user:pass@host:port
http://user:pass@host:port
socks5://host:port
```

No scheme means HTTP. Lines starting with `#` are ignored. If there are fewer
proxies than accounts the list wraps around and some accounts share an IP – the
panel warns you when that happens.

Chromium cannot authenticate to SOCKS proxies, so use HTTP proxies whenever a
login is required.

Turn the whole thing on and off under **Settings → Network**, reload the file with
**Reload ip.txt**, and use **Test proxy** in an account's `⋮` menu to see the exit
IP that proxy actually gives you. Each account also checks its own exit IP right
before logging in, so a dead proxy is reported as a dead proxy instead of looking
like a bad token.

### Where to get proxies

Discord is suspicious of datacenter IP ranges, so **residential** or **mobile**
proxies work far better than cheap datacenter ones. Ask the vendor for **sticky
sessions** – an IP that stays the same for 10+ minutes – because a proxy that
rotates mid-quest breaks long `PLAY_ON_DESKTOP` runs.

- **Residential, sticky sessions** – IPRoyal, Decodo (formerly Smartproxy), SOAX,
  Bright Data, Oxylabs, NetNut, Proxy-Cheap. Sold per GB; a quest run uses very
  little traffic, so the smallest plan usually covers a lot of accounts.
- **Cheap datacenter / ISP** – Webshare (10 free proxies after signing up),
  ProxyScrape, Storm Proxies. Fine for checking that the wiring works, more
  likely to be flagged in day-to-day use.
- **Mobile (4G/5G)** – the most trusted by Discord and the most expensive. Worth
  it only for accounts you care about.

**Avoid free public proxy lists.** Whoever runs the proxy sees your traffic, and
these tokens are full account access – a free list is an easy way to lose every
account at once.

## Settings

| Setting                  | Meaning                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| **Concurrency**          | How many accounts run at once. Each Chromium context uses ~350 MB RAM.        |
| **Show browser windows** | Turns off headless mode – needed to solve a CAPTCHA by hand.                   |
| **Orb quests only**      | Skips quests that only reward cosmetics.                                       |
| **Desktop mode**         | Spoofs the desktop client. Required for game quests, may hide the quest list. |
| **Proxies**              | Route every account through its own IP from `ip.txt`.                          |

Solved CAPTCHAs and sessions are remembered per account under `profiles/`, so an
account normally needs verifying only once.

## Files

| File           | Contents                                            |
| -------------- | --------------------------------------------------- |
| `tokens.txt`   | Account tokens, one per line                        |
| `ip.txt`       | Proxies, one per line                               |
| `server.js`    | HTTP server and API for the panel                   |
| `engine.js`    | Account state, browser contexts, proxy assignment   |
| `proxies.js`   | `ip.txt` parser                                     |
| `inject.js`    | Script injected into the Discord page               |
| `browser.js`   | Console runner (`npm run cli`)                      |

`tokens.txt` and `ip.txt` hold credentials – do not commit real ones.
