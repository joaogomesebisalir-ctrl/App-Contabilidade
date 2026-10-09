// Runs the actual Cloudflare local runtime against the disposable integration transport.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const processes = [];
try {
  const transport = spawn(process.execPath, ["scripts/test-server.mjs"], {
    cwd: import.meta.dirname + "/..",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  processes.push(transport);
  const lines = createInterface({ input: transport.stdout });
  const { url } = await new Promise((resolve, reject) => {
    lines.once("line", (line) => resolve(JSON.parse(line)));
    transport.once("exit", (code) => reject(Error("Transport exited " + code)));
  });
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const runtime = spawn(
    import.meta.dirname + "/../node_modules/.bin/wrangler",
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "error",
      "--var",
      "SUPABASE_URL:" + url,
      "--var",
      "SUPABASE_STORAGE_KEY:fictitious-service-key",
      "--var",
      "SUPABASE_BUCKET:test-bucket",
      "--var",
      "APP_SECRET_KEY:fictitious-workerd-only-secret",
      "--var",
      "APP_SETUP_TOKEN:fictitious-edge-setup-code",
      "--var",
      "DEV_TEST:true",
    ],
    {
      cwd: import.meta.dirname + "/..",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: "/tmp/conta-wrangler",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  processes.push(runtime);
  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ready, true, "Actual workerd failed to start");
  let cookie = "",
    csrf = "";
  async function call(path, data) {
    const response = await fetch(base + path, {
      method: data ? "POST" : "GET",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data
          ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
          : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const value = response.headers.get("Set-Cookie");
    if (value) cookie = value.split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  let session = await call("/api/session");
  assert.equal(session.status, 200);
  csrf = session.body.csrf;
  const setup = await call("/api/setup", {
    email: "workerd@example.test",
    name: "Fictitious runtime test",
    password: "fictitious-workerd-password-123",
    setup_token: "fictitious-edge-setup-code",
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.role, "admin");
  csrf = setup.body.csrf;
  assert.equal((await call("/health")).body.status, "ok");
  assert.equal(
    (
      await call("/api/entities", {
        name: "Fictitious runtime entity",
        nif: "123456789",
        kind: "empresa",
      })
    ).status,
    201,
  );
  assert.equal((await call("/api/entities")).body.length, 1);
  assert.equal((await call("/api/logout", {})).status, 200);
  session = await call("/api/session");
  csrf = session.body.csrf;
  const login = await call("/api/login", {
    email: "workerd@example.test",
    password: "fictitious-workerd-password-123",
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");
  console.log(
    "Actual Cloudflare workerd: assets, setup, signed sessions, authentication, private database and entity CRUD passed.",
  );
} finally {
  for (const process of processes.reverse()) {
    process.kill("SIGTERM");
    await new Promise((resolve) => {
      if (process.exitCode !== null) return resolve();
      process.once("exit", resolve);
    });
  }
}
