import test from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkFragment,
  parseHash,
  readRoute,
  routeKind,
  sessionFragment,
  withRoute,
  writeSessionRoute,
  type Route,
} from "../src/web/lib/hash.ts";

const EMPTY: Route = {
  kind: "empty",
  sessionID: null,
  view: "trajectory",
  eventID: null,
  benchmarkQuery: "",
};

test("parseHash keeps the legacy session grammar", () => {
  assert.deepEqual(parseHash("#/s/ses_1/trajectory"), {
    kind: "session",
    sessionID: "ses_1",
    view: "trajectory",
    eventID: null,
    benchmarkQuery: "",
  });
  assert.deepEqual(parseHash("#/s/ses_1/statistics"), {
    kind: "session",
    sessionID: "ses_1",
    view: "statistics",
    eventID: null,
    benchmarkQuery: "",
  });
  assert.deepEqual(parseHash("#/s/ses_1/trajectory?event=msg%3A1"), {
    kind: "session",
    sessionID: "ses_1",
    view: "trajectory",
    eventID: "msg:1",
    benchmarkQuery: "",
  });
  // An unknown or missing view segment is the Trajectory view.
  assert.equal(parseHash("#/s/ses_1/elsewhere").view, "trajectory");
  assert.equal(parseHash("#/s/ses_1").view, "trajectory");
  assert.equal(parseHash("#/s/ses_1/").view, "trajectory");
  // Empty segments are dropped before the grammar sees them.
  assert.equal(parseHash("#/s//ses_1/statistics").sessionID, "ses_1");
  assert.equal(parseHash("#s/ses_1/statistics").view, "statistics");
  // Percent-encoded ids round-trip through decodeURIComponent.
  assert.equal(parseHash("#/s/ses%201").sessionID, "ses 1");
});

test("parseHash falls back to the empty trajectory route", () => {
  for (const hash of ["", "#", "#/", "#/nope", "#/s", "#/statistics"]) {
    assert.deepEqual(parseHash(hash), EMPTY, hash);
  }
});

test("parseHash keeps the benchmark route and its raw filter string", () => {
  assert.deepEqual(parseHash("#/benchmark"), {
    kind: "benchmark",
    sessionID: null,
    view: "benchmark",
    eventID: null,
    benchmarkQuery: "",
  });
  assert.deepEqual(parseHash("#/benchmark?from=1&to=2"), {
    kind: "benchmark",
    sessionID: null,
    view: "benchmark",
    eventID: null,
    benchmarkQuery: "from=1&to=2",
  });
  assert.equal(benchmarkFragment(), "#/benchmark");
  assert.equal(benchmarkFragment("from=1"), "#/benchmark?from=1");
});

test("only ?event survives a session route; one-shot params are ignored", () => {
  const route = parseHash("#/s/ses_1/statistics?theme=dark&event=e1&palette=%7B%7D");
  assert.equal(route.eventID, "e1");
  // The fragment split is unchanged: a second "?" is not part of the query.
  assert.equal(parseHash("#/s/ses_1/trajectory?event=a?event=b").eventID, "a");
});

test("sessionFragment round-trips through parseHash", () => {
  const targets = [
    { sessionID: "ses_1", view: "trajectory", eventID: null },
    { sessionID: "ses_1", view: "statistics", eventID: null },
    { sessionID: "ses_1", view: "trajectory", eventID: "msg:1" },
    { sessionID: "ses 1/2", view: "statistics", eventID: "msg:1/2?x" },
  ] as const;
  for (const target of targets) {
    const fragment = sessionFragment(target);
    assert.equal(fragment.startsWith("#/s/"), true);
    const parsed = parseHash(fragment);
    assert.equal(parsed.sessionID, target.sessionID);
    assert.equal(parsed.view, target.view);
    assert.equal(parsed.eventID, target.eventID);
  }
  assert.equal(
    sessionFragment({ sessionID: "a b", view: "trajectory", eventID: null }),
    "#/s/a%20b/trajectory",
  );
});

test("writeSessionRoute mirrors updateHash", () => {
  const writes: string[] = [];
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      writes.push(url);
    },
  };
  const sessionRoute: Route = {
    kind: "session",
    sessionID: "ses_1",
    view: "statistics",
    eventID: "msg:1",
    benchmarkQuery: "",
  };

  // No session, no write.
  assert.equal(writeSessionRoute(history, "#/", { ...EMPTY }), false);
  assert.deepEqual(writes, []);

  // A different fragment is one replaceState, never a push or a reload.
  assert.equal(writeSessionRoute(history, "#/s/ses_1/trajectory", sessionRoute), true);
  assert.deepEqual(writes, ["#/s/ses_1/statistics?event=msg%3A1"]);

  // An identical fragment writes nothing.
  assert.equal(
    writeSessionRoute(history, "#/s/ses_1/statistics?event=msg%3A1", sessionRoute),
    false,
  );
  assert.equal(writes.length, 1);

  // One-shot params are dropped by a route write, exactly as legacy did.
  assert.equal(
    writeSessionRoute(history, "#/s/ses_1/trajectory?theme=dark&token=abc", {
      ...sessionRoute,
      view: "trajectory",
      eventID: null,
    }),
    true,
  );
  assert.equal(writes[1], "#/s/ses_1/trajectory");
});

test("withRoute recomputes the route kind", () => {
  const benchmark = parseHash("#/benchmark?x=1");
  const picked = withRoute(benchmark, { sessionID: "ses_9", view: "trajectory" });
  assert.equal(picked.kind, "session");
  assert.equal(picked.benchmarkQuery, "x=1");

  const cleared = withRoute(picked, { sessionID: null });
  assert.equal(cleared.kind, "empty");
  assert.equal(routeKind({ sessionID: null, view: "benchmark" }), "benchmark");
  assert.equal(routeKind({ sessionID: "ses_1", view: "statistics" }), "session");
});

test("readRoute guards a malformed escape without changing the grammar", () => {
  // parseHash stays verbatim: a bad escape throws, as the legacy parser did.
  assert.throws(() => parseHash("#/s/%E0%A4%A"));
  // The app-level reader is the only guard.
  assert.deepEqual(readRoute("#/s/%E0%A4%A"), EMPTY);
  assert.deepEqual(readRoute(null), EMPTY);
  assert.deepEqual(readRoute(""), EMPTY);
  assert.equal(readRoute("#/s/ses_1/statistics").view, "statistics");
});
