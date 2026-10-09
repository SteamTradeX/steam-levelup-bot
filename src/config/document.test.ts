import assert from "node:assert/strict";
import { test } from "node:test";
import { crossFieldIssues, defaultValues, validateValues } from "./document.js";

test("a fresh document validates, apart from having no rates yet", () => {
  const result = validateValues(defaultValues());
  assert.equal(result.ok, false);
  if (result.ok) return;
  /* TF2 keys are on by default with no rate set, which is exactly the
     thing a new owner must be told to fix before the bot starts. */
  const keys = result.issues.map((issue) => issue.key);
  assert.ok(keys.includes("rates.tf2.buy"));
});

test("a TF2 rate that asks for fewer sets than it gives is refused", () => {
  const issues = crossFieldIssues({ ...defaultValues(), "rates.tf2.buy": 7.5, "rates.tf2.sell": 7 });
  assert.ok(
    issues.some((issue) => issue.key === "rates.tf2.sell"),
    "giving 7.5 sets for a key and asking 7 back should be flagged",
  );
});

test("a TF2 rate that asks for more sets than it gives is accepted", () => {
  const issues = crossFieldIssues({ ...defaultValues(), "rates.tf2.buy": 7, "rates.tf2.sell": 7.5 });
  assert.equal(issues.some((issue) => issue.key === "rates.tf2.sell"), false);
});

test("a TF2 rate with buy equal to sell is accepted, for running at cost", () => {
  const issues = crossFieldIssues({ ...defaultValues(), "rates.tf2.buy": 7, "rates.tf2.sell": 7 });
  assert.equal(issues.some((issue) => issue.key === "rates.tf2.sell"), false);
});

test("an unknown setting is reported, not quietly stored", () => {
  const result = validateValues({ ...defaultValues(), "rates.doubloons.buy": 3 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.key === "rates.doubloons.buy"));
});

