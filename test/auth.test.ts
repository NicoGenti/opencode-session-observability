import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createObservabilityServer } from "../src/server/http.ts";
import { generateToken, tokenMatches } from "../src/server/auth.ts";
import { simpleFixture, writeFixtureDb } from "./fixtures/build.ts";

function request(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("an access token protects every data route", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const token = generateToken();
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    authToken: token,
  });
  try {
    const unauthorized = await request(server.port, "/api/sessions");
    assert.equal(unauthorized.status, 401);
    assert.equal(JSON.parse(unauthorized.body).error, "unauthorized");
    assert.match(unauthorized.headers["www-authenticate"] ?? "", /Bearer/);
    assert.doesNotMatch(unauthorized.body, new RegExp(token));

    const bearer = await request(server.port, "/api/sessions", {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(bearer.status, 200);

    const alternate = await request(server.port, "/api/sessions", {
      "X-Observability-Token": token,
    });
    assert.equal(alternate.status, 200);

    const lowercaseScheme = await request(server.port, "/api/sessions", {
      Authorization: `bearer ${token}`,
    });
    assert.equal(lowercaseScheme.status, 200);

    const wrong = await request(server.port, "/api/sessions", {
      Authorization: "Bearer wrong-token-value",
    });
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(wrong.body, new RegExp(token));

    const queryToken = await request(
      server.port,
      `/api/sessions?token=${encodeURIComponent(token)}`,
    );
    assert.equal(queryToken.status, 401);

    const encodedPath = await request(server.port, "/api%2Fsessions");
    assert.equal(encodedPath.status, 401);

    const traversal = await request(server.port, "/api/health/../sessions");
    assert.equal(traversal.status, 401);

    const unauthenticatedExport = await request(
      server.port,
      "/api/sessions/ses_simple/export?format=json",
    );
    assert.equal(unauthenticatedExport.status, 401);

    const authenticatedExport = await request(
      server.port,
      "/api/sessions/ses_simple/export?format=json",
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(authenticatedExport.status, 200);

    const health = await request(server.port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).authRequired, true);

    const forged = await request(server.port, "/api/sessions", {
      Host: `attacker.example:${server.port}`,
    });
    assert.equal(forged.status, 403);
  } finally {
    await server.close();
  }
});

test("authentication is checked before the reveal policy", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const token = generateToken();
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    authToken: token,
  });
  try {
    const noToken = await request(server.port, "/api/sessions?reveal=1");
    assert.equal(noToken.status, 401);

    const withToken = await request(server.port, "/api/sessions?reveal=1", {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(withToken.status, 403);
    assert.equal(JSON.parse(withToken.body).error, "reveal_disabled");
  } finally {
    await server.close();
  }
});

test("token comparison rejects missing, short and extended values", () => {
  const token = generateToken();
  assert.equal(token.length, 43);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, undefined), false);
  assert.equal(tokenMatches(token, null), false);
  assert.equal(tokenMatches(token, ""), false);
  assert.equal(tokenMatches(token, "x"), false);
  assert.equal(tokenMatches(token, `${token}x`), false);
});

test("non-loopback binds require a token", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  await assert.rejects(
    createObservabilityServer({ dbPath: path, host: "0.0.0.0", port: 0 }),
    /non-loopback hosts require authToken/,
  );
  await assert.rejects(
    createObservabilityServer({ dbPath: path, port: 0, authToken: "   " }),
    /authToken must not be empty/,
  );
});
