import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - plain browser module without type declarations
import { authHeaders, clearToken, consumeTokenFromLocation, getStoredToken, readTokenFromHash, storeToken } from "../src/ui/auth.js";

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
  clearToken(storage);
  assert.equal(getStoredToken(storage), null);

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

  const noToken = {
    hash: "#/s/ses_1",
    pathname: "/",
    search: "",
  };
  assert.equal(consumeTokenFromLocation(noToken, history, storage), "abc");
  assert.equal(consumeTokenFromLocation(null, history, storage), "abc");
});
