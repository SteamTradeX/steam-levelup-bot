import assert from "node:assert/strict";
import { test } from "node:test";
import { readSteamProfile, type ProfileReader } from "./profile.js";

const ID = "76561198000000001";

function reader(user: unknown, error: Error | null = null): ProfileReader & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    getSteamUser(id, callback) {
      asked.push(id);
      callback(error, user);
    },
  };
}

test("a profile is asked for by SteamID object, never by a string the library would read as a custom name", async () => {
  const r = reader({ tradeBanState: "None", vacBanned: false, isLimitedAccount: false });
  await readSteamProfile(r, ID);
  assert.equal(typeof r.asked[0], "object");
  assert.equal(String(r.asked[0]), ID);
});

test("bans and limits are read off the profile", async () => {
  assert.deepEqual(await readSteamProfile(reader({ tradeBanState: "None", vacBanned: false, isLimitedAccount: false }), ID), {
    tradeBanned: false, vacBanned: false, limited: false,
  });
  assert.deepEqual(await readSteamProfile(reader({ tradeBanState: "Probation", vacBanned: true, isLimitedAccount: true }), ID), {
    tradeBanned: true, vacBanned: true, limited: true,
  });
});

test("a failed lookup rejects rather than passing the customer as clean", async () => {
  await assert.rejects(readSteamProfile(reader(undefined, new Error("No valid response")), ID));
  await assert.rejects(readSteamProfile(reader(undefined), ID));
});
