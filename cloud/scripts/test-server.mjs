// Local-only integration harness. Real PostgreSQL + private in-memory Storage transport.
// No production token, account or document is read by this script.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { handle } from "../src/worker.mjs";
const repo = resolve(import.meta.dirname, "../.."),
  pub = resolve(repo, "cloud/public");
const pgURL = process.env.PG_TEST_URL;
if (!pgURL || !["127.0.0.1", "localhost"].includes(new URL(pgURL).hostname))
  throw Error("Disposable loopback PostgreSQL required.");
const schema = "cc_edge_" + randomUUID().replaceAll("-", "").slice(0, 12);
const init = spawnSync(
  resolve(repo, ".venv/bin/python"),
  [
    "-c",
    `from app import create_app\ncreate_app({'TESTING':True,'START_WORKER':False,'DATABASE_URL':${JSON.stringify(pgURL)},'DB_SCHEMA':${JSON.stringify(schema)},'DATA_DIR':'/tmp/${schema}'})`,
  ],
  { cwd: repo, encoding: "utf8" },
);
if (init.status !== 0)
  throw Error("Test schema initialization failed: " + init.stderr);
const pg = new Client({ connectionString: pgURL });
await pg.connect();
for (const role of ["anon", "authenticated", "service_role"]) {
  const exists = await pg.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
    role,
  ]);
  if (!exists.rowCount) await pg.query(`CREATE ROLE ${role}`);
}
const sql = (await readFile(resolve(repo, "cloud/supabase/rpc.sql"), "utf8"))
  .replaceAll("{{SCHEMA}}", schema)
  .replaceAll("{{ROLE}}", "postgres");
await pg.query(sql);
const env = {
  APP_SECRET_KEY: "fictional-test-secret-" + randomUUID(),
  APP_SETUP_TOKEN: "fictitious-edge-setup-code",
  SUPABASE_STORAGE_KEY: "fictitious-service-key",
  SUPABASE_BUCKET: "test-bucket",
  DEV_TEST: true,
  ASSETS: {
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname),
        name = path === "/" ? "index.html" : path.slice(1),
        file = resolve(pub, name);
      if (!file.startsWith(pub + "/"))
        return new Response("Not found", { status: 404 });
      try {
        const bytes = await readFile(file);
        const mime =
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".mjs": "application/javascript",
            ".json": "application/json",
            ".css": "text/css",
            ".wasm": "application/wasm",
            ".gz": "application/gzip",
            ".bcmap": "application/octet-stream",
            ".ttf": "font/ttf",
            ".pfb": "application/octet-stream",
          }[extname(file)] || "application/octet-stream";
        return new Response(bytes, {
          headers: {
            "Content-Type": mime,
            "Content-Security-Policy":
              "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
};
globalThis.Deno = {
  env: { get: () => env.SUPABASE_STORAGE_KEY },
  serve(fn) {
    globalThis.testPasswordHandler = fn;
  },
};
await import("../supabase/password.ts");
const objects = new Map();
let externalRequests = 0;
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks),
      url = new URL(incoming.url, env.SUPABASE_URL || "http://127.0.0.1");
    const headers = new Headers();
    for (const [k, v] of Object.entries(incoming.headers))
      if (v != null) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const request = new Request(url, {
      method: incoming.method,
      headers,
      ...(body.length ? { body, duplex: "half" } : {}),
    });
    let response;
    if (
      url.pathname.startsWith("/rest/v1/") ||
      url.pathname.startsWith("/storage/v1/") ||
      url.pathname.startsWith("/functions/v1/")
    ) {
      externalRequests++;
      if (headers.get("Authorization") !== "Bearer " + env.SUPABASE_STORAGE_KEY)
        return outgoing.writeHead(403).end("Forbidden");
      if (url.pathname.startsWith("/rest/v1/")) {
        if (!url.pathname.startsWith("/rest/v1/rpc/"))
          return outgoing.writeHead(404).end("RPC path required");
        const d = body.length ? JSON.parse(body) : {},
          fn = url.pathname.split("/").at(-1);
        try {
          let result;
          if (fn === "cc_query")
            result = await pg.query(
              "SELECT public.cc_query($1,$2,$3) AS value",
              [
                d.q,
                JSON.stringify(d.params || []),
                d.audit_info ? JSON.stringify(d.audit_info) : null,
              ],
            );
          else if (fn === "cc_scope")
            result = await pg.query(
              "SELECT public.cc_scope($1,$2,$3,$4) AS value",
              [
                d.actor_id,
                d.target_id ?? null,
                d.scopes ? JSON.stringify(d.scopes) : null,
                d.invitation_hash ?? null,
              ],
            );
          else if (fn === "cc_snapshot")
            result = await pg.query("SELECT public.cc_snapshot() AS value");
          else throw Error("Unknown function");
          response = Response.json(result.rows[0].value);
        } catch (e) {
          response = Response.json(
            { code: e.code || "TEST", message: e.message },
            { status: 400 },
          );
        }
      } else if (url.pathname === "/functions/v1/conta-password")
        response = await globalThis.testPasswordHandler(request);
      else if (incoming.method === "POST") {
        objects.set(url.pathname, {
          bytes: body,
          mime: headers.get("Content-Type"),
        });
        response = Response.json({ key: url.pathname });
      } else if (incoming.method === "DELETE") {
        for (const name of JSON.parse(body).prefixes)
          objects.delete(
            "/storage/v1/object/" + env.SUPABASE_BUCKET + "/" + name,
          );
        response = Response.json({ ok: true });
      } else {
        const object = objects.get(url.pathname);
        response = object
          ? new Response(object.bytes, {
              headers: { "Content-Type": object.mime },
            })
          : new Response("Not found", { status: 404 });
      }
    } else if (url.pathname === "/_test/stats")
      response = Response.json({
        objects: objects.size,
        externalRequests,
        schema,
      });
    else response = await handle(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("Local test error:", e.message);
    outgoing.writeHead(500).end("Test server failure");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
env.SUPABASE_URL = "http://127.0.0.1:" + server.address().port;
console.log(JSON.stringify({ url: env.SUPABASE_URL, schema }));
async function stop() {
  server.close();
  await pg.query("DROP SCHEMA " + schema + " CASCADE");
  await pg.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
