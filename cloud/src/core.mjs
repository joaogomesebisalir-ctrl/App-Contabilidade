import { createHmac, timingSafeEqual } from "node:crypto";
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (status, message) => {
  throw new HttpError(
    status,
    message ||
      {
        401: "Autenticação necessária.",
        403: "Acesso não autorizado.",
        404: "Registo não encontrado.",
      }[status] ||
      "Pedido inválido.",
  );
};
export const now = () =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
export const json = (value, status = 200) => Response.json(value, { status });
export const parse = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
export function required(d, key, max = 1000) {
  if (
    typeof d?.[key] !== "string" ||
    !d[key].trim() ||
    d[key].trim().length > max
  )
    fail(400, `Campo obrigatório ou demasiado longo: ${key}.`);
  return d[key].trim();
}
export function email(value) {
  const s = String(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254)
    fail(400, "Email inválido.");
  return s;
}
export function money(value) {
  if (value == null || String(value).trim() === "") return null;
  if (typeof value === "boolean") fail(400, "Montante inválido.");
  let s = String(value)
    .trim()
    .replace(/€|EUR|\s|\u00a0/g, "");
  if (s.includes(",")) s = s.replaceAll(".", "").replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s))
    fail(400, "Montante inválido.");
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 1e10)
    fail(400, "Montante inválido.");
  // Round decimal currency ties to even, matching the original backend.
  const scaled = Math.abs(n) * 100;
  const lo = Math.floor(scaled);
  const rest = scaled - lo;
  const cents =
    Math.abs(rest - 0.5) < 1e-7 ? (lo % 2 ? lo + 1 : lo) : Math.round(scaled);
  return n < 0 ? -cents : cents;
}
export function dateISO(value) {
  if (!value) return null;
  let s = String(value).trim(),
    y,
    m,
    d;
  let a;
  if ((a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    [, y, m, d] = a;
  } else if ((a = /^(\d{2})[/.\-](\d{2})[/.\-](\d{4})$/.exec(s))) {
    [, d, m, y] = a;
  } else if ((a = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    [, y, m, d] = a;
  } else fail(400, "Data inválida. Use DD/MM/AAAA.");
  const result = `${y}-${m}-${d}`;
  const dt = new Date(result + "T00:00:00Z");
  if (!Number.isFinite(+dt) || dt.toISOString().slice(0, 10) !== result)
    fail(400, "Data inválida. Use DD/MM/AAAA.");
  return result;
}
export const hex = (b) =>
  Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join(
    "",
  );
export const random = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha(value) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ),
  );
}
export function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function verify(token, secret) {
  try {
    const [body, signature, ...extra] = token.split(".");
    if (extra.length || !body || !signature) return null;
    const a = Buffer.from(signature, "base64url"),
      b = createHmac("sha256", secret).update(body).digest();
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}
export function cleanName(value) {
  return (
    String(value || "documento")
      .normalize("NFKD")
      .replace(/[^\w.\- ]/g, "")
      .replace(/\s+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 180) || "documento"
  );
}
export const safeCSV = (rows) =>
  "\ufeff" +
  rows
    .map((row) =>
      row
        .map((value) => {
          let s = String(value ?? "");
          if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(";"),
    )
    .join("\r\n") +
  "\r\n";
export class Database {
  constructor(env, fetcher = fetch.bind(globalThis)) {
    this.env = env;
    this.fetcher = fetcher;
  }
  async rpc(name, data = {}) {
    const response = await this.fetcher(
      `${this.env.SUPABASE_URL}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          apikey: this.env.SUPABASE_STORAGE_KEY,
          Authorization: "Bearer " + this.env.SUPABASE_STORAGE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      },
    );
    if (!response.ok) {
      let error = {};
      try {
        error = await response.json();
      } catch {}
      if (["23505", "23503"].includes(error.code))
        fail(409, "Este registo já existe ou tem uma associação inválida.");
      if (error.code === "P0001") fail(400, error.message);
      throw new HttpError(
        503,
        "A base de dados está temporariamente indisponível. Tente novamente.",
      );
    }
    return response.json();
  }
  async query(q, params = [], audit_info = null) {
    return this.rpc("cc_query", { q, params, audit_info });
  }
  async rows(q, args = []) {
    return (await this.query(q, args)).rows;
  }
  async one(q, args = []) {
    return (await this.rows(q, args))[0] || null;
  }
  async change(q, params, actor, action, resource, id = "$last", detail = {}) {
    return this.query(q, params, {
      user_id: actor?.id ?? null,
      action,
      resource,
      resource_id: id,
      detail: JSON.stringify(detail),
    });
  }
}
export class Store {
  constructor(env, fetcher = fetch.bind(globalThis)) {
    this.env = env;
    this.fetcher = fetcher;
  }
  async request(path, options = {}) {
    const r = await this.fetcher(this.env.SUPABASE_URL + "/storage/v1" + path, {
      ...options,
      headers: {
        apikey: this.env.SUPABASE_STORAGE_KEY,
        Authorization: "Bearer " + this.env.SUPABASE_STORAGE_KEY,
        ...options.headers,
      },
    });
    if (!r.ok)
      fail(
        503,
        "O armazenamento está temporariamente indisponível. O original não foi confirmado.",
      );
    return r;
  }
  path(name) {
    if (!/^[a-f0-9]{48}\.(pdf|jpg|jpeg|png|csv|xlsx|xls)$/.test(name))
      fail(400, "Nome de armazenamento inválido.");
    return "/object/" + this.env.SUPABASE_BUCKET + "/" + name;
  }
  async put(name, bytes, mime) {
    await this.request(this.path(name), {
      method: "POST",
      headers: { "Content-Type": mime },
      body: bytes,
    });
  }
  async remove(name) {
    await this.request("/object/" + this.env.SUPABASE_BUCKET, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [name] }),
    });
  }
  async get(doc) {
    const r = await this.request(this.path(doc.storage));
    const bytes = await r.arrayBuffer();
    if (
      bytes.byteLength > 20 * 1024 * 1024 ||
      (await sha(bytes)) !== doc.sha256
    )
      fail(503, "A integridade do original não pôde ser confirmada.");
    return bytes;
  }
}
export async function password(env, operation, value, hash) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    (operation === "hash" && value.trim().length < 12)
  )
    fail(400, "A palavra-passe deve ter pelo menos 12 caracteres.");
  const r = await fetch(env.SUPABASE_URL + "/functions/v1/conta-password", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.SUPABASE_STORAGE_KEY,
      apikey: env.SUPABASE_STORAGE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation,
      password: operation === "hash" ? value.trim() : value,
      hash,
    }),
  });
  if (!r.ok)
    fail(503, "O serviço de autenticação está temporariamente indisponível.");
  return r.json();
}
