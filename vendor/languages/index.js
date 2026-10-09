"use strict";

/*
 * SteamTradeX's own small module in place of the npm package "languages"
 * (0.1.3, GPL). steam-tradeoffer-manager makes one call to it, when it is
 * given a `language` option: require("languages").getLanguageInfo(code).name,
 * lowercased, which must be the name Steam's web API uses for that language.
 * So this holds only the languages Steam itself offers, keyed by their
 * ISO 639-1 code, written for this module. The three Chinese and Brazilian
 * variants never reach it: steam-tradeoffer-manager maps szh, tzh and br
 * itself. An unknown code answers {}, as the original did, which the manager
 * reads as "no language".
 */

/* code: [English name (its lowercase is Steam's name), the language's own name] */
var LANGUAGES = {
  ar: ["Arabic", "العربية"],
  bg: ["Bulgarian", "Български"],
  cs: ["Czech", "Čeština"],
  da: ["Danish", "Dansk"],
  de: ["German", "Deutsch"],
  el: ["Greek", "Ελληνικά"],
  en: ["English", "English"],
  es: ["Spanish", "Español"],
  fi: ["Finnish", "Suomi"],
  fr: ["French", "Français"],
  hu: ["Hungarian", "Magyar"],
  id: ["Indonesian", "Bahasa Indonesia"],
  it: ["Italian", "Italiano"],
  ja: ["Japanese", "日本語"],
  ko: ["Korean", "한국어"],
  nl: ["Dutch", "Nederlands"],
  no: ["Norwegian", "Norsk"],
  pl: ["Polish", "Polski"],
  pt: ["Portuguese", "Português"],
  ro: ["Romanian", "Română"],
  ru: ["Russian", "Русский"],
  sv: ["Swedish", "Svenska"],
  th: ["Thai", "ไทย"],
  tr: ["Turkish", "Türkçe"],
  uk: ["Ukrainian", "Українська"],
  vi: ["Vietnamese", "Tiếng Việt"]
};

/* Written right to left. */
var RTL = { ar: true };

function isValid(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

function getAllLanguageCode() {
  return Object.keys(LANGUAGES);
}

function getLanguageInfo(code) {
  if (!isValid(code)) return {};
  var entry = LANGUAGES[code];
  return { name: entry[0], nativeName: entry[1], direction: RTL[code] ? "rtl" : "ltr" };
}

module.exports = { isValid: isValid, getAllLanguageCode: getAllLanguageCode, getLanguageInfo: getLanguageInfo };
