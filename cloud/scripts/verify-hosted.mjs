// Read private Render configuration from stdin; never print credentials or cookies.
// Read-only Worker checks against real Supabase, plus an ephemeral password hash.
import assert from "node:assert/strict";
import { handle } from "../src/worker.mjs";
import { password } from "../src/core.mjs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const env = JSON.parse(Buffer.concat(chunks).toString());
for (const path of ["/health", "/api/session"]) {
  const response = await handle(
    new Request("https://verification.example.test" + path),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  if (path === "/health") assert.equal(body.status, "ok");
  else {
    assert.equal(body.runtime, "cloudflare");
    assert.equal(body.user, null);
    assert.equal(body.browser_extraction, true);
  }
  console.log("Worker + real Supabase verified: " + path);
}
const fake = "fictitious-hosted-check-password-123";
const derived = await password(env, "hash", fake);
assert.equal((await password(env, "verify", fake, derived.hash)).valid, true);
assert.equal(
  (await password(env, "verify", "wrong-password", derived.hash)).valid,
  false,
);
console.log(
  "Worker + real private password function verified. No account created.",
);
const bucket = await fetch(
  env.SUPABASE_URL + "/storage/v1/bucket/" + env.SUPABASE_BUCKET,
  {
    headers: {
      apikey: env.SUPABASE_STORAGE_KEY,
      Authorization: "Bearer " + env.SUPABASE_STORAGE_KEY,
    },
  },
);
assert.equal(bucket.status, 200);
assert.equal((await bucket.json()).public, false);
console.log("Real Storage bucket verified private. No file created.");
