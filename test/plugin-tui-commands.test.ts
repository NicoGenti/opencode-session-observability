import test from "node:test";
import assert from "node:assert/strict";
import { parseStatsArg, tuiCommandDefinitions } from "../src/plugin/tui.ts";

const NATIVE_INPUTS: unknown[] = [undefined, "", "   ", "junk", 42];
const WEB_INPUTS: unknown[] = ["--web", "-w", "web", "WEB", "  --WeB  "];

test("parseStatsArg sends only the documented flags to the web UI", () => {
  for (const input of NATIVE_INPUTS) {
    assert.equal(
      parseStatsArg(input),
      "native",
      `input ${JSON.stringify(input) ?? String(input)}`,
    );
  }
  for (const input of WEB_INPUTS) {
    assert.equal(
      parseStatsArg(input),
      "web",
      `input ${JSON.stringify(input) ?? String(input)}`,
    );
  }
});

test("the command surface exposes the four Observability commands", () => {
  const commands = tuiCommandDefinitions(() => {});
  assert.equal(commands.length, 4);
  assert.deepEqual(
    commands.map((command) => command.id),
    [
      "observability.open",
      "observability.trajectory",
      "observability.statistics",
      "observability.statistics.web",
    ],
  );
  assert.deepEqual(
    commands.map((command) => command.slash.name),
    ["observability", "trajectory", "statistics", "statistics:web"],
  );
  for (const command of commands) {
    assert.equal(command.group, "Observability");
    assert.equal(command.palette, true);
  }
});

test("/statistics takes the raw argument and keeps the /stats alias", () => {
  const commands = tuiCommandDefinitions(() => {});
  const statistics = commands.find(
    (command) => command.id === "observability.statistics",
  );
  assert.ok(statistics);
  assert.deepEqual(statistics.slash.aliases, ["stats"]);
  assert.equal(statistics.slash.arguments, true);
});

test("/statistics:web exposes the stats:web alias without arguments", () => {
  const commands = tuiCommandDefinitions(() => {});
  const web = commands.find(
    (command) => command.id === "observability.statistics.web",
  );
  assert.ok(web);
  assert.deepEqual(web.slash.aliases, ["stats:web"]);
  assert.equal(web.slash.arguments, undefined);
});
