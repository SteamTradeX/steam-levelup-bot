# Free Steam Level Up Bot (TF2 keys)

A free, open-source Steam level up bot. It sells Steam trading card sets for
TF2 keys and buys them back, picks only sets each customer can still craft,
and checks every trade offer item by item before it confirms it.

One bot, six chat commands, one settings file. MIT licensed. Runs on any
Linux server with Node.js 22.

> **Want more? The full SteamTradeX bot.**
>
> This free bot is the basics. The full bot adds a web dashboard, several
> bots from one install, gems and more currencies, automatic pricing, profit
> tracking, Telegram alerts and about eighty commands.
>
> - **Hosted by us:** 1 TF2 key a month per bot, first month free on your first bot. Nothing to install.
> - **Self-hosted:** the full bot and its dashboard on your own server, paid once.
>
> [See pricing](https://steamtradex.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
> &middot; [Try the live dashboard demo](https://steamtradex.com/bot-demo?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
> &middot; [Hosting](https://steamtradex.com/steam-bot-hosting?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
> &middot; [Self-hosted script](https://steamtradex.com/steam-level-up-bot-script?utm_source=github&utm_medium=readme&utm_campaign=free-bot)

## Free vs full

| | Free bot (this repo) | Full bot, hosted | Full bot, self-hosted |
|---|---|---|---|
| Price | Free, MIT | 1 TF2 key a month, first month free on your first bot | Paid once ([pricing](https://steamtradex.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=free-bot)) |
| Where it runs | Your server | Our servers | Your server |
| Set up and change it | `settings.json`, then a restart | Web dashboard | Web dashboard, installed with one command |
| Bots | One | As many as you like | Several from one install |
| Customers pay in | TF2 keys | TF2 keys, gems and more | TF2 keys, gems and more |
| Chat commands | 6 | About 80 | About 80 |
| Automatic pricing | No | Yes | Yes |
| Profit tracking | No | Yes | Yes |
| Telegram alerts | No | Yes | Yes |
| Owner commands in Steam chat | No | Yes | Yes |
| Updates | `git pull` | Done for you | Automatic, rolls back by itself if an update fails |
| Trade safety (below) | Yes | Yes | Yes |
| SteamTradeX bot list and Inventory API | Yes | Yes | Yes |

<!--
Screenshots of the full version, taken from the live demo at 1280 pixels
wide with demo data only, go here at publish time:

![The full bot's dashboard](docs/images/full-dashboard.png)
![Rates with automatic pricing](docs/images/full-rates.png)
![Several bots on the Fleet page](docs/images/full-fleet.png)
![The chat monitor](docs/images/full-chat-monitor.png)
![Trades and profit](docs/images/full-trades.png)
-->

> Screenshots of the full version are on their way. Until then, the
> [live demo](https://steamtradex.com/bot-demo?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
> is the real dashboard with made-up data: click around, nothing in it is live.

## What it does

Customers add the bot on Steam and message it:

| Command | What it does |
|---|---|
| `!HELP` | Lists the commands (`!COMMANDS` works too) |
| `!PRICES` | Shows your rates |
| `!CHECK` | Shows how many sets the customer can still use, from their badges |
| `!CHECKTF <keys>` | Shows what a number of keys would buy |
| `!BUYTF <keys>` | The customer pays keys and gets sets they have not crafted yet |
| `!SELLTF <keys>` | The customer sends sets and gets keys |

The bot reads the customer's badges, so it never sells more sets of a game
than the customer can still craft into that game's badge. It sends the trade offer itself and confirms it with Steam
Guard. Customers' own offers are always declined.

## Before you start

- A **Linux server** that stays online (Ubuntu 22.04 or 24.04, or Debian 12 or 13). 1 GB of memory is plenty.
- A **Steam account for the bot**, not your main account. It needs Steam Guard on a mobile authenticator, and you need its **shared secret** and **identity secret**: they are in the authenticator's `.maFile` (for example from Steam Desktop Authenticator). The account must not be limited, so it can trade.
- Some **card sets and TF2 keys** in the bot's inventory to trade with.

## Install on Linux

Every step is one block to copy into your server's terminal.

### 1. Install Node.js 22 and git

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh && sudo bash nodesource_setup.sh && sudo apt-get install -y nodejs git && node --version
```

**What you should see:** the last line is the Node.js version, starting `v22.`

**If you see something else:** `sudo: command not found` means you are
signed in as root: run the same line without the two `sudo ` words. A
version below `v22` means an older Node.js was already installed: run
`sudo apt-get remove -y nodejs` and the block again.

### 2. Download the bot

```bash
git clone https://github.com/SteamTradeX/steam-levelup-bot.git && cd steam-levelup-bot && npm ci --omit=dev
```

**What you should see:** a line starting `added` with the number of
packages, for example `added 142 packages in 12s`. Lines starting
`npm warn deprecated` are expected and harmless.

**If you see something else:** `npm: command not found` means step 1 did not
finish; run it again.

### 3. Make the bot's files

```bash
npm run init
```

**What you should see:**

```
Made settings.json, secrets.json, state in /home/you/steam-levelup-bot.
Next: put the bot account's Steam login in secrets.json and your rates in settings.json, then run: npm start -- --home "/home/you/steam-levelup-bot"
```

### 4. Add the bot's Steam login

```bash
nano secrets.json
```

Fill in the four values between the quotes, then press `Ctrl+O`, `Enter`,
`Ctrl+X` to save and close:

```json
{
  "accountName": "the bot's Steam login name",
  "password": "the bot's Steam password",
  "sharedSecret": "shared_secret from the .maFile",
  "identitySecret": "identity_secret from the .maFile"
}
```

**What you should see:** you are back at the prompt. The file is readable
by your user only, and `.gitignore` keeps it out of git.

### 5. Set your rates

```bash
nano settings.json
```

Change the two rates (see [Settings](#settings) for the rest), then save
the same way:

```json
"rates.tf2.buy": 7,
"rates.tf2.sell": 7.5,
```

`rates.tf2.buy` is how many sets a customer gets for one key. `rates.tf2.sell`
is how many sets a customer gives you for one key. Keep `sell` at or above
`buy`, or you lose sets on every round trip.

### 6. Start the bot

```bash
npm start
```

**What you should see:** after a few seconds,

```
... info Signing in to Steam as yourbot.
... info Running. Customers can message the bot now. Press Ctrl+C to stop.
```

Message the bot `!HELP` from another Steam account to try it.

**If you see something else:** lines starting `error` followed by
`Not starting: fix the lines above, then start again.` name each problem,
for example `secrets.json: password is empty` or a setting that is out of
range. Nothing has touched Steam yet. Fix the file, then run `npm start`
again. `this bot is already running` means another copy is running from
this folder: stop that one first.

### 7. Keep it running after you log out

Press `Ctrl+C` to stop the bot you started in step 6, then:

```bash
sudo tee /etc/systemd/system/steam-levelup-bot.service > /dev/null <<EOF
[Unit]
Description=Steam level up bot
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$PWD
ExecStart=$PWD/node_modules/.bin/tsx --disable-warning=DEP0040 src/start.ts start
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now steam-levelup-bot && sleep 15 && sudo journalctl -u steam-levelup-bot -n 5 --no-pager
```

**What you should see:** the last line ends `Running. Customers can message
the bot now. Press Ctrl+C to stop.` The bot now starts with the server.

**If you see something else:** an `error` line names the problem, as in
step 6. Fix it, then `sudo systemctl restart steam-levelup-bot`.
`sudo: command not found` means you are signed in as root: copy the block
again and leave out every `sudo ` (four of them), here and in the commands
below.

Everyday commands:

```bash
sudo journalctl -u steam-levelup-bot -f         # watch the log (Ctrl+C to stop watching)
sudo systemctl restart steam-levelup-bot        # after changing settings.json
sudo systemctl stop steam-levelup-bot           # stop the bot
```

## Settings

All settings live in `settings.json`, under `values`. The bot checks the
whole file before it signs in to Steam and refuses to start on a mistake,
naming it. `settings.example.json` has every setting with its default and a
`help` line for each.

**Settings are read once, when the bot starts. After changing
`settings.json`, restart the bot** (`Ctrl+C` and `npm start`, or
`sudo systemctl restart steam-levelup-bot`).

| Setting | Default | What it does |
|---|---|---|
| `rates.tf2.buy` | 0 | Sets a customer gets for one key (`!BUYTF`). Must be set. |
| `rates.tf2.sell` | 0 | Sets a customer gives you for one key (`!SELLTF`). Keep it at or above `rates.tf2.buy`. |
| `currencies.tf2.enabled` | true | Turn off to stop trading keys without losing your rates. |
| `stock.maxPerGame` | 100 | The most sets of one game the bot holds; it stops buying that game beyond this. |
| `limits.maxSetsPerBuy` | 500 | The most sets one customer can buy in one trade. |
| `limits.maxSetsPerSell` | 500 | The most sets one customer can sell in one trade. |
| `limits.maxCustomerLevel` | 6666 | Customers above this Steam level are not served. 0 removes the limit. |
| `filters.rejectTradeBanned` | true | Refuse trade-banned accounts. |
| `filters.rejectVacBanned` | false | Refuse VAC-banned accounts. |
| `filters.rejectLimitedAccounts` | false | Refuse limited accounts. |
| `filters.minSteamLevel` | 0 | The lowest customer level served. |
| `filters.allowTradeHolds` | false | Trade with customers whose trades Steam would hold for days. |
| `bot.disabledCommands` | [] | Commands to switch off, for example `["!SELLTF"]`. |
| `bot.helpLeadLine` | true | The one line at the end of `!HELP` that says who made the bot (below). |
| `providers.steamTradeX.inventoryKey` | "" | Your SteamTradeX Inventory API key (below). Optional. |
| `providers.steamTradeX.listingKey` | "" | Your SteamTradeX Listing API key (below). Optional. |
| `providers.steamTradeX.updateCatalog` | true | Send your stock and rates to the SteamTradeX bot list while a listing key is set. |

## The two SteamTradeX API keys (optional)

Both are optional; the bot trades without them.

**Listing API key: get customers from the SteamTradeX bot list.** Listing is
free. [List your bot](https://steamtradex.com/bots/add?utm_source=github&utm_medium=readme&utm_campaign=free-bot),
then open [Manage bots](https://steamtradex.com/bots/manage?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
and copy the bot's Listing API key into `providers.steamTradeX.listingKey`.
The bot then keeps its stock and rates current on the list every 30 minutes.
[How listing works](https://steamtradex.com/guides/list-your-bot?utm_source=github&utm_medium=readme&utm_campaign=free-bot).

**Inventory API key: reliable inventory reads.** Steam limits how often one
server may read inventories, and a busy bot runs into it. The
[SteamTradeX Inventory API](https://steamtradex.com/inventory-api?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
reads customers' inventories for the bot instead, with free requests to try
it. Create a key under
[Inventory API keys](https://steamtradex.com/dashboard/api/keys?utm_source=github&utm_medium=readme&utm_campaign=free-bot)
(it starts `inv_`) and put it in `providers.steamTradeX.inventoryKey`. When
the service cannot answer, the bot reads from Steam itself.

Restart the bot after adding either key.

## Safety

The parts of the full bot that keep the bot's account and items safe are all
here, unchanged:

- **Never accepts an offer it did not send.** Customers' offers, gifts
  included, are declined.
- **Checks before it confirms.** Every offer the bot sends is read back from
  Steam and compared item by item with what was asked for. Anything different
  is cancelled, never confirmed.
- **Sign-in budget.** At most 6 sign-ins an hour and 30 a day, remembered
  across restarts, so a crash loop cannot get the account locked. One
  session per account, and a lock so the same folder never runs twice.
- **Never renames the account.** The bot only sets itself online.
- **Trade holds caught early.** A customer whose trade Steam would hold is
  told before anything is sent (unless you allow it).
- **Remembers what is in flight.** Open offers and reserved items are saved
  and checked against Steam at the next start, so a restart never sells the
  same set twice.
- **Private files.** `secrets.json` and everything under `state/` are
  readable by your user only and written so a crash never leaves half a file.
- **Event cards are held**, never sold as a game's set.

## The !HELP line

`!HELP` ends with one line:

```
Made with the free SteamTradeX bot: steamtradex.com
```

It appears only in `!HELP`, never in a trade reply. It is how this free bot
pays for itself, and we would be grateful if you kept it. To turn it off,
set `"bot.helpLeadLine": false` in `settings.json` and restart the bot.

## Updating

```bash
git pull && npm ci --omit=dev && sudo systemctl restart steam-levelup-bot
```

**What you should see:** `added ... packages`, then nothing more. The log
(`sudo journalctl -u steam-levelup-bot -n 5 --no-pager`) ends with `Running.`

## FAQ

**Is it really free?** Yes. MIT licence: use it, change it, sell with it.

**Can I run more than one bot?** One bot per copy. For several bots, copy
the folder once per bot account and give each its own service name. The
full bot runs several from one install with one dashboard.

**Does it trade gems?** No, TF2 keys only. The full bot trades gems and more.

**Why did it decline my offer?** It declines every offer it did not send
itself. Message it a command and it sends you the offer.

**Where does my Steam password go?** Only to Steam. The SteamTradeX keys
send the bot list your stock and rates (listing key), and ask for
customers' inventories (Inventory API key). Nothing else leaves your server.

**Does it work on Windows?** It is written for Linux. It runs anywhere
Node.js 22 does (`npm run init`, then `npm start`), but the steps above are
for Linux.

**Can I test it without a Steam account?** `npm test` runs the whole test
suite against an in-memory Steam. Nothing reaches the internet.

**I want a dashboard / several bots / automatic prices.** That is the
[full bot](https://steamtradex.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=free-bot),
hosted (first month free on your first bot) or on your own server.

## Licence

[MIT](LICENSE), copyright SteamTradeX. The libraries it uses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Every file is our own code;
[PROVENANCE.md](PROVENANCE.md) records where each came from.

---

Made by [SteamTradeX](https://steamtradex.com/?utm_source=github&utm_medium=readme&utm_campaign=free-bot): Steam bot hosting, the bot list and the Inventory API.
