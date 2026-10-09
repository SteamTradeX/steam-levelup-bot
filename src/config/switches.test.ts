import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, findCommand } from "./commands.js";
import { COMMAND_SECTIONS } from "./switches.js";

test("every command sits in exactly one section", () => {
  for (const command of COMMANDS) {
    const holders = COMMAND_SECTIONS.filter((section) => section.holds(command));
    assert.equal(holders.length, 1, `${command.name} is in ${holders.length} sections`);
  }
});
