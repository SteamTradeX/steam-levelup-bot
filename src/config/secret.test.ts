import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { Secret, secret } from "./secret.js";

/**
 * These tests are the whole value of the type. Each one is a real route by
 * which a password reaches a log file, and the point is that all of them are
 * closed at once rather than remembered one at a time.
 */

const password = secret("correct horse battery staple");

test("string interpolation does not print it", () => {
  assert.equal(`${password}`, "[redacted]");
});

test("concatenation does not print it", () => {
  assert.equal(password + "", "[redacted]");
});

test("JSON does not print it, including nested in an object", () => {
  assert.equal(JSON.stringify(password), '"[redacted]"');
  assert.equal(
    JSON.stringify({ steam: { password, username: "example_bot" } }),
    '{"steam":{"password":"[redacted]","username":"example_bot"}}',
  );
});

test("console.log and util.inspect do not print it", () => {
  assert.equal(inspect(password), "[redacted]");
  assert.ok(!inspect({ password }, { depth: 5 }).includes("horse"));
});

test("the value is still there when deliberately asked for", () => {
  assert.equal(password.reveal(), "correct horse battery staple");
});

test("an empty secret says so", () => {
  assert.equal(secret("").isEmpty, true);
  assert.equal(secret(undefined).isEmpty, true);
  assert.equal(password.isEmpty, false);
});

test("the fingerprint is stable, short, and not the value", () => {
  const again = new Secret("correct horse battery staple");
  assert.equal(password.fingerprint(), again.fingerprint());
  assert.equal(password.fingerprint().length, 12);
  assert.equal(secret("").fingerprint(), "");
  assert.ok(!password.fingerprint().includes("horse"));
});

test("different secrets fingerprint differently", () => {
  assert.notEqual(secret("a").fingerprint(), secret("b").fingerprint());
});

test("comparison works and does not need the value unwrapped", () => {
  assert.equal(password.equals(new Secret("correct horse battery staple")), true);
  assert.equal(password.equals(secret("something else")), false);
  assert.equal(password.equals(secret("")), false);
});
