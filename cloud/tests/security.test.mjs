import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify, money, dateISO, safeCSV, Store } from "../src/core.mjs";
import { scryptSync, pbkdf2Sync } from "node:crypto";

test("signed sessions reject altered payloads, wrong keys and expired tokens", () => {
  const token = sign({ uid: 7, exp: Date.now() / 1000 + 60 }, "test-only-key");
  assert.equal(verify(token, "test-only-key").uid, 7);
  assert.equal(verify(token, "different-key"), null);
  const [body, sig] = token.split(".");
  assert.equal(
    verify(
      Buffer.from(
        JSON.stringify({ uid: 8, exp: Date.now() / 1000 + 60 }),
      ).toString("base64url") +
        "." +
        sig,
      "test-only-key",
    ),
    null,
  );
  assert.equal(
    verify(sign({ uid: 7, exp: 0 }, "test-only-key"), "test-only-key"),
    null,
  );
  assert.equal(verify(token + ".extra", "test-only-key"), null);
});
test("financial input retains cents, leap years and formula protection", () => {
  assert.equal(money("1.234,56 €"), 123456);
  assert.equal(money("1.005"), 100);
  assert.equal(money("1.015"), 102);
  assert.throws(() => money(true));
  assert.throws(() => money("Infinity"));
  assert.equal(dateISO("29/02/2024"), "2024-02-29");
  assert.throws(() => dateISO("29/02/2025"));
  assert.match(safeCSV([['=HYPERLINK("bad")']]), /"'=HYPERLINK/);
});
test("original download refuses corrupted bytes and path traversal", async () => {
  const store = new Store(
    {
      SUPABASE_URL: "https://example.test",
      SUPABASE_STORAGE_KEY: "fictitious",
      SUPABASE_BUCKET: "private",
    },
    async () => new Response("corrupted"),
  );
  assert.throws(() => store.path("../private.pdf"));
  await assert.rejects(
    () =>
      store.get({ storage: "a".repeat(48) + ".pdf", sha256: "b".repeat(64) }),
    /integridade/,
  );
});
test("private password service preserves Werkzeug hashes and refuses anonymous calls", async () => {
  const key = "fictitious-test-key";
  let handler;
  globalThis.Deno = {
    env: { get: () => key },
    serve: (fn) => {
      handler = fn;
    },
  };
  await import("../supabase/password.ts");
  const request = async (data, authorized = true) =>
    handler(
      new Request("https://example.test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorized ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify(data),
      }),
    );
  assert.equal(
    (await request({ operation: "hash", password: "test-password-123" }, false))
      .status,
    403,
  );
  const salt = "existing-salt",
    password = "test-password-123";
  for (const [method, hex] of [
    [
      "scrypt:32768:8:1",
      scryptSync(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      }).toString("hex"),
    ],
    [
      "pbkdf2:sha256:600000",
      pbkdf2Sync(password, salt, 600000, 32, "sha256").toString("hex"),
    ],
  ]) {
    const hash = method + "$" + salt + "$" + hex;
    assert.equal(
      (await (await request({ operation: "verify", password, hash })).json())
        .valid,
      true,
    );
    assert.equal(
      (
        await (
          await request({
            operation: "verify",
            password: "wrong-password",
            hash,
          })
        ).json()
      ).valid,
      false,
    );
  }
  const hash = (await (await request({ operation: "hash", password })).json())
    .hash;
  assert.equal(
    (await (await request({ operation: "verify", password, hash })).json())
      .valid,
    true,
  );
});
