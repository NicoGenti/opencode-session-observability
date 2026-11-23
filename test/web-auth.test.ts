import test from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_PROMPT_COPY,
  TOKEN_STORAGE_KEY,
  authHeaders,
  clearToken,
  consumeTokenFromLocation,
  getStoredToken,
  readTokenFromHash,
  storeToken,
} from "../src/web/lib/auth.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

test("reads and strips the token from the route fragment", () => {
  assert.deepEqual(readTokenFromHash("#/?token=abc"), {
    token: "abc",
    cleanHash: "#/",
  });
  assert.deepEqual(readTokenFromHash("#token=abc"), {
    token: "abc",
    cleanHash: "#/",
  });
  assert.deepEqual(
    readTokenFromHash("#/s/ses_1/trajectory?event=msg%3A1&token=abc"),
    {
      token: "abc",
      cleanHash: "#/s/ses_1/trajectory?event=msg%3A1",
    },
  );
  assert.deepEqual(readTokenFromHash("#/s/ses_1"), {
    token: null,
    cleanHash: "#/s/ses_1",
  });
  assert.deepEqual(readTokenFromHash(""), { token: null, cleanHash: "" });
});

test("token storage and headers are defensive", () => {
  const storage = memoryStorage();
  storeToken("abc", storage);
  assert.equal(getStoredToken(storage), "abc");
  assert.deepEqual(storage.keys(), ["observability-token"]);
  assert.equal(TOKEN_STORAGE_KEY, "observability-token");
  clearToken(storage);
  assert.equal(getStoredToken(storage), null);
  assert.deepEqual(storage.keys(), []);

  assert.deepEqual(authHeaders(" abc "), { Authorization: "Bearer abc" });
  assert.deepEqual(authHeaders(null), {});
  assert.deepEqual(authHeaders(""), {});
  assert.deepEqual(authHeaders(undefined), {});

  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(getStoredToken(broken), null);
  assert.doesNotThrow(() => storeToken("abc", broken));
  assert.doesNotThrow(() => clearToken(broken));
});

test("consuming a URL token stores it and cleans the address bar", () => {
  const storage = memoryStorage();
  const replaced: string[] = [];
  const location = {
    hash: "#/s/ses_1/trajectory?event=msg%3A1&token=abc",
    pathname: "/",
    search: "",
  };
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      replaced.push(url);
    },
  };

  assert.equal(consumeTokenFromLocation(location, history, storage), "abc");
  assert.equal(getStoredToken(storage), "abc");
  assert.deepEqual(replaced, ["/#/s/ses_1/trajectory?event=msg%3A1"]);

  const noToken = { hash: "#/s/ses_1", pathname: "/", search: "" };
  assert.equal(consumeTokenFromLocation(noToken, history, storage), "abc");
  assert.equal(consumeTokenFromLocation(null, history, storage), "abc");
  assert.equal(consumeTokenFromLocation(undefined, undefined, storage), "abc");
});

test("a failed address-bar cleanup keeps the consumed token", () => {
  const storage = memoryStorage();
  const history = {
    replaceState() {
      throw new Error("SecurityError");
    },
  };
  const location = { hash: "#/?token=abc", pathname: "/", search: "" };
  assert.equal(consumeTokenFromLocation(location, history, storage), "abc");
  assert.equal(getStoredToken(storage), "abc");
});

test("the prompt copy follows the house copy discipline", () => {
  const short = [
    TOKEN_PROMPT_COPY.title,
    TOKEN_PROMPT_COPY.label,
    TOKEN_PROMPT_COPY.placeholder,
    TOKEN_PROMPT_COPY.submitLabel,
    TOKEN_PROMPT_COPY.cancelLabel,
    TOKEN_PROMPT_COPY.invalidMessage,
  ];
  for (const value of short) {
    assert.ok(value.length > 0);
    assert.doesNotMatch(value, /!/);
    assert.doesNotMatch(value, /\.$/, `${value} must not end with a period`);
    assert.notEqual(value, value.toUpperCase(), `${value} must be sentence case`);
  }
  assert.match(TOKEN_PROMPT_COPY.description, /\.$/);
  assert.doesNotMatch(TOKEN_PROMPT_COPY.description, /!/);
  assert.equal(TOKEN_PROMPT_COPY.title, "Access token required");
  assert.equal(TOKEN_PROMPT_COPY.submitLabel, "Use token");
});
