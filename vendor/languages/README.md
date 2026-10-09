# languages (SteamTradeX stand-in)

Our own MIT module installed in place of the npm package `languages@0.1.3`
(GPL). steam-tradeoffer-manager calls `getLanguageInfo(code).name` once, when
it is given a `language` option; this answers it for the languages Steam
offers.

It is installed by one entry in this repository's `package.json`
`dependencies`, pointing at `vendor/languages-<version>-stx.tgz`. Its version
is a plain release inside steam-tradeoffer-manager's `^0.1.3`, so npm installs
this one copy at the top of `node_modules` and the manager uses it.

To change it: edit `index.js`, raise the version in `package.json` (0.1.5,
and so on), then from this folder

    npm pack --pack-destination ..

rename the new file in `vendor/` to `languages-<version>-stx.tgz`, delete the
old one, point the `languages` entry in the root `package.json` at the new
file, and run `npm install` once at the repository root. Afterwards
`npm ls languages` must show one copy, this one, deduped under
steam-tradeoffer-manager.
