import {
  Database,
  Store,
  HttpError,
  fail,
  json,
  parse,
  required,
  email,
  money,
  dateISO,
  now,
  sha,
  random,
  sign,
  verify,
  cleanName,
  safeCSV,
  password,
} from "./core.mjs";
const DOC_SELECT = `SELECT d.*,coalesce(a.paid_cents,0) AS paid_cents FROM documents d LEFT JOIN (SELECT document_id,sum(amount) AS paid_cents FROM allocations GROUP BY document_id) a ON a.document_id=d.id`;
const DOC_LIST = DOC_SELECT.replace(
  "d.*",
  `d.id,d.entity_id,d.filename,d.storage,d.mime,d.sha256,d.created,d.metadata,d.review,d.accounting,d.visibility,d.work_id,d.deleted,d.ocr_status,d.ocr_error,(d.extraction::jsonb-'text')::text AS extraction`,
);
const KINDS = new Set(["works", "materials", "contacts", "expenses"]);
class App {
  constructor(request, env) {
    this.req = request;
    this.env = env;
    this.url = new URL(request.url);
    this.db = new Database(env);
    this.store = new Store(env);
    this.cookieChanged = false;
    this.user = null;
    this.session = null;
  }
  async init() {
    if (
      !this.env.APP_SECRET_KEY ||
      !this.env.SUPABASE_URL ||
      !this.env.SUPABASE_STORAGE_KEY ||
      !this.env.APP_SETUP_TOKEN
    )
      fail(503, "A instalação ainda precisa de configuração.");
    const token = (this.req.headers.get("cookie") || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("cc_session="))
      ?.slice(11);
    this.session = verify(token || "", this.env.APP_SECRET_KEY);
    if (!this.session || this.session.kind !== "session") {
      this.session = {
        kind: "session",
        csrf: random(32),
        uid: null,
        exp: Date.now() / 1000 + 43200,
      };
      this.cookieChanged = true;
    }
    if (this.session.uid) {
      const u = await this.db.one(
        "SELECT * FROM users WHERE id=? AND active=1",
        [this.session.uid],
      );
      if (u && (await sha(u.password)) === this.session.pv)
        this.user = {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          active: u.active,
        };
      else {
        this.session.uid = null;
        this.cookieChanged = true;
      }
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(this.req.method) &&
      this.req.headers.get("X-CSRF-Token") !== this.session.csrf
    )
      fail(403);
  }
  auth(admin = false) {
    if (!this.user) fail(401);
    if (admin && this.user.role !== "admin") fail(403);
  }
  async body() {
    try {
      const d = await this.req.json();
      if (!d || Array.isArray(d) || typeof d !== "object")
        fail(400, "Pedido JSON inválido.");
      return d;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      fail(400, "Pedido JSON inválido.");
    }
  }
  async entity(id, bank = false) {
    const e = await this.db.one("SELECT * FROM entities WHERE id=?", [id]);
    if (!e) fail(404);
    if (
      this.user.role !== "admin" &&
      !(await this.db.one(
        "SELECT id FROM grants WHERE user_id=? AND entity_id=?" +
          (bank ? " AND bank_access=1" : ""),
        [this.user.id, id],
      ))
    )
      fail(403);
    return e;
  }
  async doc(id, deleted = false) {
    const d = await this.db.one(DOC_SELECT + " WHERE d.id=?", [id]);
    if (!d || (d.deleted && !deleted)) fail(404);
    if (
      this.user.role !== "admin" &&
      (d.visibility !== "financial" ||
        d.deleted ||
        !(await this.db.one(
          "SELECT gr.id FROM grants gr WHERE gr.user_id=? AND gr.entity_id=? AND (gr.all_documents=1 OR EXISTS(SELECT 1 FROM grant_documents gd WHERE gd.grant_id=gr.id AND gd.document_id=?))",
          [this.user.id, d.entity_id, d.id],
        )))
    )
      fail(403);
    return d;
  }
  async docs(deleted = false) {
    if (this.cachedDocs && !deleted) return this.cachedDocs;
    let q = DOC_LIST;
    const args = [];
    if (this.user.role === "admin") {
      if (!deleted) q += " WHERE d.deleted IS NULL";
    } else {
      q += ` WHERE d.visibility='financial' AND d.deleted IS NULL AND EXISTS(SELECT 1 FROM grants gr WHERE gr.user_id=? AND gr.entity_id=d.entity_id AND (gr.all_documents=1 OR EXISTS(SELECT 1 FROM grant_documents gd WHERE gd.grant_id=gr.id AND gd.document_id=d.id)))`;
      args.push(this.user.id);
    }
    q += " ORDER BY d.id DESC";
    const ds = await this.db.rows(q, args);
    if (!deleted) this.cachedDocs = ds;
    return ds;
  }
  out(doc) {
    const d = { ...doc };
    delete d.storage;
    delete d.sha256;
    d.metadata = parse(d.metadata);
    d.extraction = parse(d.extraction);
    d.paid_cents = Number(d.paid_cents || 0);
    const total = money(d.metadata.total);
    d.payment =
      total != null && total > 0 && d.paid_cents >= total
        ? "pago"
        : d.paid_cents > 0
          ? "parcialmente_pago"
          : "por_pagar";
    if (this.user.role !== "admin") delete d.work_id;
    return d;
  }
  async record(kind, id) {
    if (!KINDS.has(kind)) fail(404);
    const r = await this.db.one(
      "SELECT * FROM private_records WHERE kind=? AND id=?",
      [kind, id],
    );
    if (!r) fail(404);
    r.data = parse(r.data);
    return r;
  }
  async login(id) {
    const u = await this.db.one("SELECT * FROM users WHERE id=?", [id]);
    this.session = {
      kind: "session",
      uid: id,
      pv: await sha(u.password),
      csrf: random(32),
      exp: Date.now() / 1000 + 43200,
    };
    this.cookieChanged = true;
    return json({
      user: { id: u.id, email: u.email, name: u.name, role: u.role },
      csrf: this.session.csrf,
    });
  }
  async invitation(token) {
    const i = await this.db.one(
      "SELECT * FROM invitations WHERE token_hash=?",
      [await sha(token)],
    );
    if (!i || i.used || new Date(i.expires) <= new Date())
      fail(400, "Convite inválido, expirado ou já utilizado.");
    return i;
  }
  async scopes(scopes) {
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 100)
      fail(400, "Selecione pelo menos uma entidade.");
    const entities = new Set(
      (await this.db.rows("SELECT id FROM entities")).map((x) => x.id),
    );
    const docs = new Map((await this.docs()).map((x) => [x.id, x]));
    const seen = new Set();
    return scopes.map((s) => {
      const id = Number(s.entity_id);
      if (!entities.has(id) || seen.has(id))
        fail(400, "Entidade inválida ou repetida.");
      seen.add(id);
      if (
        !Array.isArray(s.document_ids || []) ||
        (s.document_ids || []).length > 5000
      )
        fail(400, "Seleção inválida.");
      const ids = [...new Set((s.document_ids || []).map(Number))];
      for (const did of ids) {
        const d = docs.get(did);
        if (!d || d.entity_id !== id || d.visibility !== "financial")
          fail(400, "Documento privado ou de outra entidade.");
      }
      return {
        entity_id: id,
        all_documents: !!s.all_documents,
        bank_access: !!s.bank_access,
        document_ids: ids,
      };
    });
  }
  async uploadBytes(file, statement = false) {
    if (!file || typeof file.arrayBuffer !== "function")
      fail(400, "Escolha um ficheiro.");
    if (!file.size || file.size > 20 * 1024 * 1024)
      fail(400, "Cada ficheiro deve ter entre 1 byte e 20 MB.");
    const raw = await file.arrayBuffer(),
      name = cleanName(file.name);
    const ext = name.split(".").at(-1).toLowerCase();
    const head = new Uint8Array(raw, 0, Math.min(16, raw.byteLength));
    let mime;
    if (ext === "pdf" && new TextDecoder().decode(head).startsWith("%PDF-"))
      mime = "application/pdf";
    else if (
      ext === "png" &&
      head[0] === 137 &&
      head[1] === 80 &&
      head[2] === 78 &&
      head[3] === 71
    )
      mime = "image/png";
    else if (
      ["jpg", "jpeg"].includes(ext) &&
      head[0] === 255 &&
      head[1] === 216 &&
      head[2] === 255
    )
      mime = "image/jpeg";
    else if (statement && ext === "csv") mime = "text/csv";
    else if (statement && ext === "xlsx" && head[0] === 80 && head[1] === 75)
      mime =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    else if (statement && ext === "xls" && head[0] === 208 && head[1] === 207)
      mime = "application/vnd.ms-excel";
    else
      fail(
        400,
        statement
          ? "Aceites CSV, Excel .xlsx/.xls e PDF."
          : "Aceites apenas PDF, JPG e PNG.",
      );
    return { raw, mime, name, ext, hash: await sha(raw) };
  }
  async uploaded(form, statement = false) {
    const eid = Number(form.get("entity_id"));
    await this.entity(eid);
    const file = await this.uploadBytes(form.get("file"), statement);
    const visibility = statement
      ? "financial"
      : form.get("visibility") || "financial";
    if (!["financial", "private"].includes(visibility))
      fail(400, "Visibilidade inválida.");
    const duplicates = await this.db.rows(
      "SELECT id,filename FROM documents WHERE sha256=? AND deleted IS NULL",
      [file.hash],
    );
    if (
      !statement &&
      duplicates.length &&
      form.get("confirm_duplicate") !== "true"
    )
      throw new HttpError(
        409,
        "Possível ficheiro duplicado. Confirme antes de continuar.",
        { duplicates },
      );
    if (statement) {
      const old = await this.db.one(
        "SELECT id FROM documents WHERE entity_id=? AND sha256=? AND deleted IS NULL AND visibility='financial'",
        [eid, file.hash],
      );
      if (old) return { id: old.id, file };
    }
    const name = random(24) + "." + file.ext;
    await this.store.put(name, file.raw, file.mime);
    try {
      const meta = statement
        ? JSON.stringify({ type: "Extrato bancário" })
        : "{}";
      const status = statement && file.ext !== "pdf" ? "completed" : "queued";
      const r = await this.db.change(
        "INSERT INTO documents(entity_id,filename,storage,mime,sha256,created,visibility,metadata,ocr_status) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
        [
          eid,
          file.name,
          name,
          file.mime,
          file.hash,
          now(),
          visibility,
          meta,
          status,
        ],
        this.user,
        statement ? "bank_source_uploaded" : "uploaded",
        "documents",
        "$last",
        { confirm_duplicate: form.get("confirm_duplicate") === "true" },
      );
      return { id: r.id, file };
    } catch (e) {
      await this.store.remove(name);
      throw e;
    }
  }
  downloadToken(d, backup = false) {
    return (
      "/download/" +
      sign(
        {
          kind: "download",
          uid: this.user.id,
          id: d.id,
          backup,
          exp: Date.now() / 1000 + 300,
        },
        this.env.APP_SECRET_KEY,
      )
    );
  }
  async movement(id) {
    const m = await this.db.one("SELECT * FROM movements WHERE id=?", [id]);
    if (!m) fail(404);
    await this.entity(m.entity_id, true);
    return m;
  }
  async moves() {
    return this.db.rows(
      `SELECT m.*,coalesce(a.allocated_cents,0) AS allocated_cents FROM movements m LEFT JOIN (SELECT movement_id,sum(amount) AS allocated_cents FROM allocations GROUP BY movement_id) a ON a.movement_id=m.id` +
        (this.user.role === "admin"
          ? ""
          : ` WHERE EXISTS(SELECT 1 FROM grants gr WHERE gr.user_id=? AND gr.entity_id=m.entity_id AND gr.bank_access=1)`) +
        " ORDER BY m.date DESC,m.id DESC",
      this.user.role === "admin" ? [] : [this.user.id],
    );
  }
  async requests() {
    const allowed = new Set((await this.docs()).map((d) => d.id));
    const grants =
      this.user.role === "admin"
        ? null
        : new Set(
            (
              await this.db.rows(
                "SELECT entity_id FROM grants WHERE user_id=?",
                [this.user.id],
              )
            ).map((g) => g.entity_id),
          );
    const all = await this.db.rows(
      "SELECT r.*,u.name AS author FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC",
    );
    const rs = all.filter(
      (r) =>
        !grants ||
        (grants.has(r.entity_id) &&
          (r.document_id == null || allowed.has(r.document_id))),
    );
    const replies = await this.db.rows(
      "SELECT rr.*,u.name AS author FROM request_replies rr JOIN users u ON u.id=rr.user_id ORDER BY rr.id",
    );
    for (const r of rs)
      r.replies = replies.filter((x) => x.request_id === r.id);
    return rs;
  }
  async validatePrivate(kind, d) {
    required(d, "name", 200);
    if (kind === "works") {
      if ((money(d.budget) || 0) < 0) fail(400, "Orçamento negativo.");
      for (const k of ["start", "end"]) if (d[k]) d[k] = dateISO(d[k]);
      if (d.start && d.end && d.end < d.start)
        fail(400, "A data final deve ser posterior à inicial.");
      if (!Array.isArray(d.categories || []))
        fail(400, "Categorias inválidas.");
    }
    if (kind === "materials") {
      for (const k of ["price", "shipping"])
        if (d[k] != null && d[k] !== "" && money(d[k]) < 0)
          fail(400, "Preço ou portes negativos.");
      for (const k of [
        "quantity",
        "coverage",
        "consumption",
        "thickness",
        "width",
        "length",
        "pack_quantity",
      ])
        if (d[k] != null && d[k] !== "") {
          const v = Number(String(d[k]).replace(",", "."));
          if (!Number.isFinite(v) || v <= 0)
            fail(400, `${k}: indique um número positivo.`);
          d[k] = v;
        }
      for (const k of ["discount", "vat"])
        if (d[k] != null && d[k] !== "") {
          const v = Number(String(d[k]).replace(",", "."));
          if (!Number.isFinite(v) || v < 0 || v > 100)
            fail(400, "IVA/desconto deve estar entre 0 e 100.");
        }
      if (d.date) d.date = dateISO(d.date);
      if (d.document_id) {
        const doc = await this.doc(Number(d.document_id));
        if (
          d.page &&
          !(
            Number(d.page) >= 1 &&
            Number(d.page) <= Number(parse(doc.extraction).pages || 100)
          )
        )
          fail(400, "Página de origem inválida.");
      }
    }
    if (kind === "contacts") {
      if (d.email) d.email = email(d.email);
      if (d.website) {
        let u;
        try {
          u = new URL(d.website);
        } catch {
          fail(400, "Website deve começar por https:// ou http://.");
        }
        if (!["http:", "https:"].includes(u.protocol))
          fail(400, "Website deve começar por https:// ou http://.");
      }
      if (!Array.isArray(d.specialties || []))
        fail(400, "Especialidades inválidas.");
      if (
        d.rating != null &&
        d.rating !== "" &&
        (!Number.isInteger(Number(d.rating)) ||
          Number(d.rating) < 0 ||
          Number(d.rating) > 5)
      )
        fail(400, "Avaliação entre 0 e 5.");
    }
    if (kind === "expenses") {
      if (!["adjudicado", "faturado", "pago"].includes(d.type))
        fail(400, "Tipo de registo inválido.");
      const amount = money(d.amount);
      if (amount == null || amount < 0) fail(400, "Indique um valor positivo.");
      d.date = dateISO(required(d, "date"));
      if (!d.work_id) fail(400, "Selecione uma obra.");
      if (d.document_id) {
        await this.doc(Number(d.document_id));
        fail(
          400,
          "Use este registo apenas para valores manuais sem documento financeiro.",
        );
      }
    }
    if (d.work_id) await this.record("works", Number(d.work_id));
    if (JSON.stringify(d).length > 30000) fail(400, "Registo demasiado longo.");
    return d;
  }
  async workSummary(work) {
    if (!this.workData) {
      this.workData = {
        expenses: await this.db.rows(
          "SELECT data FROM private_records WHERE kind='expenses'",
        ),
        docs: await this.db.rows(
          DOC_LIST + " WHERE d.work_id IS NOT NULL AND d.deleted IS NULL",
        ),
      };
    }
    let budget = money(work.data.budget) || 0,
      awarded = 0,
      invoiced = 0,
      paid = 0,
      unverified = 0;
    for (const r of this.workData.expenses) {
      const d = parse(r.data);
      if (String(d.work_id) !== String(work.id)) continue;
      const amount = money(d.amount) || 0;
      if (d.type === "adjudicado") awarded += amount;
      if (d.type === "faturado") invoiced += amount;
      if (d.type === "pago") paid += amount;
    }
    for (const doc of this.workData.docs) {
      if (Number(doc.work_id) !== work.id) continue;
      const m = parse(doc.metadata);
      if (
        !["Fatura", "Fatura-recibo", "Recibo", "Nota de crédito"].includes(
          m.type,
        ) ||
        m.category === "Comprovativo de pagamento"
      )
        continue;
      const sign = m.type === "Nota de crédito" ? -1 : 1;
      if (doc.review === "validado") invoiced += sign * (money(m.total) || 0);
      else unverified += sign * (money(m.total) || 0);
      paid += sign * Number(doc.paid_cents);
    }
    return {
      budget,
      awarded,
      invoiced,
      paid,
      unpaid: Math.max(0, invoiced - paid),
      deviation: invoiced - budget,
      unverified,
      manual_values_without_receipt: true,
    };
  }
  async privateList(kind) {
    if (!KINDS.has(kind)) fail(404);
    const rs = await this.db.rows(
      "SELECT * FROM private_records WHERE kind=? ORDER BY id DESC",
      [kind],
    );
    for (const r of rs) {
      r.data = parse(r.data);
      if (kind === "works") r.summary = await this.workSummary(r);
      if (kind === "materials") r.price_summary = priceSummary(r.data);
    }
    return rs;
  }
  async route() {
    const p = this.url.pathname,
      m = this.req.method;
    if (p === "/health" && m === "GET") {
      await this.db.one("SELECT 1 AS ok");
      return json({ status: "ok", runtime: "cloudflare" });
    }
    if (p === "/api/session" && m === "GET")
      return json({
        user: this.user,
        csrf: this.session.csrf,
        needs_setup: !(await this.db.one("SELECT id FROM users LIMIT 1")),
        setup_requires_token: true,
        runtime: "cloudflare",
        browser_extraction: true,
        client_archives: true,
      });
    if (
      ["/api/setup", "/api/register-invite", "/api/login"].includes(p) &&
      m === "POST"
    ) {
      const d = await this.body();
      const address = email(required(d, "email"));
      if (p === "/api/login") {
        const key = await sha(
          address + "|" + (this.req.headers.get("CF-Connecting-IP") || "local"),
        );
        const stamp = Date.now() / 1000;
        // Reserve the attempt atomically before invoking password verification.
        const attempt = await this.db.one(
          "INSERT INTO login_attempts(key,count,last) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.last<? THEN 1 ELSE login_attempts.count+1 END,last=excluded.last RETURNING count",
          [key, 1, stamp, stamp - 900],
        );
        if (attempt.count > 8)
          fail(429, "Demasiadas tentativas. Aguarde 15 minutos.");
        const u = await this.db.one(
          "SELECT * FROM users WHERE lower(email)=? AND active=1",
          [address],
        );
        const valid =
          u &&
          (
            await password(
              this.env,
              "verify",
              String(d.password || ""),
              u.password,
            )
          ).valid;
        if (!valid) fail(401);
        await this.db.change(
          "DELETE FROM login_attempts WHERE key=?",
          [key],
          { id: u.id },
          "login",
          "users",
          u.id,
        );
        return this.login(u.id);
      }
      let role = "accountant";
      if (p === "/api/setup") {
        if (
          (await sha(String(d.setup_token || ""))) !==
          (await sha(this.env.APP_SETUP_TOKEN))
        )
          fail(403);
        if (await this.db.one("SELECT id FROM users LIMIT 1"))
          fail(409, "O administrador já foi criado.");
        role = "admin";
      } else {
        const invitation = await this.invitation(required(d, "token"));
        if (address !== invitation.email) fail(403);
      }
      const hash = (
        await password(this.env, "hash", required(d, "password", 256))
      ).hash;
      const r = await this.db.change(
        "INSERT INTO users(email,name,password,role,created) VALUES(?,?,?,?,?) RETURNING id",
        [address, required(d, "name", 120), hash, role, now()],
        null,
        role === "admin" ? "admin_created" : "account_created",
        "users",
      );
      return this.login(r.id);
    }
    this.auth();
    if (p === "/api/logout" && m === "POST") {
      this.session = {
        kind: "session",
        uid: null,
        csrf: random(32),
        exp: Date.now() / 1000 + 43200,
      };
      this.cookieChanged = true;
      return json({ ok: true });
    }
    if (p === "/api/password" && m === "POST") {
      const d = await this.body(),
        u = await this.db.one("SELECT password FROM users WHERE id=?", [
          this.user.id,
        ]);
      if (
        !(
          await password(
            this.env,
            "verify",
            String(d.current_password || ""),
            u.password,
          )
        ).valid
      )
        fail(400, "Palavra-passe atual incorreta.");
      const hash = (
        await password(this.env, "hash", required(d, "password", 256))
      ).hash;
      await this.db.change(
        "UPDATE users SET password=? WHERE id=?",
        [hash, this.user.id],
        this.user,
        "password_changed",
        "users",
        this.user.id,
      );
      this.session.uid = null;
      this.cookieChanged = true;
      return json({ ok: true });
    }
    if (p === "/api/entities") {
      if (m === "GET")
        return json(
          await this.db.rows(
            this.user.role === "admin"
              ? "SELECT * FROM entities ORDER BY name"
              : "SELECT e.* FROM entities e JOIN grants gr ON gr.entity_id=e.id WHERE gr.user_id=? ORDER BY e.name",
            this.user.role === "admin" ? [] : [this.user.id],
          ),
        );
      if (m === "POST") {
        this.auth(true);
        const d = await this.body(),
          nif = required(d, "nif", 9);
        if (!/^\d{9}$/.test(nif)) fail(400, "O NIF deve ter 9 algarismos.");
        if (!["pessoal", "empresa"].includes(d.kind))
          fail(400, "Tipo de entidade inválido.");
        const r = await this.db.change(
          "INSERT INTO entities(name,nif,kind) VALUES(?,?,?) RETURNING id",
          [required(d, "name", 150), nif, d.kind],
          this.user,
          "created",
          "entities",
        );
        return json({ id: r.id }, 201);
      }
    }
    if (p === "/api/invitations" && m === "POST") {
      this.auth(true);
      const d = await this.body(),
        scope = await this.scopes(d.scope),
        token = random(40),
        address = email(required(d, "email"));
      const r = await this.db.change(
        "INSERT INTO invitations(email,token_hash,scope,expires,created) VALUES(?,?,?,?,?) RETURNING id",
        [
          address,
          await sha(token),
          JSON.stringify(scope),
          new Date(Date.now() + 7 * 86400000).toISOString(),
          now(),
        ],
        this.user,
        "invited",
        "invitations",
        "$last",
        { email: address },
      );
      return json(
        { id: r.id, path: "/?invite=" + token, expires_days: 7 },
        201,
      );
    }
    if (p === "/api/invitations/accept" && m === "POST") {
      const d = await this.body();
      await this.db.rpc("cc_scope", {
        actor_id: this.user.id,
        invitation_hash: await sha(required(d, "token")),
      });
      return json({ ok: true });
    }
    if (p === "/api/access" && m === "GET") {
      this.auth(true);
      const accounts = await this.db.rows(
          "SELECT id,email,name,active FROM users WHERE role='accountant'",
        ),
        grants = await this.db.rows("SELECT * FROM grants"),
        ids = await this.db.rows("SELECT * FROM grant_documents");
      for (const a of accounts) {
        a.grants = grants
          .filter((g) => g.user_id === a.id)
          .map((g) => ({
            ...g,
            document_ids: ids
              .filter((x) => x.grant_id === g.id)
              .map((x) => x.document_id),
          }));
      }
      return json({
        accounts,
        invitations: await this.db.rows(
          "SELECT id,email,expires,used FROM invitations ORDER BY id DESC",
        ),
      });
    }
    let match;
    if ((match = /^\/api\/access\/(\d+)$/.exec(p)) && m === "PUT") {
      this.auth(true);
      const d = await this.body();
      await this.db.rpc("cc_scope", {
        actor_id: this.user.id,
        target_id: Number(match[1]),
        scopes: d.scope?.length ? await this.scopes(d.scope) : [],
      });
      return json({ ok: true });
    }
    if ((match = /^\/api\/invitations\/(\d+)$/.exec(p)) && m === "DELETE") {
      this.auth(true);
      await this.db.change(
        "UPDATE invitations SET used=? WHERE id=?",
        [now(), Number(match[1])],
        this.user,
        "revoked",
        "invitations",
        Number(match[1]),
      );
      return json({ ok: true });
    }
    if (p === "/api/documents") {
      if (m === "GET")
        return json(
          (
            await this.docs(
              this.user.role === "admin" &&
                this.url.searchParams.get("deleted") === "1",
            )
          ).map((d) => this.out(d)),
        );
      if (m === "POST") {
        this.auth(true);
        const { id } = await this.uploaded(await this.req.formData());
        return json({ document: this.out(await this.doc(id)) }, 201);
      }
    }
    if (
      (match =
        /^\/api\/documents\/(\d+)(?:\/(restore|retry|accounting|comments|link|extraction))?$/.exec(
          p,
        ))
    ) {
      const id = Number(match[1]),
        action = match[2];
      if (
        ["restore", "retry", "extraction"].includes(action) ||
        ["PUT", "DELETE"].includes(m)
      )
        this.auth(true);
      const doc = await this.doc(id, action === "restore");
      if (!action && m === "GET") {
        const d = this.out(doc);
        d.comments = await this.db.rows(
          "SELECT c.*,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE document_id=? ORDER BY c.id",
          [id],
        );
        return json(d);
      }
      if (!action && m === "PUT") return this.updateDoc(doc, await this.body());
      if (!action && m === "DELETE") {
        await this.db.change(
          "UPDATE documents SET deleted=? WHERE id=?",
          [now(), id],
          this.user,
          "soft_deleted",
          "documents",
          id,
        );
        return json({ ok: true });
      }
      if (action === "restore" && m === "POST") {
        await this.db.change(
          "UPDATE documents SET deleted=NULL WHERE id=?",
          [id],
          this.user,
          "restored",
          "documents",
          id,
        );
        return json({ ok: true });
      }
      if (action === "retry" && m === "POST") {
        await this.db.change(
          "UPDATE documents SET ocr_status='queued',ocr_error=NULL WHERE id=?",
          [id],
          this.user,
          "ocr_retried",
          "documents",
          id,
        );
        return json({ ok: true });
      }
      if (action === "extraction" && m === "POST") {
        const d = await this.body();
        if (d.error) {
          await this.db.change(
            "UPDATE documents SET ocr_status='error',ocr_error=? WHERE id=?",
            [String(d.error).slice(0, 1000), id],
            this.user,
            "ocr_finished",
            "documents",
            id,
          );
          return json({ ok: true });
        }
        const e = d.extraction;
        if (
          !e ||
          typeof e.text !== "string" ||
          e.text.length > 150000 ||
          !Array.isArray(e.lines) ||
          e.lines.length > 5000 ||
          !Array.isArray(e.warnings) ||
          !Number.isInteger(e.pages) ||
          e.pages < 1 ||
          e.pages > 100 ||
          JSON.stringify(e).length > 2e6
        )
          fail(400, "Extração inválida.");
        await this.db.change(
          "UPDATE documents SET extraction=?,ocr_status='completed',ocr_error=NULL WHERE id=?",
          [JSON.stringify(e), id],
          this.user,
          "ocr_finished",
          "documents",
          id,
        );
        return json({ ok: true });
      }
      if (action === "accounting" && m === "POST") {
        const d = await this.body();
        if (!["por_tratar", "em_esclarecimento", "tratado"].includes(d.state))
          fail(400, "Estado inválido.");
        await this.db.change(
          "UPDATE documents SET accounting=? WHERE id=?",
          [d.state, id],
          this.user,
          "accounting_state",
          "documents",
          id,
          { before: doc.accounting, after: d.state },
        );
        return json({ ok: true });
      }
      if (action === "comments" && m === "POST") {
        const d = await this.body();
        await this.db.change(
          "INSERT INTO comments(document_id,user_id,body,created) VALUES(?,?,?,?) RETURNING id",
          [id, this.user.id, required(d, "body", 5000), now()],
          this.user,
          "commented",
          "documents",
          id,
        );
        return json({ ok: true }, 201);
      }
      if (action === "link" && m === "GET")
        return json({ url: this.downloadToken(doc), expires_seconds: 300 });
    }
    if ((match = /^\/download\/(.+)$/.exec(p)) && m === "GET") {
      const token = verify(match[1], this.env.APP_SECRET_KEY);
      if (!token || token.kind !== "download" || token.uid !== this.user.id)
        fail(403);
      const doc = await this.doc(
        token.id,
        token.backup && this.user.role === "admin",
      );
      const bytes = await this.store.get(doc);
      await this.db.change(
        "UPDATE documents SET id=id WHERE id=?",
        [doc.id],
        this.user,
        "downloaded",
        "documents",
        doc.id,
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": doc.mime,
          "Content-Disposition": `${this.url.searchParams.get("inline") === "1" ? "inline" : "attachment"}; filename="${cleanName(doc.filename)}"`,
        },
      });
    }
    if (p === "/api/movements" && m === "GET") {
      const ms = await this.moves();
      if (this.user.role !== "admin") {
        const permitted = new Set((await this.docs()).map((d) => d.id));
        for (const r of ms)
          if (r.source_id && !permitted.has(r.source_id)) r.source_id = null;
      }
      return json(ms);
    }
    if (p === "/api/bank/preview" && m === "POST") {
      this.auth(true);
      const form = await this.req.formData();
      let preview;
      try {
        preview = JSON.parse(form.get("preview") || "null");
      } catch {
        fail(400, "Pré-visualização inválida.");
      }
      if (
        preview &&
        (!Array.isArray(preview.rows) ||
          preview.rows.length > 5000 ||
          !Array.isArray(preview.columns) ||
          preview.columns.length > 100 ||
          new Set(preview.columns).size !== preview.columns.length ||
          JSON.stringify(preview).length > 8e6)
      )
        fail(400, "Limite de 5000 movimentos e 100 colunas.");
      const r = await this.uploaded(form, true);
      if (r.file.ext === "pdf")
        return json({
          rows: [],
          columns: [],
          source_id: r.id,
          pending: true,
          warning:
            "O original foi guardado. A extração decorre neste dispositivo; confirme os movimentos antes de importar.",
        });
      if (!preview)
        fail(400, "Leia o extrato no navegador antes de continuar.");
      return json({
        ...preview,
        source_id: r.id,
        warning:
          "Confirme todas as linhas e o sinal dos montantes antes de importar.",
      });
    }
    if ((match = /^\/api\/bank\/preview\/(\d+)$/.exec(p)) && m === "GET") {
      this.auth(true);
      const doc = await this.doc(Number(match[1]));
      if (doc.mime !== "application/pdf")
        fail(400, "Selecione um extrato PDF.");
      if (["queued", "processing"].includes(doc.ocr_status))
        return json({
          pending: true,
          source_id: doc.id,
          rows: [],
          columns: [],
        });
      const rows = parseBankText(parse(doc.extraction).text || "");
      if (rows.length > 5000)
        fail(400, "Limite de 5000 linhas por importação.");
      return json({
        pending: false,
        rows,
        columns: [...new Set(rows.flatMap(Object.keys))],
        source_id: doc.id,
        warning:
          doc.ocr_error ||
          "Confirme o mapeamento e todas as linhas extraídas do PDF.",
      });
    }
    if (p === "/api/bank/import" && m === "POST") {
      this.auth(true);
      const d = await this.body(),
        eid = Number(d.entity_id);
      await this.entity(eid);
      const bank = required(d, "bank", 150),
        account = required(d, "account", 100),
        source = d.source_id ? Number(d.source_id) : null;
      if (source && (await this.doc(source)).entity_id !== eid)
        fail(400, "O extrato deve pertencer à mesma entidade.");
      if (!Array.isArray(d.rows) || !d.rows.length || d.rows.length > 5000)
        fail(400, "Selecione entre 1 e 5000 movimentos.");
      const values = [];
      for (const r of d.rows) {
        const dt = dateISO(required(r, "date")),
          description = required(r, "description", 2000),
          amount = money(r.amount);
        if (amount == null || amount === 0)
          fail(
            400,
            "Saídas negativas, entradas positivas; montantes diferentes de zero.",
          );
        const fingerprint = await sha(
          "[" +
            [
              eid,
              bank.toLowerCase(),
              account.replaceAll(" ", "").toLowerCase(),
              dt,
              description.toLowerCase(),
              amount,
            ]
              .map((v) => JSON.stringify(v))
              .join(", ") +
            "]",
        );
        values.push({
          entity_id: eid,
          bank,
          account,
          date: dt,
          value_date: dateISO(r.value_date),
          description,
          amount,
          balance: money(r.balance),
          source_id: source,
          fingerprint,
          created: now(),
        });
      }
      const old = new Set(
          (await this.db.rows("SELECT fingerprint FROM movements")).map(
            (x) => x.fingerprint,
          ),
        ),
        seen = new Set(),
        duplicates = [];
      values.forEach((r, i) => {
        if (old.has(r.fingerprint) || seen.has(r.fingerprint))
          duplicates.push(i + 1);
        seen.add(r.fingerprint);
      });
      if (duplicates.length && !d.confirm_duplicates)
        throw new HttpError(
          409,
          "Movimentos possivelmente duplicados. Confirme antes de importar.",
          { duplicate_rows: duplicates },
        );
      await this.db.change(
        "INSERT INTO movements(entity_id,bank,account,date,value_date,description,amount,balance,source_id,fingerprint,created) SELECT entity_id,bank,account,date,value_date,description,amount,balance,source_id,fingerprint,created FROM jsonb_to_recordset(?::jsonb) AS r(entity_id bigint,bank text,account text,date text,value_date text,description text,amount bigint,balance bigint,source_id bigint,fingerprint text,created text) RETURNING id",
        [JSON.stringify(values)],
        this.user,
        "imported",
        "movements",
        "$last",
        { confirm_duplicate: !!d.confirm_duplicates },
      );
      if (source) {
        const doc = await this.doc(source),
          meta = parse(doc.metadata);
        if (!meta.date) {
          meta.date = values.map((x) => x.date).sort()[0];
          await this.db.query("UPDATE documents SET metadata=? WHERE id=?", [
            JSON.stringify(meta),
            source,
          ]);
        }
      }
      return json({ imported: values.length }, 201);
    }
    if ((match = /^\/api\/movements\/(\d+)(?:\/(suggestions))?$/.exec(p))) {
      const id = Number(match[1]),
        movement = await this.movement(id);
      if (m === "PUT" && !match[2]) {
        this.auth(true);
        const d = await this.body();
        if (
          ![
            "por_classificar",
            "comissao",
            "transferencia_interna",
            "sem_fatura",
            "pagamento",
          ].includes(d.classification)
        )
          fail(400, "Classificação inválida.");
        await this.db.change(
          "UPDATE movements SET classification=? WHERE id=?",
          [d.classification, id],
          this.user,
          "classified",
          "movements",
          id,
          { classification: d.classification },
        );
        return json({ ok: true });
      }
      if (m === "GET" && match[2]) {
        const cs = [];
        for (const doc of await this.docs()) {
          const meta = parse(doc.metadata),
            total = money(meta.total);
          if (
            doc.entity_id !== movement.entity_id ||
            total == null ||
            total <= doc.paid_cents ||
            !["Fatura", "Fatura-recibo", "Recibo", "Nota de crédito"].includes(
              meta.type,
            ) ||
            (meta.type === "Nota de crédito") !== movement.amount > 0
          )
            continue;
          let score = 0;
          const reasons = [];
          if (total - doc.paid_cents === Math.abs(movement.amount)) {
            score += 3;
            reasons.push("Montante coincide com o valor em falta");
          }
          if (meta.date) {
            const diff = Math.abs(
              (new Date(meta.date) - new Date(movement.date)) / 86400000,
            );
            if (diff <= 30) {
              score++;
              reasons.push(`Datas próximas (${diff} dias)`);
            }
          }
          for (const k of ["supplier", "number"]) {
            const v = String(meta[k] || "").trim();
            if (
              v.length >= 3 &&
              movement.description.toLowerCase().includes(v.toLowerCase())
            ) {
              score += 2;
              reasons.push("Fornecedor ou referência na descrição");
            }
          }
          if (score >= 3) cs.push({ document: this.out(doc), reasons, score });
        }
        return json(cs.sort((a, b) => b.score - a.score));
      }
    }
    if (p === "/api/allocations") {
      if (m === "GET") {
        const ids = new Set((await this.docs()).map((d) => d.id));
        const entities =
          this.user.role === "admin"
            ? null
            : new Set(
                (
                  await this.db.rows(
                    "SELECT entity_id FROM grants WHERE user_id=? AND bank_access=1",
                    [this.user.id],
                  )
                ).map((g) => g.entity_id),
              );
        return json(
          (
            await this.db.rows(
              "SELECT a.*,m.entity_id FROM allocations a JOIN movements m ON m.id=a.movement_id ORDER BY a.id DESC",
            )
          ).filter(
            (a) =>
              ids.has(a.document_id) &&
              (!entities || entities.has(a.entity_id)),
          ),
        );
      }
      if (m === "POST") {
        this.auth(true);
        const d = await this.body(),
          mid = Number(d.movement_id),
          did = Number(d.document_id);
        await this.movement(mid);
        await this.doc(did);
        const amount = money(d.amount);
        if (amount == null || amount <= 0)
          fail(400, "Indique um valor positivo.");
        const r = await this.db.change(
          "INSERT INTO allocations(movement_id,document_id,amount,created,user_id) VALUES(?,?,?,?,?) RETURNING id",
          [mid, did, amount, now(), this.user.id],
          this.user,
          "payment_linked",
          "allocations",
          "$last",
          { movement_id: mid, document_id: did, amount },
        );
        return json({ id: r.id }, 201);
      }
    }
    if ((match = /^\/api\/allocations\/(\d+)$/.exec(p)) && m === "DELETE") {
      this.auth(true);
      if (
        !(await this.db.one("SELECT id FROM allocations WHERE id=?", [
          Number(match[1]),
        ]))
      )
        fail(404);
      await this.db.change(
        "DELETE FROM allocations WHERE id=?",
        [Number(match[1])],
        this.user,
        "payment_unlinked",
        "allocations",
        Number(match[1]),
      );
      return json({ ok: true });
    }
    if (p === "/api/requests") {
      if (m === "GET") return json(await this.requests());
      if (m === "POST") {
        const d = await this.body(),
          eid = Number(d.entity_id);
        await this.entity(eid);
        const did = d.document_id ? Number(d.document_id) : null;
        if (did && (await this.doc(did)).entity_id !== eid)
          fail(400, "Documento de outra entidade.");
        const r = await this.db.change(
          "INSERT INTO requests(entity_id,document_id,user_id,body,created) VALUES(?,?,?,?,?) RETURNING id",
          [eid, did, this.user.id, required(d, "body", 5000), now()],
          this.user,
          "requested",
          "requests",
        );
        return json({ id: r.id }, 201);
      }
    }
    if ((match = /^\/api\/requests\/(\d+)\/reply$/.exec(p)) && m === "POST") {
      const id = Number(match[1]),
        r = await this.db.one("SELECT * FROM requests WHERE id=?", [id]);
      if (!r) fail(404);
      await this.entity(r.entity_id);
      if (r.document_id) await this.doc(r.document_id);
      const d = await this.body();
      await this.db.change(
        "INSERT INTO request_replies(request_id,user_id,body,created) VALUES(?,?,?,?) RETURNING id",
        [id, this.user.id, required(d, "body", 5000), now()],
        this.user,
        "replied",
        "requests",
        id,
      );
      if (d.resolved)
        await this.db.query(
          "UPDATE requests SET status='resolved' WHERE id=?",
          [id],
        );
      return json({ ok: true });
    }
    if ((match = /^\/api\/private\/([^/]+)(?:\/(\d+))?$/.exec(p))) {
      this.auth(true);
      const kind = match[1],
        id = match[2] ? Number(match[2]) : null;
      if (!KINDS.has(kind)) fail(404);
      if (m === "GET")
        return json(
          id ? await this.record(kind, id) : await this.privateList(kind),
        );
      if (m === "POST" && !id) {
        const d = await this.validatePrivate(kind, await this.body());
        const r = await this.db.change(
          "INSERT INTO private_records(kind,data,created,updated) VALUES(?,?,?,?) RETURNING id",
          [kind, JSON.stringify(d), now(), now()],
          this.user,
          "created",
          kind,
        );
        return json({ id: r.id }, 201);
      }
      if (id) {
        await this.record(kind, id);
        if (m === "PUT") {
          const d = await this.validatePrivate(kind, await this.body());
          await this.db.change(
            "UPDATE private_records SET data=?,updated=? WHERE id=?",
            [JSON.stringify(d), now(), id],
            this.user,
            "updated",
            kind,
            id,
          );
          return json({ ok: true });
        }
        if (m === "DELETE") {
          if (kind === "works") {
            const linked =
              (await this.db.one("SELECT id FROM documents WHERE work_id=?", [
                id,
              ])) ||
              (await this.db.one(
                "SELECT id FROM private_records WHERE kind IN ('materials','expenses') AND data::jsonb->>'work_id'=?",
                [String(id)],
              ));
            if (linked)
              fail(400, "Esta obra tem documentos ou registos associados.");
          }
          await this.db.change(
            "DELETE FROM private_records WHERE id=?",
            [id],
            this.user,
            "deleted",
            kind,
            id,
          );
          return json({ ok: true });
        }
      }
    }
    if (p === "/api/materials/compare" && m === "POST") {
      this.auth(true);
      const d = await this.body();
      if (!Array.isArray(d.ids) || d.ids.length < 2 || d.ids.length > 30)
        fail(400, "Selecione entre 2 e 30 preços.");
      const selected = new Set(d.ids.map(Number)),
        items = (await this.privateList("materials")).filter((r) =>
          selected.has(r.id),
        );
      if (items.length !== selected.size) fail(404);
      items.sort((a, b) => d.ids.indexOf(a.id) - d.ids.indexOf(b.id));
      const area = Number(String(d.area || 0).replace(",", ".")),
        waste = Number(String(d.waste || 0).replace(",", "."));
      if (
        !Number.isFinite(area) ||
        !Number.isFinite(waste) ||
        area < 0 ||
        waste < 0 ||
        waste > 100
      )
        fail(400, "Área/desperdício inválidos.");
      const base = items[0].data,
        basePrice = priceSummary(base),
        result = [];
      for (const item of items) {
        const x = item.data,
          price = item.price_summary;
        const exact = !!(
          base.reference &&
          x.reference &&
          base.brand &&
          x.brand &&
          [
            "reference",
            "brand",
            "width",
            "length",
            "thickness",
            "unit",
            "coverage",
            "pack_quantity",
            "consumption",
          ].every(
            (k) =>
              String(base[k] ?? "").toLowerCase() ===
              String(x[k] ?? "").toLowerCase(),
          )
        );
        const potential = !!(
            base.category &&
            base.category === x.category &&
            price.unit === "m²"
          ),
          estimated =
            price.unit.includes("estimado") ||
            basePrice.unit.includes("estimado");
        const comparable = !!(
          (exact || d.confirmed) &&
          price.unit_net != null &&
          price.unit === basePrice.unit &&
          (!estimated ||
            (x.thickness &&
              base.thickness &&
              String(x.thickness) === String(base.thickness)))
        );
        const r = {
          id: item.id,
          data: x,
          price,
          comparison: exact
            ? "Produto exatamente igual"
            : potential
              ? "Produto potencialmente equivalente"
              : "Produto não diretamente comparável",
          comparable,
          suggestion_method: "Regras locais; IA externa não configurada",
        };
        if (area > 0 && price.coverage && price.unit.startsWith("m²")) {
          const packs = Math.ceil((area * (1 + waste / 100)) / price.coverage);
          r.needs = {
            packs,
            area_with_waste: area * (1 + waste / 100),
            total_net: round(packs * price.pack_net, 2),
            total_gross:
              price.pack_gross != null
                ? round(packs * price.pack_gross, 2)
                : null,
            shipping_known: price.shipping_per_pack != null,
            total_with_shipping:
              price.pack_gross != null && price.shipping_per_pack != null
                ? round(packs * (price.pack_gross + price.shipping_per_pack), 2)
                : null,
          };
        }
        result.push(r);
      }
      const comparable = result.filter(
          (r) =>
            r.comparable && r.price.unit_gross != null && !r.price.vat_assumed,
        ),
        best =
          comparable.length >= 2
            ? comparable.reduce((a, b) =>
                a.price.unit_gross <= b.price.unit_gross ? a : b,
              )
            : null;
      for (const r of result)
        if (best && r.comparable && !r.price.vat_assumed) {
          const delta = r.price.unit_gross - best.price.unit_gross;
          r.difference_eur = round(delta, 4);
          r.difference_percent = best.price.unit_gross
            ? round((delta / best.price.unit_gross) * 100, 2)
            : null;
        }
      if (d.confirmed)
        await this.db.change(
          "UPDATE private_records SET id=id WHERE id=?",
          [items[0].id],
          this.user,
          "comparability_confirmed",
          "materials",
          null,
          { ids: d.ids },
        );
      return json({
        items: result,
        best_id: best?.id ?? null,
        warning:
          "Preços históricos, sem confirmação de preço ou stock atual. Comparação com IVA; portes separados. Confirme equivalências.",
      });
    }
    if (p === "/api/dashboard" && m === "GET") {
      let docs = (await this.docs()).filter(
        (d) => d.visibility === "financial",
      );
      const eid = this.url.searchParams.get("entity_id");
      if (eid) {
        await this.entity(Number(eid));
        docs = docs.filter((d) => d.entity_id === Number(eid));
      }
      const out = {
        review: 0,
        payable: 0,
        months: {},
        net: 0,
        gross: 0,
        unverified: 0,
        documents: docs.length,
      };
      for (const doc of docs) {
        const x = parse(doc.metadata),
          total = money(x.total) || 0;
        if (doc.review === "por_rever") {
          out.review++;
          out.unverified += total;
        }
        if (
          !["Fatura", "Fatura-recibo", "Recibo", "Nota de crédito"].includes(
            x.type,
          ) ||
          x.category === "Comprovativo de pagamento"
        )
          continue;
        const sign = x.type === "Nota de crédito" ? -1 : 1;
        if (sign > 0 && total > doc.paid_cents) out.payable++;
        if (doc.review === "validado") {
          const month = (x.date || "").slice(0, 7);
          if (month)
            out.months[month] = (out.months[month] || 0) + sign * total;
          out.net += sign * (money(x.net) || 0);
          out.gross += sign * total;
        }
      }
      out.unlinked = (await this.moves()).filter(
        (r) => !r.allocated_cents && (!eid || r.entity_id === Number(eid)),
      ).length;
      out.requests = (await this.requests()).filter(
        (r) => r.status === "pending" && (!eid || r.entity_id === Number(eid)),
      ).length;
      if (this.user.role === "admin") {
        out.works = await this.privateList("works");
        out.latest_materials = (await this.privateList("materials")).slice(
          0,
          5,
        );
      }
      return json(out);
    }
    if (p === "/api/audit" && m === "GET") {
      this.auth(true);
      return json(
        await this.db.rows(
          "SELECT a.*,u.name AS author FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300",
        ),
      );
    }
    if (p === "/api/integrations" && m === "GET")
      return json({
        ocr: {
          configured: true,
          service: "OCR gratuito neste dispositivo; motor e idiomas em cache",
        },
        pdf: {
          configured: true,
          service: "Texto PDF e QR fiscal neste dispositivo",
        },
        ai: {
          configured: false,
          service: "Sem IA externa; dados desconhecidos exigem confirmação",
        },
        storage: {
          configured: true,
          service: "Supabase privado + PostgreSQL; confirmar quotas gratuitas",
        },
        email: { configured: false, service: "Convites por link copiado" },
      });
    if (p === "/api/export" && m === "GET") return this.export();
    if (p === "/api/backup/link" && m === "GET") {
      this.auth(true);
      const doc = await this.doc(
        Number(this.url.searchParams.get("document_id")),
        true,
      );
      return json({ url: this.downloadToken(doc, true), expires_seconds: 300 });
    }
    if (p === "/api/backup" && m === "GET") return this.backup();
    fail(404);
  }
  async updateDoc(old, d) {
    const meta = d.metadata || {};
    const allowed = new Set([
      "type",
      "supplier",
      "supplier_nif",
      "recipient",
      "recipient_nif",
      "number",
      "date",
      "due_date",
      "net",
      "vat",
      "vat_rates",
      "total",
      "currency",
      "description",
      "category",
    ]);
    if (
      Array.isArray(meta) ||
      typeof meta !== "object" ||
      Object.keys(meta).some((k) => !allowed.has(k))
    )
      fail(400, "Campos de documento inválidos.");
    for (const k of ["date", "due_date"])
      if (meta[k]) meta[k] = dateISO(meta[k]);
    for (const k of ["net", "vat", "total"])
      if (meta[k] != null && meta[k] !== "") {
        const v = money(meta[k]);
        if (v < 0)
          fail(
            400,
            "Indique valores positivos; use Nota de crédito para créditos.",
          );
        meta[k] = v / 100;
      }
    for (const v of Object.values(meta))
      if (typeof v === "string" && v.length > 3000)
        fail(400, "Campo demasiado longo.");
    if (meta.currency && meta.currency !== "EUR")
      fail(400, "Esta versão suporta apenas EUR.");
    if (JSON.stringify(meta).length > 30000)
      fail(400, "Campos demasiado longos.");
    if (
      old.paid_cents &&
      (money(meta.total) == null ||
        old.paid_cents > money(meta.total) ||
        meta.type !== parse(old.metadata).type)
    )
      fail(400, "Remova as associações antes de alterar o tipo ou total.");
    const eid = Number(d.entity_id ?? old.entity_id);
    await this.entity(eid);
    if (
      eid !== old.entity_id &&
      (await this.db.one("SELECT id FROM allocations WHERE document_id=?", [
        old.id,
      ]))
    )
      fail(400, "Remova as associações antes de mudar a entidade.");
    const review = d.review ?? old.review;
    if (!["por_rever", "validado"].includes(review))
      fail(400, "Estado de revisão inválido.");
    if (
      review === "validado" &&
      (!meta.date || !meta.number || money(meta.total) == null)
    )
      fail(400, "Para validar, confirme a data, o número e o total.");
    const work = d.work_id ? Number(d.work_id) : null;
    if (work) await this.record("works", work);
    const visibility = d.visibility ?? old.visibility;
    if (!["financial", "private"].includes(visibility))
      fail(400, "Visibilidade inválida.");
    const duplicates = [];
    if (
      ["supplier_nif", "number", "date", "total"].every(
        (k) => meta[k] != null && meta[k] !== "",
      )
    ) {
      for (const other of await this.db.rows(
        "SELECT id,filename,metadata FROM documents WHERE id<>? AND entity_id=? AND deleted IS NULL",
        [old.id, eid],
      )) {
        const om = parse(other.metadata);
        if (
          ["supplier_nif", "number", "date"].every(
            (k) => String(om[k]) === String(meta[k]),
          ) &&
          money(om.total) === money(meta.total)
        )
          duplicates.push({ id: other.id, filename: other.filename });
      }
    }
    if (duplicates.length && !d.confirm_duplicate)
      throw new HttpError(
        409,
        "Possível documento duplicado por NIF, número, data e total.",
        { duplicates },
      );
    await this.db.change(
      "UPDATE documents SET metadata=?,review=?,entity_id=?,work_id=?,visibility=? WHERE id=?",
      [JSON.stringify(meta), review, eid, work, visibility, old.id],
      this.user,
      "updated",
      "documents",
      old.id,
      {
        review_before: old.review,
        review_after: review,
        confirm_duplicate: !!d.confirm_duplicate,
      },
    );
    if (eid !== old.entity_id || visibility === "private")
      await this.db.query("DELETE FROM grant_documents WHERE document_id=?", [
        old.id,
      ]);
    return json({ document: this.out(await this.doc(old.id)) });
  }
  async export() {
    const eid = Number(this.url.searchParams.get("entity_id")),
      period = this.url.searchParams.get("period") || "";
    await this.entity(eid);
    if (
      !/^\d{4}-\d{2}$/.test(period) ||
      Number(period.slice(5)) < 1 ||
      Number(period.slice(5)) > 12
    )
      fail(400, "Selecione o ano e mês.");
    const docs = (await this.docs()).filter(
      (d) =>
        d.entity_id === eid &&
        d.visibility === "financial" &&
        String(parse(d.metadata).date || "").slice(0, 7) === period,
    );
    const ids = new Set(docs.map((d) => d.id));
    const files = docs.map((d) => ({
      name: `originais/${d.id}-${cleanName(d.filename)}`,
      url: this.downloadToken(d),
      document_id: d.id,
      sha256: d.sha256,
    }));
    const rows = [
      [
        "ID",
        "Ficheiro",
        "Fornecedor",
        "NIF",
        "Número",
        "Data",
        "Sem IVA EUR",
        "IVA EUR",
        "Total EUR",
        "Pago EUR",
        "Revisão",
        "Contabilidade",
      ],
    ];
    for (const doc of docs) {
      const d = parse(doc.metadata);
      rows.push([
        doc.id,
        doc.filename,
        d.supplier,
        d.supplier_nif,
        d.number,
        d.date,
        d.net,
        d.vat,
        d.total,
        doc.paid_cents / 100,
        doc.review,
        doc.accounting,
      ]);
    }
    files.push({ name: "indice.csv", text: safeCSV(rows) });
    const bank =
      this.user.role === "admin" ||
      !!(await this.db.one(
        "SELECT id FROM grants WHERE user_id=? AND entity_id=? AND bank_access=1",
        [this.user.id, eid],
      ));
    if (bank) {
      const ms = (await this.moves()).filter(
        (r) => r.entity_id === eid && r.date.startsWith(period),
      );
      files.push({
        name: "movimentos.csv",
        text: safeCSV([
          [
            "ID",
            "Banco",
            "Conta",
            "Data",
            "Data valor",
            "Descrição",
            "Montante EUR",
            "Saldo EUR",
            "Classificação",
          ],
          ...ms.map((r) => [
            r.id,
            r.bank,
            r.account,
            r.date,
            r.value_date,
            r.description,
            r.amount / 100,
            r.balance != null ? r.balance / 100 : "",
            r.classification,
          ]),
        ]),
      });
      const allocations = (
        await this.db.rows("SELECT * FROM allocations")
      ).filter((r) => ids.has(r.document_id));
      files.push({
        name: "associacoes.csv",
        text: safeCSV([
          [
            "Movimento ID",
            "Documento ID",
            "Montante EUR",
            "Data de associação",
          ],
          ...allocations.map((r) => [
            r.movement_id,
            r.document_id,
            r.amount / 100,
            r.created,
          ]),
        ]),
      });
    }
    await this.db.change(
      "UPDATE entities SET id=id WHERE id=?",
      [eid],
      this.user,
      "period_exported",
      "entities",
      eid,
      { period, documents: docs.length },
    );
    return json({
      client_archive: true,
      filename: `contabilidade-${eid}-${period}.zip`,
      files,
    });
  }
  async backup() {
    this.auth(true);
    const response = await fetch(
      this.env.SUPABASE_URL + "/rest/v1/rpc/cc_snapshot",
      {
        method: "POST",
        headers: {
          apikey: this.env.SUPABASE_STORAGE_KEY,
          Authorization: "Bearer " + this.env.SUPABASE_STORAGE_KEY,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!response.ok) fail(503, "Não foi possível preparar a cópia.");
    await this.db.query(
      "INSERT INTO audit(user_id,action,resource,created) VALUES(?,?,?,?)",
      [this.user.id, "backup_created", "backup", now()],
    );
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/json",
        "X-Conta-Archive": "snapshot",
      },
    });
  }
}
const round = (v, n) => Math.round((v + Number.EPSILON) * 10 ** n) / 10 ** n;
export function priceSummary(d) {
  const number = (v, def = 0) =>
    v == null || v === "" ? def : Number(String(v).replace(",", "."));
  if (money(d.price) == null) return { missing: ["preço"], unit_net: null };
  const p = number(d.price),
    net = p * (1 - number(d.discount) / 100),
    gross = net * (1 + number(d.vat) / 100);
  let coverage = number(d.coverage, null);
  if (!coverage && d.width && d.length)
    coverage = number(d.width) * number(d.length);
  const unit = d.unit;
  let divisor = null,
    label = unit || "unidade",
    missing = [];
  if (unit === "m²") {
    divisor = 1;
    label = "m²";
  } else if (coverage) {
    divisor = coverage;
    label = "m²";
  } else if (
    ["kg", "saco"].includes(unit) &&
    d.consumption &&
    d.thickness &&
    (unit === "kg" || d.pack_quantity)
  ) {
    divisor =
      (unit === "kg" ? 1 : number(d.pack_quantity)) / number(d.consumption);
    label = "m² (estimado)";
  } else if (["caixa", "saco", "rolo", "placa"].includes(unit))
    missing = [
      "cobertura por embalagem ou medidas; para argamassa: kg/embalagem, consumo kg/m² e espessura",
    ];
  else divisor = number(d.pack_quantity, 1);
  const shipping = money(d.shipping),
    sp = shipping != null ? shipping / 100 / number(d.quantity, 1) : null,
    vatKnown = d.vat != null && d.vat !== "";
  return {
    original: p,
    pack_net: round(net, 4),
    pack_gross: vatKnown ? round(gross, 4) : null,
    unit_net: divisor ? round(net / divisor, 4) : null,
    unit_gross: divisor && vatKnown ? round(gross / divisor, 4) : null,
    unit: label,
    coverage: divisor,
    shipping_per_pack: sp != null ? round(sp, 4) : null,
    unit_with_shipping:
      sp != null && divisor && vatKnown
        ? round((gross + sp) / divisor, 4)
        : null,
    missing,
    consumption: d.consumption,
    application_thickness: d.thickness,
    vat_assumed: !vatKnown,
  };
}
export function parseBankText(text) {
  const rows = [],
    date = "(\\d{2}[/-]\\d{2}[/-]\\d{4}|\\d{4}-\\d{2}-\\d{2})",
    amount = "(-?\\d[\\d.]*[,.]\\d{2})";
  const pattern = new RegExp(
    "^\\s*" +
      date +
      "\\s+(?:" +
      date +
      "\\s+)?(.+?)\\s+" +
      amount +
      "(?:\\s+" +
      amount +
      ")?\\s*$",
  );
  for (const line of text.split("\n")) {
    const cells = line
      .split(/;|\t|\s{2,}/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (cells.length >= 3 && new RegExp("^" + date + "$").test(cells[0])) {
      rows.push(
        Object.fromEntries(cells.map((v, i) => ["Coluna " + (i + 1), v])),
      );
      continue;
    }
    const m = pattern.exec(line);
    if (m)
      rows.push({
        Data: m[1],
        "Data-valor": m[2] || "",
        Descrição: m[3],
        Montante: m[4],
        Saldo: m[5] || "",
      });
  }
  return rows;
}
export async function handle(request, env) {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/download/") &&
    url.pathname !== "/health"
  )
    return env.ASSETS.fetch(request);
  const app = new App(request, env);
  let response;
  try {
    if (Number(request.headers.get("content-length") || 0) > 25 * 1024 * 1024)
      fail(413, "Limite de 25 MB por pedido.");
    await app.init();
    response = await app.route();
  } catch (e) {
    if (e instanceof HttpError)
      response = json({ error: e.message, ...e.extra }, e.status);
    else {
      console.error("Request failed:", e?.name || "Error");
      if (env.DEV_TEST && ["localhost", "127.0.0.1"].includes(url.hostname))
        console.error(e.stack);
      response = json(
        { error: "Não foi possível concluir o pedido. Tente novamente." },
        500,
      );
    }
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  );
  const local =
    env.DEV_TEST && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!local) headers.set("Strict-Transport-Security", "max-age=31536000");
  if (app.cookieChanged && app.session)
    headers.append(
      "Set-Cookie",
      `cc_session=${sign(app.session, env.APP_SECRET_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${local ? "" : "; Secure"}`,
    );
  return new Response(response.body, { status: response.status, headers });
}
export default { fetch: handle };
