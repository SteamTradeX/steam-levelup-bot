# Provenance

Every file in this repository is either copied from SteamTradeX's own bot
(its private repository, commit `a6e990b158b1c0f25540a3acf82a36fe46177267`) and then cut down, or written
fresh for this edition. Nothing comes from any other bot, script or project.

## Copied, then trimmed

Copied by `tools/lite-extract/extract.mjs` (in the private repository) at
commit `a6e990b158b1c0f25540a3acf82a36fe46177267`, from a fixed allowlist. The only change the copy makes
is turning the workspace's package imports into relative ones; everything
after that is cutting down by hand: features deleted, and the few lines that
join what is left. This repository's history starts from the trimmed result;
the step-by-step trimming was kept privately with the extraction script.

| File here | Source in its private repository |
|---|---|
| `src/levels/index.ts` | `packages/levels/src/index.ts` |
| `src/levels/xp.ts` | `packages/levels/src/xp.ts` |
| `src/levels/xp.test.ts` | `packages/levels/src/xp.test.ts` |
| `src/levels/selection.ts` | `packages/levels/src/selection.ts` |
| `src/levels/selection.test.ts` | `packages/levels/src/selection.test.ts` |
| `src/levels/offer-state.ts` | `packages/levels/src/offer-state.ts` |
| `src/levels/offer-state.test.ts` | `packages/levels/src/offer-state.test.ts` |
| `src/levels/inventory.ts` | `packages/levels/src/inventory.ts` |
| `src/levels/inventory.test.ts` | `packages/levels/src/inventory.test.ts` |
| `src/levels/events.ts` | `packages/levels/src/events.ts` |
| `src/levels/events.test.ts` | `packages/levels/src/events.test.ts` |
| `src/levels/reservation.ts` | `packages/levels/src/reservation.ts` |
| `src/levels/reservation.test.ts` | `packages/levels/src/reservation.test.ts` |
| `src/levels/card-db.ts` | `packages/levels/src/card-db.ts` |
| `src/levels/card-db.test.ts` | `packages/levels/src/card-db.test.ts` |
| `src/levels/rates.ts` | `packages/levels/src/rates.ts` |
| `src/levels/rates.test.ts` | `packages/levels/src/rates.test.ts` |
| `src/levels/fixtures/inventory-page.json` | `packages/levels/src/fixtures/inventory-page.json` |
| `src/trading/index.ts` | `packages/trading/src/index.ts` |
| `src/trading/assets.ts` | `packages/trading/src/assets.ts` |
| `src/trading/assets.test.ts` | `packages/trading/src/assets.test.ts` |
| `src/trading/poller.ts` | `packages/trading/src/poller.ts` |
| `src/trading/poller.test.ts` | `packages/trading/src/poller.test.ts` |
| `src/trading/reconcile.ts` | `packages/trading/src/reconcile.ts` |
| `src/trading/reconcile.test.ts` | `packages/trading/src/reconcile.test.ts` |
| `src/config/index.ts` | `packages/config/src/index.ts` |
| `src/config/types.ts` | `packages/config/src/types.ts` |
| `src/config/settings.ts` | `packages/config/src/settings.ts` |
| `src/config/validate.ts` | `packages/config/src/validate.ts` |
| `src/config/commands.ts` | `packages/config/src/commands.ts` |
| `src/config/currencies.ts` | `packages/config/src/currencies.ts` |
| `src/config/secret.ts` | `packages/config/src/secret.ts` |
| `src/config/secret.test.ts` | `packages/config/src/secret.test.ts` |
| `src/config/switches.ts` | `packages/config/src/switches.ts` |
| `src/config/switches.test.ts` | `packages/config/src/switches.test.ts` |
| `src/config/document.ts` | `packages/config/src/document.ts` |
| `src/config/document.test.ts` | `packages/config/src/document.test.ts` |
| `src/config/registry.test.ts` | `packages/config/src/registry.test.ts` |
| `src/steam/index.ts` | `packages/steam/src/index.ts` |
| `src/steam/sign-in-budget.ts` | `packages/steam/src/sign-in-budget.ts` |
| `src/steam/steam-libs.d.ts` | `packages/steam/src/steam-libs.d.ts` |
| `src/steam/session.ts` | `packages/steam/src/session.ts` |
| `src/steam/session.test.ts` | `packages/steam/src/session.test.ts` |
| `src/steam/login-errors.ts` | `packages/steam/src/login-errors.ts` |
| `src/steam/login-errors.test.ts` | `packages/steam/src/login-errors.test.ts` |
| `src/steam/trade-offers.ts` | `packages/steam/src/trade-offers.ts` |
| `src/steam/trade-offers.test.ts` | `packages/steam/src/trade-offers.test.ts` |
| `src/steam/trade-hold-api.ts` | `packages/steam/src/trade-hold-api.ts` |
| `src/steam/trade-hold-api.test.ts` | `packages/steam/src/trade-hold-api.test.ts` |
| `src/steam/offer-check.ts` | `packages/steam/src/offer-check.ts` |
| `src/steam/offer-check.test.ts` | `packages/steam/src/offer-check.test.ts` |
| `src/steam/badges.ts` | `packages/steam/src/badges.ts` |
| `src/steam/badges.test.ts` | `packages/steam/src/badges.test.ts` |
| `src/steam/profile.ts` | `packages/steam/src/profile.ts` |
| `src/steam/profile.test.ts` | `packages/steam/src/profile.test.ts` |
| `src/steam/sign-in-storms.test.ts` | `packages/steam/src/sign-in-storms.test.ts` |
| `src/steam/trade-offer-language.test.ts` | `packages/steam/src/trade-offer-language.test.ts` |
| `src/steam/chat/parser.ts` | `packages/steam/src/chat/parser.ts` |
| `src/steam/chat/parser.test.ts` | `packages/steam/src/chat/parser.test.ts` |
| `src/steam/chat/dispatch.ts` | `packages/steam/src/chat/dispatch.ts` |
| `src/steam/chat/dispatch.test.ts` | `packages/steam/src/chat/dispatch.test.ts` |
| `src/steam/chat/format.ts` | `packages/steam/src/chat/format.ts` |
| `src/steam/chat/format.test.ts` | `packages/steam/src/chat/format.test.ts` |
| `src/steam/chat/handlers.ts` | `packages/steam/src/chat/handlers.ts` |
| `src/steam/chat/handlers.test.ts` | `packages/steam/src/chat/handlers.test.ts` |
| `src/steam/chat/snapshot.ts` | `packages/steam/src/chat/snapshot.ts` |
| `src/steam/providers/types.ts` | `packages/steam/src/providers/types.ts` |
| `src/steam/providers/steam-shape.ts` | `packages/steam/src/providers/steam-shape.ts` |
| `src/steam/providers/fake-http.ts` | `packages/steam/src/providers/fake-http.ts` |
| `src/steam/providers/steamtradex.ts` | `packages/steam/src/providers/steamtradex.ts` |
| `src/steam/providers/steamtradex.test.ts` | `packages/steam/src/providers/steamtradex.test.ts` |
| `src/steam/listings/types.ts` | `packages/steam/src/listings/types.ts` |
| `src/steam/listings/http.ts` | `packages/steam/src/listings/http.ts` |
| `src/steam/listings/fixtures.ts` | `packages/steam/src/listings/fixtures.ts` |
| `src/steam/fixtures/badges-page.html` | `packages/steam/src/fixtures/badges-page.html` |
| `src/steam/listings/registry.ts` | `packages/steam/src/listings/registry.ts` |
| `src/steam/listings/steamtradex.ts` | `packages/steam/src/listings/steamtradex.ts` |
| `src/steam/listings/steamtradex.test.ts` | `packages/steam/src/listings/steamtradex.test.ts` |
| `src/home.ts` | `apps/bot/src/home.ts` |
| `src/engine/engine.ts` | `apps/bot/src/engine/engine.ts` |
| `src/engine/ports.ts` | `apps/bot/src/engine/ports.ts` |
| `src/engine/services.ts` | `apps/bot/src/engine/services.ts` |
| `src/engine/fake-steam.ts` | `apps/bot/src/engine/fake-steam.ts` |
| `src/engine/engine.test.ts` | `apps/bot/src/engine/engine.test.ts` |
| `src/engine/desk.ts` | `apps/bot/src/engine/desk.ts` |
| `src/engine/desk.test.ts` | `apps/bot/src/engine/desk.test.ts` |
| `src/engine/offer-loop.ts` | `apps/bot/src/engine/offer-loop.ts` |
| `src/engine/offer-loop.test.ts` | `apps/bot/src/engine/offer-loop.test.ts` |
| `src/engine/files.ts` | `apps/bot/src/engine/files.ts` |
| `src/engine/files.test.ts` | `apps/bot/src/engine/files.test.ts` |
| `src/engine/confirm-gate.ts` | `apps/bot/src/engine/confirm-gate.ts` |
| `src/engine/confirm-gate.test.ts` | `apps/bot/src/engine/confirm-gate.test.ts` |
| `src/engine/chat-transport.ts` | `apps/bot/src/engine/chat-transport.ts` |
| `src/engine/chat-transport.test.ts` | `apps/bot/src/engine/chat-transport.test.ts` |
| `src/engine/stock.ts` | `apps/bot/src/engine/stock.ts` |
| `src/engine/stock.test.ts` | `apps/bot/src/engine/stock.test.ts` |
| `src/engine/customer.ts` | `apps/bot/src/engine/customer.ts` |
| `src/engine/customer.test.ts` | `apps/bot/src/engine/customer.test.ts` |
| `src/engine/items.ts` | `apps/bot/src/engine/items.ts` |
| `src/engine/items.test.ts` | `apps/bot/src/engine/items.test.ts` |
| `src/engine/trade-holds.ts` | `apps/bot/src/engine/trade-holds.ts` |
| `src/engine/trade-holds.test.ts` | `apps/bot/src/engine/trade-holds.test.ts` |
| `src/engine/offer-message.ts` | `apps/bot/src/engine/offer-message.ts` |
| `src/engine/offer-message.test.ts` | `apps/bot/src/engine/offer-message.test.ts` |
| `src/engine/inventory-services.ts` | `apps/bot/src/engine/inventory-services.ts` |
| `src/engine/inventory-services.test.ts` | `apps/bot/src/engine/inventory-services.test.ts` |
| `src/engine/listings.ts` | `apps/bot/src/engine/listings.ts` |
| `src/engine/listings.test.ts` | `apps/bot/src/engine/listings.test.ts` |
| `vendor/languages/LICENSE` | `tools/stx-bot-release/vendor/languages/LICENSE` |
| `vendor/languages/README.md` | `tools/stx-bot-release/vendor/languages/README.md` |
| `vendor/languages/index.js` | `tools/stx-bot-release/vendor/languages/index.js` |
| `vendor/languages/package.json` | `tools/stx-bot-release/vendor/languages/package.json` |
| `vendor/languages-0.1.4-stx.tgz` | `tools/stx-bot-release/vendor/languages-0.1.4-stx.tgz` |
| `LICENSE` | `tools/stx-bot-release/vendor/languages/LICENSE` (the same MIT text, "Copyright (c) 2026 SteamTradeX") |

Cut down the furthest (most of the source deleted, what is left reworded to
fit): `src/steam/chat/handlers.ts` (six commands of about eighty),
`src/steam/chat/dispatch.ts`, `src/config/settings.ts` (16 settings of
about 120, plus `bot.helpLeadLine`), `src/config/document.ts`,
`src/config/switches.ts`, `src/config/currencies.ts`, `src/engine/engine.ts`,
`src/engine/desk.ts`, `src/engine/services.ts`, `src/engine/items.ts`,
`src/engine/stock.ts`, `src/engine/inventory-services.ts` (SteamTradeX's
Inventory API and Steam only), `src/steam/listings/registry.ts` and
`src/steam/listings/fixtures.ts` (SteamTradeX's bot list only), and their
tests. `src/engine/offer-message.test.ts` keeps only the cases for TF2 keys.

`vendor/languages/README.md` is reworded for this repository, and
`vendor/languages-0.1.4-stx.tgz` packed again from `vendor/languages/` with
`npm pack` so the tarball holds the same words (its `integrity` in
`package-lock.json` changed with it).

## Written fresh for this edition

| File | What it is |
|---|---|
| `src/start.ts` | The command line (`init`, `start`), the checks before a sign in, and the one-run lock. `readIdentitySecret` and `isGuardSecret` in it are copied from `apps/bot/src/runtime.ts` at the same commit. |
| `src/start.test.ts` | Its tests, and the run from a folder to a sent offer on the in-memory Steam. |
| `settings.example.json` | Generated by `settingsTemplate()` in `src/home.ts`: every setting's default and help. |
| `THIRD-PARTY-NOTICES.md` | Generated from `npm ls --all --omit=dev` and each package's own licence. |
| `README.md` | What the bot is, how it compares with the full bot, the install steps, settings, safety and FAQ. |
| `scripts/publish-scan.mjs`, `scripts/publish-scan.test.mjs` | The check run on the tree and the whole git history before anything is published, and its tests. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `.gitattributes` | Project files. |
| `PROVENANCE.md` | This record. |
