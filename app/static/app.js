"use strict";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const euro = (v) =>
  v == null
    ? "Por confirmar"
    : new Intl.NumberFormat("pt-PT", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 2,
      }).format(Number(v));
const cents = (v) => euro(Number(v) / 100);
const date = (v) =>
  v ? String(v).slice(0, 10).split("-").reverse().join("/") : "Por confirmar";
const names = {
  por_rever: "Por rever",
  validado: "Validado",
  por_pagar: "Por pagar",
  parcialmente_pago: "Parcialmente pago",
  pago: "Pago",
  por_tratar: "Por tratar",
  em_esclarecimento: "Em esclarecimento",
  tratado: "Tratado",
  queued: "Em fila",
  processing: "A extrair",
  completed: "Extração concluída",
  error: "Erro de extração",
  pending: "Pendente",
  resolved: "Respondido",
  por_classificar: "Por classificar",
  comissao: "Comissão",
  transferencia_interna: "Transferência interna",
  sem_fatura: "Sem fatura",
  pagamento: "Pagamento",
};
const badge = (s) =>
  `<span class="badge ${["validado", "pago", "tratado", "completed", "resolved"].includes(s) ? "green" : ["error"].includes(s) ? "red" : "warn"}">${esc(names[s] || s)}</span>`;
const state = {
  user: null,
  csrf: "",
  entities: [],
  entity: "",
  page: "dashboard",
  docs: [],
  works: [],
  materials: [],
  contacts: [],
  expenses: [],
  movements: [],
  allocations: [],
  requests: [],
  filters: {},
  invite: new URLSearchParams(location.search).get("invite"),
  import: null,
  materialSelection: new Set(),
};
const admin = () => state.user?.role === "admin";
const btn = (text, action, extra = "", cls = "") =>
  `<button type="button" class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const opts = (values, current = "", placeholder = "") =>
  (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
  values
    .map((v) => {
      const [id, label] = Array.isArray(v) ? v : [v, v];
      return `<option value="${esc(id)}" ${String(id) === String(current) ? "selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
const entityOpts = (v = state.entity) =>
  opts(
    state.entities.map((e) => [e.id, `${e.name} · ${e.nif}`]),
    v,
    "Selecionar entidade",
  );
const workOpts = (v) =>
  opts(
    state.works.map((w) => [w.id, w.data.name]),
    v,
    "Sem obra",
  );
const docOpts = (v) =>
  opts(
    state.docs
      .filter((d) => !d.deleted)
      .map((d) => [d.id, `${d.id} · ${d.metadata.number || d.filename}`]),
    v,
    "Sem documento",
  );
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const selectField = (label, name, options, extra = "") =>
  `<label class="field"><span>${esc(label)}</span><select name="${name}" aria-label="${esc(label)}" ${extra}>${options}</select></label>`;
const areaField = (label, name, value = "", extra = "") =>
  `<label class="field ${extra}"><span>${esc(label)}</span><textarea name="${name}">${esc(value)}</textarea></label>`;
function toast(message, error = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = error ? "error-toast" : "";
  t.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = "none"), 6500);
}
async function api(path, options = {}) {
  const headers = { "X-CSRF-Token": state.csrf, ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Resposta inválida do servidor.");
  }
  if (!response.ok) {
    const err = new Error(result.error || "Não foi possível concluir.");
    err.status = response.status;
    err.details = result;
    if (response.status === 401 && state.user) {
      state.user = null;
      await init();
    }
    throw err;
  }
  return result;
}
const post = (p, d) => api(p, { method: "POST", body: d });
function values(form) {
  return Object.fromEntries(new FormData(form));
}
function empty(title, text, action = "") {
  return `<div class="empty"><span class="empty-icon">◇</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}
function modal(title, body) {
  $("#modal-content").innerHTML =
    `<div class="modal-head"><h2>${esc(title)}</h2>${btn("×", "close", "", "small")}</div><div class="modal-body">${body}</div>`;
  if (!$("#modal").open) $("#modal").showModal();
}
function formError(form, err) {
  let el = $(".form-error", form);
  if (!el) {
    el = document.createElement("div");
    el.className = "form-error error";
    form.prepend(el);
  }
  el.textContent = err.message;
  el.scrollIntoView({ block: "nearest" });
}
async function init() {
  try {
    const r = await api("/api/session");
    state.user = r.user;
    state.csrf = r.csrf;
    state.setupRequiresToken = r.setup_requires_token;
    if (!r.user) return authPage(r.needs_setup);
    if (!admin()) {
      state.works = [];
      state.materials = [];
      state.contacts = [];
      state.expenses = [];
      if (["works", "materials", "contacts"].includes(state.page))
        state.page = "dashboard";
    }
    state.entities = await api("/api/entities");
    shell();
    if (state.invite) {
      try {
        await post("/api/invitations/accept", { token: state.invite });
        toast("Convite aceite. Acesso autorizado disponível.");
        state.invite = null;
        history.replaceState({}, "", location.pathname);
        state.entities = await api("/api/entities");
        shell();
      } catch (e) {
        toast(e.message, true);
      }
    }
    await navigate(state.page);
  } catch (e) {
    $("#app").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function authPage(setup = false, register = false) {
  state.needsSetup = setup;
  state.registerInvite = register;
  $("#app").innerHTML =
    `<div class="auth-page"><section class="auth-art"><div class="brand"><span class="brandmark">≋</span> Conta Clara</div><div><div class="eyebrow private-lock">Tudo no seu lugar</div><h1>As suas contas.<br>As suas obras.<br>Mais clareza.</h1><p>Documentos organizados, pagamentos acompanhados e informação partilhada com quem precisa.</p><div class="auth-graphic"><div class="buttons"><span class="fileicon">PDF</span><span>Um espaço para os seus documentos</span></div><div class="lines"><span></span><span></span><span></span></div><div class="privacy private-lock">▣ Obras e contactos sempre privados</div></div></div><div class="auth-footer">Português de Portugal · EUR · Armazenamento privado</div></section><section class="auth-form"><div><div class="eyebrow">O seu espaço financeiro</div><h1>${setup ? "Vamos começar" : register ? "Aceitar convite" : "Bem-vindo de volta"}</h1><p class="muted">${setup ? "Crie a sua conta de administrador. Ainda não existem dados nesta instalação." : register ? "Crie uma conta com o email para o qual recebeu o convite." : "Inicie sessão para aceder aos seus documentos."}</p>${state.invite ? '<div class="banner info">O convite só é aceite depois da autenticação.</div>' : ""}${setup && state.setupRequiresToken ? '<div class="banner info">Introduza o código de instalação disponível nas variáveis privadas do alojamento. Este código protege a criação do primeiro administrador.</div>' : ""}<form id="auth-form">${setup && state.setupRequiresToken ? field("Código de instalação", "setup_token", "", "password", "required autocomplete=off") : ""}${setup || register ? field("Nome", "name", "", "text", 'required autocomplete="name"') : ""}${field("Email", "email", "", "email", 'required autocomplete="username"')}${field("Palavra-passe", "password", "", "password", `required ${setup || register ? 'minlength="12" autocomplete="new-password"' : 'autocomplete="current-password"'}`)}${setup || register ? '<p class="footnote">Use pelo menos 12 caracteres.</p>' : ""}<button class="btn primary" type="submit">${setup ? "Criar o meu espaço" : register ? "Criar conta e aceitar" : "Entrar"}</button></form>${state.invite && !setup ? `<p class="footnote">${register ? "Já tem conta?" : "É a sua primeira visita?"} ${btn(register ? "Iniciar sessão" : "Criar conta com convite", "toggle-register", "", "small")}</p>` : ""}<p class="footnote">${setup ? "Configure o primeiro administrador antes de expor a aplicação à Internet." : "A sua sessão é privada e as permissões são verificadas no servidor."}</p></div></section></div>`;
}
const navs = [
  ["dashboard", "◫", "Painel geral"],
  ["documents", "▤", "Documentos"],
  ["bank", "⇄", "Movimentos bancários"],
  ["accountant", "▦", "Área do contabilista"],
  ["works", "⌂", "Obras", "private"],
  ["materials", "▥", "Materiais", "private"],
  ["contacts", "♧", "Contactos", "private"],
  ["settings", "⚙", "Definições"],
];
function shell() {
  const available = navs.filter((n) => !n[3] || admin());
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark">≋</span> Conta Clara</div><div class="caption">Organização financeira</div><nav>${available.map((n) => `<button class="nav-item ${state.page === n[0] ? "active" : ""}" data-action="nav" data-page="${n[0]}" aria-label="${n[2]}"><span class="nav-icon">${n[1]}</span>${n[2]}${n[3] ? '<span class="private-tag">▣</span>' : ""}</button>`).join("")}</nav><div class="side-footer"><b>${admin() ? "Espaço do administrador" : "Acesso de contabilista"}</b><p>${admin() ? "Partilhe apenas o que escolher." : "Apenas as entidades autorizadas."}</p>${btn("Terminar sessão", "logout", "", "ghost small")}</div></aside><main class="main"><header class="topbar">${btn("☰", "menu", "", "mobile-menu")}<select id="global-entity" aria-label="Filtrar por entidade">${opts(
      state.entities.map((e) => [e.id, e.name]),
      state.entity,
      "Todas as entidades",
    )}</select><div class="identity"><span class="name"><b>${esc(state.user.name)}</b><br><small>${admin() ? "Administrador" : "Contabilista"}</small></span><span class="avatar">${esc(state.user.name.slice(0, 2).toUpperCase())}</span></div></header><div class="content" id="content"></div></main></div>`;
}
const scoped = (items) =>
  state.entity
    ? items.filter((i) => String(i.entity_id) === String(state.entity))
    : items;
function heading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</div>`;
}
async function loadDocuments() {
  state.docs = await api("/api/documents");
}
async function loadPrivate() {
  if (!admin()) return;
  const r = await Promise.all(
    [
      "/api/private/works",
      "/api/private/materials",
      "/api/private/contacts",
      "/api/private/expenses",
    ].map((p) => api(p)),
  );
  [state.works, state.materials, state.contacts, state.expenses] = r;
}
async function navigate(page) {
  state.page = page;
  $$(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.dataset.page === page),
  );
  $(".shell").classList.remove("menu-open");
  $("#content").innerHTML = '<div class="loading">A carregar…</div>';
  try {
    if (
      ["documents", "bank", "accountant", "materials", "works"].includes(page)
    )
      await loadDocuments();
    if (["works", "materials", "contacts", "documents"].includes(page))
      await loadPrivate();
    if (page === "dashboard") await dashboard();
    else if (page === "documents") documentsPage();
    else if (page === "bank") {
      [state.movements, state.allocations] = await Promise.all([
        api("/api/movements"),
        api("/api/allocations"),
      ]);
      bankPage();
    } else if (page === "accountant") {
      state.requests = await api("/api/requests");
      await accountantPage();
    } else if (["works", "materials", "contacts"].includes(page)) {
      if (!admin()) throw new Error("Área privada.");
      privatePage(page);
    } else await settingsPage();
  } catch (e) {
    $("#content").innerHTML = empty("Não foi possível carregar", e.message);
  }
}
async function dashboard() {
  const d = await api(
    "/api/dashboard" + (state.entity ? "?entity_id=" + state.entity : ""),
  );
  const stats = [
    ["Por rever", d.review, "Documentos a confirmar", "▤"],
    ["Por pagar", d.payable, "Faturas com valor em falta", "€"],
    ["Sem comprovativo", d.unlinked, "Movimentos sem associação", "⇄"],
    ["Pedidos pendentes", d.requests, "Esclarecimentos e documentos", "◌"],
  ];
  const months = Object.keys(d.months).sort().slice(-8);
  const max = Math.max(1, ...months.map((m) => Math.abs(d.months[m])));
  $("#content").innerHTML =
    heading(
      "Uma visão de conjunto",
      `Olá, ${state.user.name.split(" ")[0]}`,
      admin()
        ? "Acompanhe as suas contas e mantenha tudo organizado."
        : "Resumo financeiro das entidades partilhadas.",
      admin()
        ? btn("+ Carregar documento", "upload-dialog", "", "primary")
        : "",
    ) +
    (!state.entities.length
      ? `<div class="banner warn">${admin() ? "Comece por criar uma entidade pessoal ou empresa nas Definições." : "Ainda não tem entidades partilhadas. Aguarde um convite do administrador."}</div>`
      : "") +
    `<div class="stats">${stats.map((s) => `<div class="stat"><span class="symbol">${s[3]}</span><div class="label">${s[0]}</div><div class="number">${s[1]}</div><div class="hint">${s[2]}</div></div>`).join("")}</div><div class="grid-two"><section class="card"><div class="card-head"><h2>Despesas por mês</h2><span class="badge">Com IVA · validadas</span></div>${months.length ? `<div class="chart">${months.map((m) => `<div class="chart-column"><small>${cents(d.months[m])}</small><div class="chart-bar" ></div><small>${m.split("-").reverse().join("/")}</small></div>`).join("")}</div>` : empty("Ainda sem despesas validadas", "Os documentos confirmados aparecerão aqui.")}<p class="footnote">Notas de crédito deduzidas. Sem duplicar recibos classificados como comprovativo de pagamento.</p></section><section class="card"><h2>Informação financeira</h2><div class="list-row"><span>Total validado, com IVA</span><b>${cents(d.gross)}</b></div><div class="list-row"><span>Sem IVA confirmado</span><b>${cents(d.net)}</b></div><div class="list-row"><span>Por rever, com IVA</span><b>${cents(d.unverified)}</b></div><div class="banner info"><p>As sugestões de extração precisam da sua confirmação. Não são lançamentos contabilísticos.</p></div></section></div>${admin() ? `<div class="grid-two"><section class="card"><div class="card-head"><h2>As suas obras</h2>${btn("Ver todas", "nav", 'data-page="works"', "small")}</div>${d.works?.length ? d.works.map((w) => `<div class="list-row"><div><b>${esc(w.data.name)}</b><div class="muted">Faturado ${cents(w.summary.invoiced)} · pago ${cents(w.summary.paid)}</div></div><span class="badge">Privado</span></div>`).join("") : empty("Uma casa para os seus projetos", "Crie uma obra para acompanhar orçamento, faturas e pagamentos.")}</section><section class="card"><div class="card-head"><h2>Últimos preços registados</h2>${btn("Comparar", "nav", 'data-page="materials"', "small")}</div>${d.latest_materials?.length ? d.latest_materials.map((m) => `<div class="list-row"><div><b>${esc(m.data.name)}</b><div class="muted">${esc(m.data.supplier || "Fornecedor por confirmar")} · ${date(m.data.date)}</div></div><b>${euro(m.price_summary.unit_gross)}<small> / ${esc(m.price_summary.unit)}</small></b></div>`).join("") : empty("Compare com informação real", "Registe preços a partir dos seus orçamentos.")}</section></div>` : ""}`; // CSP disallows style attributes; apply computed graph heights through CSSOM.
  $$(".chart-bar").forEach((bar, i) => {
    bar.style.height = `${Math.max(3, (Math.abs(d.months[months[i]]) / max) * 125)}px`;
  });
}
function uploadBox(privateMode = false) {
  return `<div class="upload" id="dropzone" data-private="${privateMode}"><b>↑ ${privateMode ? "Guardar orçamentos e faturas de materiais" : "Carregar documentos financeiros"}</b><p>Arraste os ficheiros para aqui ou escolha no dispositivo. PDF, JPG e PNG · até 20 MB por ficheiro.</p><div class="buttons">${btn("Escolher ficheiros", "choose-upload", 'data-input="files"')}${btn("Fotografar documento", "choose-upload", 'data-input="camera"')}</div><input id="files" class="file-input" type="file" accept=".pdf,.jpg,.jpeg,.png" multiple><input id="camera" class="file-input" type="file" accept="image/jpeg,image/png" capture="environment"><div id="upload-status" class="footnote"></div></div>`;
}
function documentsPage() {
  state.filters = {};
  $("#content").innerHTML =
    heading(
      "Arquivo financeiro",
      "Documentos",
      "Os originais são preservados. Reveja os dados antes de validar.",
      admin() ? btn("Recuperar apagados", "trash", "", "small") : "",
    ) +
    (admin() ? uploadBox() : "") +
    `<section class="card"><div class="filters"><input id="doc-search" placeholder="Pesquisar fornecedor, NIF, número ou descrição" aria-label="Pesquisar documentos"><select id="doc-state">${opts(
      Object.entries(names).filter(([k]) =>
        [
          "por_rever",
          "validado",
          "por_pagar",
          "parcialmente_pago",
          "pago",
          "por_tratar",
          "em_esclarecimento",
          "tratado",
        ].includes(k),
      ),
      "",
      "Todos os estados",
    )}</select><input id="doc-period" type="month" aria-label="Período"><input id="doc-category" placeholder="Categoria" aria-label="Categoria"><input id="doc-min" type="number" step="0.01" placeholder="Valor mínimo €" aria-label="Valor mínimo"><input id="doc-max" type="number" step="0.01" placeholder="Valor máximo €" aria-label="Valor máximo"></div><div id="doc-table"></div></section><p class="footnote">Por confirmar significa que ainda não existe informação suficiente. A classificação é uma sugestão para organizar documentos.</p>`;
  renderDocTable();
}
function renderDocTable() {
  let docs = scoped(state.docs).filter(
    (d) => !d.deleted && d.visibility === "financial",
  );
  const q = ($("#doc-search")?.value || "").toLocaleLowerCase("pt-PT");
  const st = $("#doc-state")?.value;
  const period = $("#doc-period")?.value;
  const cat = $("#doc-category")?.value.toLowerCase();
  const min = $("#doc-min")?.value,
    max = $("#doc-max")?.value;
  docs = docs.filter((d) => {
    const m = d.metadata;
    return (
      (!q ||
        [d.filename, ...Object.values(m)]
          .join(" ")
          .toLowerCase()
          .includes(q)) &&
      (!st || [d.review, d.payment, d.accounting].includes(st)) &&
      (!period || m.date?.startsWith(period)) &&
      (!cat || (m.category || "").toLowerCase().includes(cat)) &&
      (min === "" ||
        min == null ||
        (m.total != null && m.total >= Number(min))) &&
      (max === "" || max == null || (m.total != null && m.total <= Number(max)))
    );
  });
  $("#doc-table").innerHTML = docs.length
    ? docTable(docs)
    : empty(
        "O seu arquivo começa aqui",
        "Carregue uma fatura ou ajuste os filtros para encontrar os documentos.",
      );
}
function docTable(docs) {
  return `<div class="table-wrap"><table><thead><tr><th>Documento</th><th>Fornecedor</th><th>Data</th><th>Estados</th><th class="amount">Total com IVA</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr><td><div class="document-title"><span class="fileicon">${esc(d.filename.split(".").pop().toUpperCase().slice(0,4))}</span><div><button class="table-link file-name" data-action="document" data-id="${d.id}">${esc(d.metadata.number || d.filename)}</button><div class="muted">${esc(d.metadata.type || "Tipo por confirmar")} · ${esc(state.entities.find((e) => e.id === d.entity_id)?.name || "")}</div></div></div></td><td>${esc(d.metadata.supplier || "Por confirmar")}<div class="muted">${esc(d.metadata.supplier_nif || "")}</div></td><td>${date(d.metadata.date)}</td><td><div class="badges">${badge(d.review)}${badge(d.payment)}${badge(d.accounting)}</div></td><td class="amount"><b>${euro(d.metadata.total)}</b><div class="muted">${cents(d.paid_cents)} pagos</div></td><td>${btn("Abrir", "document", `data-id="${d.id}"`, "small")}</td></tr>`).join("")}</tbody></table></div>`;
}
async function uploadFiles(files, privateMode = false) {
  if (!admin()) return;
  if (!state.entities.length) {
    toast("Crie primeiro uma entidade nas Definições.", true);
    return;
  }
  let entity = state.entity;
  if (!entity) {
    modal(
      "Escolher entidade",
      `<p>Todos os ficheiros deste carregamento ficam nesta entidade.</p><form id="upload-entity-form">${selectField("Entidade", "entity_id", entityOpts(), "required")}<button class="btn primary">Continuar</button></form>`,
    );
    state.pendingFiles = { files: [...files], privateMode };
    return;
  }
  await performUpload(files, entity, privateMode);
}
async function performUpload(files, entity, privateMode) {
  let count = 0;
  for (const file of files) {
    const form = new FormData();
    form.append("file", file);
    form.append("entity_id", entity);
    form.append("visibility", privateMode ? "private" : "financial");
    const status = $("#upload-status");
    if (status) status.textContent = `A carregar ${file.name}…`;
    try {
      try {
        await api("/api/documents", { method: "POST", body: form });
      } catch (e) {
        if (
          e.status !== 409 ||
          !confirm(`${file.name}: possível duplicado. Guardar mesmo assim?`)
        )
          throw e;
        form.append("confirm_duplicate", "true");
        await api("/api/documents", { method: "POST", body: form });
      }
      count++;
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
  }
  await loadDocuments();
  if (state.page === "documents") renderDocTable();
  else if (state.page === "materials") renderMaterialSources();
  toast(`${count} ficheiro(s) guardado(s). A extração está em fila.`);
  if ($("#upload-status"))
    $("#upload-status").textContent =
      "Originais guardados. Abra o documento para acompanhar a extração.";
}
const metaFields = [
  [
    "Tipo",
    "type",
    "select",
    [
      "Fatura",
      "Fatura-recibo",
      "Recibo",
      "Nota de crédito",
      "Orçamento",
      "Extrato bancário",
      "Outro",
    ],
  ],
  ["Fornecedor", "supplier"],
  ["NIF do fornecedor", "supplier_nif"],
  ["Destinatário", "recipient"],
  ["NIF do destinatário", "recipient_nif"],
  ["Número", "number"],
  ["Data de emissão", "date", "date"],
  ["Vencimento", "due_date", "date"],
  ["Valor sem IVA (€)", "net", "number"],
  ["IVA total (€)", "vat", "number"],
  ["Total com IVA (€)", "total", "number"],
  ["Categoria", "category"],
  ["Descrição resumida", "description"],
];
async function openDocument(ident, suggested = null) {
  const d = await api("/api/documents/" + ident);
  state.currentDoc = d;
  const m = suggested ? { ...d.metadata, ...d.extraction.fields } : d.metadata;
  const link = await api(`/api/documents/${ident}/link`);
  const preview =
    d.mime === "application/pdf"
      ? `<iframe title="Pré-visualização do documento original" src="${esc(link.url)}?inline=1"></iframe>`
      : d.mime.startsWith("image/")
        ? `<img alt="Documento original" src="${esc(link.url)}?inline=1">`
        : '<div class="empty">Extrato guardado no formato original. Descarregue para consultar.</div>';
  const inputs = metaFields
    .map(([label, k, type, options]) => {
      const confidence = d.extraction.confidence?.[k];
      if (type === "select")
        return selectField(label, k, opts(options, m[k], "Por confirmar"));
      return `<label class="field"><span>${esc(label)} ${confidence ? '<span class="badge warn">Confirmar</span>' : ""}</span><input name="${k}" aria-label="${esc(label)}" type="${type || "text"}" value="${esc(m[k])}" placeholder="${type === "date" ? "" : "Por confirmar"}" ${type === "number" ? 'step="0.01" min="0"' : ""} class="${confidence ? "low-confidence" : ""}">${confidence ? `<small>${esc(confidence)}</small>` : ""}</label>`;
    })
    .join("");
  modal(
    d.metadata.number || d.filename,
    `<div class="modal-grid"><div><div class="preview">${preview}</div><div class="toolbar"><a class="btn small" href="${esc(link.url)}" target="_blank" rel="noopener">Descarregar original</a><span class="privacy">Ligação privada · 5 minutos</span></div><div class="banner ${d.ocr_status === "error" ? "warn" : "info"}"><div>${badge(d.ocr_status)}<p class="footnote">${esc(d.ocr_error || "Extração local. Dados desconhecidos ficam por confirmar.")}</p>${admin() ? `<div class="buttons">${btn("Atualizar extração", "document", `data-id="${d.id}"`, "small")}${btn("Repetir", "retry-ocr", `data-id="${d.id}"`, "small")}</div>` : ""}</div></div>${(d.extraction.warnings || []).map((w) => `<div class="banner warn">${esc(w)}</div>`).join("")}${admin() ? `<details class="details"><summary>Texto extraído · ${d.extraction.pages || 0} página(s)</summary><pre>${esc(d.extraction.text || "Ainda sem texto.")}</pre></details>` : ""}${admin() && d.metadata.type === "Extrato bancário" ? btn("Rever movimentos extraídos", "bank-pdf-review", `data-id="${d.id}"`, "small") : ""}<h3>Pagamentos associados</h3><div id="document-payments" class="muted">${cents(d.paid_cents)} · ${names[d.payment]}</div>${admin() && d.work_id ? `<p class="privacy">▣ Obra privada: ${esc(state.works.find((w) => w.id === Number(d.work_id))?.data.name || "Obra associada")}</p>` : ""}</div><div>${
      admin()
        ? `<div class="banner warn"><div>Os campos assinalados precisam de confirmação.${d.extraction.fields && Object.keys(d.extraction.fields).length ? btn("Aplicar sugestões para revisão", "apply-suggestions", `data-id="${d.id}"`, "small") : ""}</div></div><form id="document-form" data-id="${d.id}"><div class="fields">${selectField("Entidade", "entity_id", entityOpts(d.entity_id), "required")}${selectField("Obra (privada)", "work_id", workOpts(d.work_id))}${inputs}${selectField(
            "Revisão",
            "review",
            opts(
              [
                ["por_rever", "Por rever"],
                ["validado", "Validado"],
              ],
              d.review,
            ),
          )}${selectField(
            "Partilha",
            "visibility",
            opts(
              [
                ["financial", "Financeiro — elegível para partilha"],
                ["private", "Privado — nunca partilhado"],
              ],
              d.visibility,
            ),
          )}${areaField("IVA por taxa (JSON; opcional)", "vat_rates", m.vat_rates ? JSON.stringify(m.vat_rates, null, 2) : "", "wide")}</div><p class="footnote">Use a categoria “Comprovativo de pagamento” num recibo que comprova uma fatura já registada, para evitar duplicar custos. Faturas carregadas não ficam automaticamente pagas.</p><button class="btn primary">Guardar revisão</button> ${btn("Apagar", "delete-document", `data-id="${d.id}"`, "danger")}</form>`
        : `<div class="fields">${metaFields.map(([label, k]) => `<div class="field"><span>${label}</span><div>${k === "date" || k === "due_date" ? date(m[k]) : ["total", "net", "vat"].includes(k) ? euro(m[k]) : esc(m[k] || "Por confirmar")}</div></div>`).join("")}</div>`
    }<h3 class="section-title">Contabilidade</h3><form id="accounting-form" data-id="${d.id}"><div class="buttons"><select name="state">${opts(
      [
        ["por_tratar", "Por tratar"],
        ["em_esclarecimento", "Em esclarecimento"],
        ["tratado", "Tratado"],
      ],
      d.accounting,
    )}</select><button class="btn small">Atualizar estado</button></div></form><h3 class="section-title">Comentários e esclarecimentos</h3>${d.comments.length ? d.comments.map((c) => `<div class="comment"><b>${esc(c.author)}</b> <small>${date(c.created)}</small><p>${esc(c.body)}</p></div>`).join("") : '<p class="muted">Ainda sem comentários.</p>'}<form id="comment-form" data-id="${d.id}">${areaField("Comentário", "body")}<button class="btn small">Enviar comentário</button></form></div></div>`,
  );
}
async function trash() {
  const docs = await api("/api/documents?deleted=1");
  const deleted = docs.filter((d) => d.deleted);
  modal(
    "Recuperar documentos apagados",
    deleted.length
      ? `<p class="muted">Os originais continuam guardados e inacessíveis ao contabilista.</p>${deleted.map((d) => `<div class="list-row"><span>${esc(d.filename)}</span>${btn("Recuperar", "restore-document", `data-id="${d.id}"`, "small")}</div>`).join("")}`
      : empty(
          "Sem documentos apagados",
          "Os documentos que apagar podem ser recuperados aqui.",
        ),
  );
}
function bankPage() {
  const movements = scoped(state.movements);
  $("#content").innerHTML =
    heading(
      "Reconciliação",
      "Movimentos bancários",
      "Importe, reveja e associe pagamentos aos documentos.",
      admin() ? btn("+ Importar extrato", "bank-import", "", "primary") : "",
    ) +
    `<div class="banner info"><p>Saídas com montante negativo, entradas com montante positivo. As correspondências são sugestões e exigem confirmação.</p></div><section class="card"><div class="filters"><input id="bank-search" placeholder="Pesquisar descrição, banco ou conta" aria-label="Pesquisar movimentos"><select id="bank-filter">${opts(
      [
        ["unlinked", "Sem comprovativo"],
        ["partial", "Com valor por associar"],
      ],
      "",
      "Todos os movimentos",
    )}</select></div><div id="bank-table"></div></section><section class="card"><h2>Associações confirmadas</h2>${
      state.allocations.filter(
        (a) => !state.entity || String(a.entity_id) === String(state.entity),
      ).length
        ? `<div class="table-wrap"><table><thead><tr><th>Movimento</th><th>Documento</th><th>Montante</th><th></th></tr></thead><tbody>${state.allocations
            .filter(
              (a) =>
                !state.entity || String(a.entity_id) === String(state.entity),
            )
            .map(
              (a) =>
                `<tr><td>#${a.movement_id}</td><td>${btn(esc(state.docs.find((d) => d.id === a.document_id)?.metadata.number || "#" + a.document_id), "document", `data-id="${a.document_id}"`, "small")}</td><td>${cents(a.amount)}</td><td>${admin() ? btn("Remover", "unlink", `data-id="${a.id}"`, "small danger") : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty(
            "Sem associações",
            "Um pagamento pode cobrir várias faturas e uma fatura pode ter vários pagamentos.",
          )
    }</section>`;
  renderBankTable();
}
function renderBankTable() {
  let ms = scoped(state.movements);
  const q = ($("#bank-search")?.value || "").toLowerCase(),
    filter = $("#bank-filter")?.value;
  ms = ms.filter(
    (m) =>
      (!q ||
        `${m.bank} ${m.account} ${m.description}`.toLowerCase().includes(q)) &&
      (!filter ||
        (filter === "unlinked" && !m.allocated_cents) ||
        (filter === "partial" && m.allocated_cents < Math.abs(m.amount))),
  );
  $("#bank-table").innerHTML = ms.length
    ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Descrição</th><th>Conta</th><th class="amount">Montante</th><th class="amount">Associado</th><th></th></tr></thead><tbody>${ms.map((m) => `<tr><td>${date(m.date)}<small class="muted"><br>Valor ${date(m.value_date)}</small></td><td><b>${esc(m.description)}</b><div class="badges">${badge(m.classification)}${!m.allocated_cents ? '<span class="badge warn">Sem comprovativo</span>' : ""}</div></td><td>${esc(m.bank)}<div class="muted">${esc(m.account)}</div></td><td class="amount"><b>${cents(m.amount)}</b></td><td class="amount">${cents(m.allocated_cents)}</td><td>${btn(admin() ? "Associar" : "Consultar", "movement", `data-id="${m.id}"`, "small")}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "Sem movimentos",
        "Importe um extrato CSV, Excel ou PDF, ou ajuste os filtros.",
      );
}
function bankImportDialog() {
  if (!state.entities.length) {
    toast("Crie primeiro uma entidade.", true);
    return;
  }
  state.import = null;
  modal(
    "Importar extrato bancário",
    `<div class="banner info">A importação tem duas etapas: ler o ficheiro e rever os movimentos antes de guardar.</div><form id="bank-preview-form"><div class="fields">${selectField("Entidade", "entity_id", entityOpts(), "required")}${field("Banco", "bank", "", "text", "required")}${field("Conta / IBAN", "account", "", "text", "required")}<label class="field"><span>Extrato (CSV, Excel .xlsx/.xls ou PDF)</span><input type="file" name="file" accept=".csv,.xlsx,.xls,.pdf" required></label></div><button class="btn primary">Ler e mapear colunas</button> ${btn("Introdução manual", "bank-manual", "", "small")}</form>`,
  );
}
const bankColumns = [
  ["date", "Data *"],
  ["value_date", "Data-valor"],
  ["description", "Descrição *"],
  ["amount", "Montante (+ entrada / − saída) *"],
  ["debit", "Débito (alternativa ao montante)"],
  ["credit", "Crédito (alternativa ao montante)"],
  ["balance", "Saldo"],
];
function autoMap(columns) {
  const patterns = {
    date: /^data$|^date$|data movimento/i,
    value_date: /valor.*data|data.?valor|value.?date/i,
    description: /descri|description|descritivo/i,
    amount: /montante|amount|^valor$/i,
    debit: /d[eé]bito|debit|sa[ií]da/i,
    credit: /cr[eé]dito|credit|entrada/i,
    balance: /saldo|balance/i,
  };
  const map = {};
  for (const [k, re] of Object.entries(patterns))
    map[k] = columns.find((c) => re.test(c)) || "";
  return map;
}
const num = (v) => {
  if (v == null || v === "") return "";
  let s = String(v).replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replaceAll(".", "").replace(",", ".");
  return Number(s);
};
function bankReviewDialog() {
  const im = state.import;
  modal(
    "Rever importação",
    `<div class="banner warn">${esc(im.warning || "Confirme o mapeamento, as datas e os montantes. Nenhum movimento foi guardado.")}</div><form id="bank-mapping-form"><div class="fields">${bankColumns.map(([k, label]) => selectField(label, k, opts(im.columns, im.mapping[k], "Não utilizar"))).join("")}</div><button class="btn">Aplicar mapeamento</button></form><h3 class="section-title">Movimentos a guardar</h3><p class="muted">${esc(im.bank)} · ${esc(im.account)} · ${im.rows.length} linha(s). Pode editar os valores e excluir linhas. Saídas negativas.</p><form id="bank-save-form"><div id="bank-review-table"></div><div class="toolbar"><div class="buttons">${btn("‹ Anterior", "bank-prev", "", "small")}<span id="bank-page"></span>${btn("Seguinte ›", "bank-next", "", "small")}</div><button class="btn primary">Confirmar e importar</button></div></form>`,
  );
  mappedBankRows();
  bankReviewTable();
}
function mappedBankRows() {
  const im = state.import;
  im.edited = im.rows.map((r) => {
    const o = { selected: true };
    for (const [k] of bankColumns)
      o[k] = im.mapping[k] ? (r[im.mapping[k]] ?? "") : "";
    if (!im.mapping.amount && (im.mapping.debit || im.mapping.credit))
      o.amount = (num(o.credit) || 0) - Math.abs(num(o.debit) || 0);
    else o.amount = num(o.amount);
    o.balance = num(o.balance);
    for (const k of ["date", "value_date"]) {
      let v = String(o[k] || "").slice(0, 10);
      if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(v))
        v = v.split(/[/-]/).reverse().join("-");
      o[k] = v;
    }
    return o;
  });
  im.page = 0;
}
function bankReviewTable() {
  const im = state.import,
    start = im.page * 50;
  $("#bank-review-table").innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>Incluir</th><th>Data</th><th>Data-valor</th><th>Descrição</th><th>Montante €</th><th>Saldo €</th></tr></thead><tbody>${im.edited
      .slice(start, start + 50)
      .map(
        (r, i) =>
          `<tr class="bank-row-input" data-index="${start + i}"><td><input type="checkbox" data-bank-key="selected" ${r.selected ? "checked" : ""} aria-label="Incluir linha ${start + i + 1}"></td>${["date", "value_date", "description", "amount", "balance"].map((k) => `<td><input data-bank-key="${k}" type="${k.includes("date") ? "date" : k === "description" ? "text" : "number"}" ${["amount", "balance"].includes(k) ? 'step="0.01"' : ""} value="${esc(r[k])}" aria-label="${k} linha ${start + i + 1}"></td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table></div>`;
  $("#bank-page").textContent =
    `${im.page + 1} / ${Math.max(1, Math.ceil(im.edited.length / 50))}`;
}
function bankManualDialog() {
  modal(
    "Registar movimento manual",
    `<form id="bank-manual-form"><div class="fields">${selectField("Entidade", "entity_id", entityOpts(), "required")}${field("Banco", "bank", state.import?.bank || "", "text", "required")}${field("Conta", "account", state.import?.account || "", "text", "required")}${field("Data", "date", "", "date", "required")}${field("Data-valor", "value_date", "", "date")}${field("Descrição", "description", "", "text", "required")}${field("Montante (€; saída negativa)", "amount", "", "number", 'step="0.01" required')}${field("Saldo (€; opcional)", "balance", "", "number", 'step="0.01"')}</div><button class="btn primary">Guardar movimento</button></form>`,
  );
}
async function movementDialog(id) {
  const m = state.movements.find((m) => m.id === Number(id));
  const suggestions = await api(`/api/movements/${id}/suggestions`);
  const candidates = state.docs.filter(
    (d) =>
      d.entity_id === m.entity_id &&
      ["Fatura", "Fatura-recibo", "Recibo", "Nota de crédito"].includes(
        d.metadata.type,
      ) &&
      d.visibility === "financial",
  );
  modal(
    "Movimento · " + date(m.date),
    `<div class="banner info"><div><b>${esc(m.description)}</b><p>${esc(m.bank)} · ${esc(m.account)} · ${cents(m.amount)}</p><p>Disponível para associar: ${cents(Math.abs(m.amount) - m.allocated_cents)}</p></div></div><h3>Sugestões de correspondência</h3>${suggestions.length ? suggestions.map((s) => `<div class="list-row"><div><b>${esc(s.document.metadata.number || s.document.filename)}</b> · ${euro(s.document.metadata.total)}<div class="muted">${esc(s.reasons.join(" · "))}</div></div>${btn("Ver", "document", `data-id="${s.document.id}"`, "small")}</div>`).join("") : empty("Sem correspondência evidente", "Pode associar manualmente, depois de confirmar os dados.")}${
      admin()
        ? `<form id="allocation-form"><input type="hidden" name="movement_id" value="${m.id}"><div class="fields">${selectField(
            "Documento",
            "document_id",
            opts(
              candidates.map((d) => [
                d.id,
                `${d.metadata.number || d.filename} · ${euro(d.metadata.total)} · faltam ${cents(Math.max(0, Math.round((d.metadata.total || 0) * 100) - d.paid_cents))}`,
              ]),
              "",
              "Selecionar",
            ),
            "required",
          )}${field("Montante a associar (€)", "amount", Math.max(0, (Math.abs(m.amount) - m.allocated_cents) / 100), "number", 'step="0.01" min="0.01" required')}</div><button class="btn primary">Confirmar associação</button></form><h3 class="section-title">Classificação do movimento</h3><form id="classify-form" data-id="${m.id}"><div class="buttons"><select name="classification">${opts(
            [
              "por_classificar",
              "comissao",
              "transferencia_interna",
              "sem_fatura",
              "pagamento",
            ].map((k) => [k, names[k]]),
            m.classification,
          )}</select><button class="btn">Guardar classificação</button></div></form>`
        : ""
    }${m.source_id ? `<p>${btn("Ver extrato original", "document", `data-id="${m.source_id}"`, "small")}</p>` : ""}`,
  );
}
async function accountantPage() {
  let access = null;
  if (admin()) access = await api("/api/access");
  const docs = scoped(state.docs).filter(
      (d) => d.visibility === "financial" && !d.deleted,
    ),
    requests = scoped(state.requests);
  const months = [
    ...new Set(docs.map((d) => d.metadata.date?.slice(0, 7)).filter(Boolean)),
  ]
    .sort()
    .reverse();
  $("#content").innerHTML =
    heading(
      "Partilha e colaboração",
      "Área do contabilista",
      "Documentos por período, pedidos e estados de tratamento.",
      admin() ? btn("+ Convidar contabilista", "invite", "", "primary") : "",
    ) +
    `<div class="stats"><div class="stat"><div class="label">Documentos entregues</div><div class="number">${docs.length}</div></div><div class="stat"><div class="label">Por tratar</div><div class="number">${docs.filter((d) => d.accounting === "por_tratar").length}</div></div><div class="stat"><div class="label">Em esclarecimento</div><div class="number">${docs.filter((d) => d.accounting === "em_esclarecimento").length}</div></div><div class="stat"><div class="label">Pedidos pendentes</div><div class="number">${requests.filter((r) => r.status === "pending").length}</div></div></div><section class="card"><h2>Exportar por entidade e mês</h2><form id="export-form"><div class="fields">${selectField("Entidade", "entity_id", entityOpts(), "required")}${field("Ano e mês", "period", months[0] || new Date().toISOString().slice(0, 7), "month", "required")}</div><button class="btn">↓ Descarregar ZIP com originais e índice CSV</button></form><p class="footnote">A exportação inclui apenas documentos autorizados; movimentos e associações exigem permissão bancária. Os dados privados das obras são excluídos.</p></section><section class="card"><h2>Arquivo mensal</h2>${
      months.length
        ? months
            .map((m) => {
              const ds = docs.filter((d) => d.metadata.date?.startsWith(m));
              return `<details><summary class="list-row"><b>${m.split("-").reverse().join("/")} · ${ds.length} documento(s)</b><span>${ds.filter((d) => d.accounting !== "tratado").length} por concluir</span></summary>${docTable(ds)}</details>`;
            })
            .join("")
        : empty(
            "Ainda sem documentos com data",
            "Reveja os documentos para os organizar por mês.",
          )
    }</section><section class="card"><div class="card-head"><h2>Pedidos e esclarecimentos</h2>${btn("+ Novo pedido", "request", "", "small")}</div>${requests.length ? requests.map((r) => `<div class="request"><div class="buttons"><b>${esc(r.author)}</b>${badge(r.status)}<small>${date(r.created)} · ${esc(state.entities.find((e) => e.id === r.entity_id)?.name || "")}</small></div><p>${esc(r.body)}</p>${r.document_id ? btn("Documento associado", "document", `data-id="${r.document_id}"`, "small") : ""}${r.replies.map((reply) => `<div class="details"><b>${esc(reply.author)}</b> <small>${date(reply.created)}</small><p>${esc(reply.body)}</p></div>`).join("")}<form class="reply-form" data-id="${r.id}">${areaField("Resposta", "body")}<label class="checkbox"><input type="checkbox" name="resolved">Marcar pedido como respondido</label><button class="btn small">Enviar resposta</button></form></div>`).join("") : empty("Tudo em dia", "Os pedidos de documentos e esclarecimentos aparecem aqui.")}</section>${admin() ? `<section class="card"><h2>Acessos partilhados</h2>${access.accounts.length ? access.accounts.map((a) => `<div class="list-row"><div><b>${esc(a.name)}</b><div class="muted">${esc(a.email)} · ${a.grants.length} entidade(s)</div></div><div class="buttons">${btn("Editar permissões", "access-edit", `data-id="${a.id}"`, "small")}${btn("Revogar", "revoke-access", `data-id="${a.id}"`, "small danger")}</div></div>`).join("") : '<p class="muted">Ainda sem contabilistas registados.</p>'}<h3 class="section-title">Convites</h3>${access.invitations.map((i) => `<div class="list-row"><div>${esc(i.email)}<div class="muted">Expira ${date(i.expires)} · ${i.used ? "Aceite ou revogado" : "Pendente"}</div></div>${!i.used ? btn("Revogar convite", "revoke-invite", `data-id="${i.id}"`, "small") : ""}</div>`).join("")}</section>` : ""}`;
  state.access = access;
}
function scopeFields(grants = []) {
  return state.entities
    .map((e) => {
      const gr = grants.find((g) => g.entity_id === e.id);
      return `<div class="scope-box" data-entity="${e.id}"><label class="checkbox"><input type="checkbox" name="scope_entity" value="${e.id}" ${gr ? "checked" : ""}><b>${esc(e.name)} · ${esc(e.nif)}</b></label><label class="checkbox"><input type="checkbox" class="scope-all" ${gr?.all_documents ? "checked" : ""}>Todos os documentos financeiros desta entidade, incluindo futuros</label><label class="checkbox"><input type="checkbox" class="scope-bank" ${gr?.bank_access ? "checked" : ""}>Permitir consultar e exportar movimentos bancários</label><details class="scope-docs"><summary>Ou selecionar documentos específicos</summary>${
        state.docs
          .filter((d) => d.entity_id === e.id && d.visibility === "financial")
          .map(
            (d) =>
              `<label class="checkbox"><input type="checkbox" class="scope-document" value="${d.id}" ${gr?.document_ids?.includes(d.id) ? "checked" : ""}>${esc(d.metadata.number || d.filename)}</label>`,
          )
          .join("") || '<p class="muted">Sem documentos financeiros.</p>'
      }</details></div>`;
    })
    .join("");
}
function readScopes(form) {
  return $$(".scope-box", form)
    .filter((box) => $('[name="scope_entity"]', box).checked)
    .map((box) => ({
      entity_id: Number(box.dataset.entity),
      all_documents: $(".scope-all", box).checked,
      bank_access: $(".scope-bank", box).checked,
      document_ids: $$(".scope-document:checked", box).map((el) =>
        Number(el.value),
      ),
    }));
}
function inviteDialog(id = null) {
  const account = id
    ? state.access?.accounts.find((a) => a.id === Number(id))
    : null;
  modal(
    account ? "Permissões de " + account.name : "Convidar contabilista",
    `<div class="banner info">O convite expira em 7 dias e exige uma conta autenticada com o email indicado. Obras, materiais e contactos ficam sempre privados.</div><form id="invite-form" ${id ? `data-id="${id}"` : ""}>${account ? "" : field("Email do contabilista", "email", "", "email", "required")}${scopeFields(account?.grants)}<button class="btn primary">${account ? "Guardar permissões" : "Criar link de convite"}</button></form>`,
  );
}
function requestDialog() {
  modal(
    "Pedir documento ou esclarecimento",
    `<form id="request-form">${selectField("Entidade", "entity_id", entityOpts(), "required")}${selectField("Documento (opcional)", "document_id", docOpts())}${areaField("O que falta ou precisa de esclarecer?", "body")}<button class="btn primary">Enviar pedido</button></form>`,
  );
}
const workCategories = [
  "Estrutura",
  "LSF",
  "Alvenaria",
  "Isolamento",
  "Impermeabilização",
  "Eletricidade",
  "Canalização",
  "Pladur",
  "Pavimentos",
  "Pintura",
  "Equipamentos",
];
const specialties = [
  "Pedreiro",
  "Pladur",
  "Pintor",
  "Eletricista",
  "Canalizador",
  "Serralheiro",
  "Carpinteiro",
  "Caixilharia",
  "LSF",
  "Impermeabilização",
  "Capoto",
  "Pavimentos",
  "Pedras",
  "Climatização",
  "Fornecedor de materiais",
];
const privateTitles = {
  works: [
    "Os seus projetos",
    "Obras",
    "Orçamento, faturação e pagamentos num espaço só seu.",
    "Nova obra",
  ],
  materials: [
    "Compare antes de comprar",
    "Materiais",
    "Preços históricos, unidades normalizadas e origem documentada.",
    "Registar preço",
  ],
  contacts: [
    "A sua rede de confiança",
    "Contactos",
    "Encontre o profissional certo para cada trabalho.",
    "Novo contacto",
  ],
};
function privatePage(kind) {
  const t = privateTitles[kind];
  $("#content").innerHTML =
    heading(
      t[0],
      t[1],
      t[2],
      btn("+ " + t[3], "private-add", `data-kind="${kind}"`, "primary"),
    ) +
    `<div class="privacy private-note">▣ Área exclusivamente privada. O contabilista não tem acesso a estes dados.</div>` +
    (kind === "materials"
      ? `<div class="banner info"><p>A IA externa não está configurada. A extração de linhas e as sugestões de equivalência usam regras locais e precisam de revisão.</p></div>${uploadBox(true)}<section class="card"><h2>Orçamentos e documentos de origem</h2><div id="material-sources"></div></section>`
      : "") +
    `<section class="card"><div class="filters"><input id="private-search" placeholder="${kind === "contacts" ? "Pesquisar nome, empresa ou localidade" : "Pesquisar nome, fornecedor ou categoria"}" aria-label="Pesquisar"><input id="private-category" placeholder="${kind === "contacts" ? "Especialidade" : "Categoria / estado"}" aria-label="Filtrar por categoria ou especialidade">${kind !== "contacts" ? `<select id="private-work">${workOpts("")}</select>` : `<label class="checkbox"><input id="private-favorite" type="checkbox">Favoritos</label>`}</div>${kind === "materials" ? `<div class="toolbar"><span class="muted">Selecione pelo menos dois preços para comparar.</span>${btn("Comparar selecionados", "compare", "", "primary small")}</div>` : ""}<div id="private-list"></div></section>`;
  renderPrivateList(kind);
  if (kind === "materials") renderMaterialSources();
}
function filteredPrivate(kind) {
  let records = state[kind];
  const q = ($("#private-search")?.value || "").toLowerCase(),
    cat = ($("#private-category")?.value || "").toLowerCase(),
    work = $("#private-work")?.value;
  return records.filter(
    (r) =>
      (!q || JSON.stringify(r.data).toLowerCase().includes(q)) &&
      (!cat ||
        String(
          r.data.category ||
            r.data.state ||
            r.data.specialties?.join(" ") ||
            "",
        )
          .toLowerCase()
          .includes(cat)) &&
      (!work ||
        String(kind === "works" ? r.id : r.data.work_id) === String(work)) &&
      (!$("#private-favorite")?.checked || r.data.favorite),
  );
}
function renderPrivateList(kind) {
  const records = filteredPrivate(kind);
  const el = $("#private-list");
  if (!records.length) {
    el.innerHTML = empty(
      kind === "works"
        ? "Comece a sua próxima obra"
        : kind === "materials"
          ? "Compare a partir dos seus preços"
          : "A sua agenda de profissionais",
      "Adicione um registo ou ajuste os filtros.",
    );
    return;
  }
  if (kind === "works") {
    el.innerHTML = `<div class="grid-three">${records.map((w) => `<article class="card work-card"><div class="card-head"><span class="badge">${esc(w.data.state || "Planeada")}</span><span class="privacy">▣ Privado</span></div><h2>${esc(w.data.name)}</h2><div class="location">${esc(w.data.location || "Localização por indicar")}</div><div class="work-numbers"><div><small>Orçamento com IVA</small><b>${cents(w.summary.budget)}</b></div><div><small>Faturado validado</small><b>${cents(w.summary.invoiced)}</b></div><div><small>Pago</small><b>${cents(w.summary.paid)}</b></div><div><small>Por pagar</small><b>${cents(w.summary.unpaid)}</b></div></div><p class="footnote">Por rever: ${cents(w.summary.unverified)}</p><div class="buttons">${btn("Abrir obra", "work-detail", `data-id="${w.id}"`, "small")}${btn("Editar", "private-edit", `data-kind="works" data-id="${w.id}"`, "small")}</div></article>`).join("")}</div>`;
  } else if (kind === "contacts") {
    el.innerHTML = `<div class="grid-three">${records
      .map((r) => {
        const c = r.data,
          phone = (c.phone || "").replace(/[^\d+]/g, ""),
          wa = phone.replace("+", "");
        return `<article class="card contact"><div class="card-head"><span class="badge">${esc(c.specialties?.slice(0, 2).join(" · ") || "Especialidade por indicar")}</span><span>${c.favorite ? "★" : "☆"}</span></div><div class="person"><span class="avatar">${esc(c.name.slice(0, 2).toUpperCase())}</span><div><h2>${esc(c.name)}</h2><small>${esc(c.company || "Profissional independente")}</small></div></div><p>${esc(c.location || "Localidade por indicar")} · ${esc(c.zone || "Zona por indicar")}</p><p>${"★".repeat(Math.max(0, Math.min(5, Number(c.rating) || 0)))}${"☆".repeat(5 - Math.max(0, Math.min(5, Number(c.rating) || 0)))}</p><div class="buttons">${phone ? `<a class="btn small" href="tel:${esc(phone)}">Telefonar</a><a class="btn small" href="https://wa.me/${esc(wa.length === 9 ? "351" + wa : wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}${c.email ? `<a class="btn small" href="mailto:${esc(c.email)}">Email</a>` : ""}${btn("Abrir / editar", "private-edit", `data-kind="contacts" data-id="${r.id}"`, "small")}</div></article>`;
      })
      .join("")}</div>`;
  } else {
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th></th><th>Material / origem</th><th>Fornecedor</th><th>Preço original s/ IVA</th><th>Normalizado</th><th>Data</th><th></th></tr></thead><tbody>${records
      .map((r) => {
        const m = r.data,
          p = r.price_summary;
        return `<tr><td><input type="checkbox" data-material-id="${r.id}" ${state.materialSelection.has(r.id) ? "checked" : ""} aria-label="Comparar ${esc(m.name)}"></td><td><b>${esc(m.name)}</b><div class="muted">${esc(m.brand || "")} ${esc(m.reference || "")}</div>${m.document_id ? btn("Documento · p. " + (m.page || "?"), "document", `data-id="${Number(m.document_id)}"`, "small") : ""}</td><td>${esc(m.supplier || "Por confirmar")}</td><td>${euro(m.price)} / ${esc(m.unit || "?")}</td><td><b>${euro(p.unit_net)} s/ IVA</b><div class="muted">${p.vat_assumed ? "IVA por confirmar" : euro(p.unit_gross) + " c/ IVA"} / ${esc(p.unit)}</div>${p.missing?.length ? '<span class="badge warn">Falta cobertura / consumo</span>' : ""}</td><td>${date(m.date)}</td><td>${btn("Editar", "private-edit", `data-kind="materials" data-id="${r.id}"`, "small")}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  }
}
function renderMaterialSources() {
  const docs = scoped(state.docs).filter(
    (d) => d.visibility === "private" || d.metadata.type === "Orçamento",
  );
  const el = $("#material-sources");
  if (!el) return;
  el.innerHTML = docs.length
    ? docs
        .map(
          (d) =>
            `<div class="list-row"><div><b>${esc(d.filename)}</b><div class="badges">${badge(d.ocr_status)}<span class="badge">${d.extraction.lines?.length || 0} linha(s) sugerida(s)</span></div></div><div class="buttons">${btn("Ver original", "document", `data-id="${d.id}"`, "small")}${btn("Extrair / registar materiais", "source-lines", `data-id="${d.id}"`, "small")}</div></div>`,
        )
        .join("")
    : empty(
        "Guarde os seus orçamentos",
        "Carregue os documentos e reveja as linhas sugeridas. Pode introduzir todos os preços manualmente.",
      );
}
function contactLinked(label, key, items, current = []) {
  return `<div class="field wide"><span>${esc(label)}</span><div class="checkbox-grid">${items.map(([id, name]) => `<label class="checkbox"><input type="checkbox" name="${key}" value="${id}" ${current.map(String).includes(String(id)) ? "checked" : ""}>${esc(name)}</label>`).join("") || "<small>Sem registos.</small>"}</div></div>`;
}
function privateDialog(kind, id = null, prefill = {}) {
  const record = id ? state[kind]?.find((r) => r.id === Number(id)) : null;
  const d = record?.data || prefill;
  let body = "";
  if (kind === "works")
    body = `${field("Nome da obra", "name", d.name, "text", "required")}${field("Localização", "location", d.location)}${field("Data prevista inicial", "start", d.start, "date")}${field("Data prevista final", "end", d.end, "date")}${selectField("Estado", "state", opts(["Planeada", "Em curso", "Suspensa", "Concluída"], d.state || "Planeada"))}${field("Orçamento previsto com IVA (€)", "budget", d.budget, "number", 'step="0.01" min="0"')}${areaField("Descrição", "description", d.description, "wide")}${areaField("Categorias editáveis (uma por linha)", "categories", (d.categories || workCategories).join("\n"), "wide")}${areaField("Notas privadas", "notes", d.notes, "wide")}`;
  else if (kind === "materials")
    body = `${field("Nome do material", "name", d.name, "text", "required")}${field("Fornecedor", "supplier", d.supplier)}${field("Marca", "brand", d.brand)}${field("Referência", "reference", d.reference)}${field("Categoria", "category", d.category)}${selectField("Obra privada", "work_id", workOpts(d.work_id))}${field("Quantidade de embalagens / unidades", "quantity", d.quantity ?? 1, "number", 'step="0.001" min="0.001"')}${selectField("Unidade de venda", "unit", opts(["m²", "metro linear", "m³", "unidade", "saco", "caixa", "kg", "litro", "rolo", "placa"], d.unit || "caixa"))}${field("Preço por embalagem / unidade sem IVA (€)", "price", d.price, "number", 'step="0.0001" min="0" required')}${field("Desconto (%)", "discount", d.discount ?? 0, "number", 'step="0.01" min="0" max="100"')}${field("IVA (%) — vazio se desconhecido", "vat", d.vat, "number", 'step="0.01" min="0" max="100"')}${field("Portes totais destas unidades (€)", "shipping", d.shipping, "number", 'step="0.01" min="0"')}${field("Cobertura por embalagem (m²)", "coverage", d.coverage, "number", 'step="0.0001" min="0.0001"')}${field("Quantidade por embalagem (kg, unidades, etc.)", "pack_quantity", d.pack_quantity, "number", 'step="0.001" min="0.001"')}${field("Largura (metros)", "width", d.width, "number", 'step="0.0001" min="0.0001"')}${field("Comprimento (metros)", "length", d.length, "number", 'step="0.0001" min="0.0001"')}${field("Espessura de aplicação / produto (mm)", "thickness", d.thickness, "number", 'step="0.01" min="0.01"')}${field("Consumo documentado (kg/m²)", "consumption", d.consumption, "number", 'step="0.001" min="0.001"')}${field("Data do preço", "date", d.date, "date")}${selectField("Documento de origem", "document_id", docOpts(d.document_id))}${field("Página de origem", "page", d.page, "number", 'step="1" min="1"')}${areaField("Descrição original / características", "description", d.description, "wide")}<div class="wide banner info">Não preencha medidas ou consumo por estimativa. Para comparar argamassas, confirme também a espessura de aplicação. Os portes são repartidos pela quantidade registada.</div>`;
  else if (kind === "contacts")
    body = `${field("Nome", "name", d.name, "text", "required")}${field("Empresa", "company", d.company)}${field("Telemóvel", "phone", d.phone, "tel")}${field("Email", "email", d.email, "email")}${field("Localidade", "location", d.location)}${field("Zona de trabalho", "zone", d.zone)}${field("NIF (opcional)", "nif", d.nif)}${field("Website", "website", d.website, "url")}${field("Avaliação pessoal (0–5)", "rating", d.rating ?? 0, "number", 'min="0" max="5" step="1"')}<label class="checkbox"><input type="checkbox" name="favorite" ${d.favorite ? "checked" : ""}>Favorito</label>${areaField("Especialidades editáveis (uma por linha)", "specialties", (d.specialties || []).join("\n"), "wide")}<p class="wide footnote">Sugestões: ${specialties.join(", ")}.</p>${contactLinked(
      "Obras associadas",
      "work_ids",
      state.works.map((w) => [w.id, w.data.name]),
      d.work_ids || [],
    )}${contactLinked(
      "Orçamentos e faturas associados",
      "document_ids",
      state.docs.map((doc) => [doc.id, doc.metadata.number || doc.filename]),
      d.document_ids || [],
    )}${areaField("Notas privadas", "notes", d.notes, "wide")}`;
  else if (kind === "expenses")
    body = `${field("Descrição", "name", d.name, "text", "required")}${selectField("Obra", "work_id", workOpts(d.work_id), "required")}${selectField(
      "Tipo de valor",
      "type",
      opts(
        [
          ["adjudicado", "Valor adjudicado"],
          ["faturado", "Despesa faturada manual"],
          ["pago", "Pagamento / adiantamento manual"],
        ],
        d.type || "faturado",
      ),
    )}${field("Categoria", "category", d.category)}${field("Data", "date", d.date || new Date().toISOString().slice(0, 10), "date", "required")}${field("Montante com IVA (€)", "amount", d.amount, "number", 'step="0.01" min="0" required')}${field("Referência comum da despesa / pagamento", "reference", d.reference)}${areaField("Notas privadas", "notes", d.notes, "wide")}<div class="wide banner warn">Registo manual sem comprovativo financeiro. Os documentos associados à obra e os seus pagamentos já entram no resumo. Registe aqui apenas valores adicionais para evitar duplicar custos.</div>`;
  modal(
    `${id ? "Editar" : "Criar"} ${kind === "works" ? "obra" : kind === "materials" ? "preço de material" : kind === "contacts" ? "contacto" : "registo manual"}`,
    `<form id="private-form" data-kind="${kind}" ${id ? `data-id="${id}"` : ""}><div class="fields">${body}</div><div class="buttons"><button class="btn primary">Guardar</button>${id ? btn("Apagar registo", "private-delete", `data-kind="${kind}" data-id="${id}"`, "danger") : ""}</div></form>`,
  );
}
function workDetail(id) {
  const w = state.works.find((w) => w.id === Number(id));
  const s = w.summary,
    expenses = state.expenses.filter(
      (e) => String(e.data.work_id) === String(id),
    ),
    docs = state.docs.filter((d) => String(d.work_id) === String(id));
  modal(
    w.data.name,
    `<span class="privacy">▣ Esta informação nunca é partilhada com o contabilista.</span><p class="muted">${esc(w.data.location || "")} · ${date(w.data.start)} — ${date(w.data.end)}</p><div class="grid-three">${[
      ["Orçamento previsto", s.budget],
      ["Valor adjudicado", s.awarded],
      ["Faturado validado", s.invoiced],
      ["Valor pago", s.paid],
      ["Valor por pagar", s.unpaid],
      ["Desvio face ao orçamento", s.deviation],
    ]
      .map(
        ([label, v]) =>
          `<div class="stat-mini"><small>${label}</small><b>${cents(v)}</b></div>`,
      )
      .join(
        "",
      )}</div><p class="footnote">Todos os valores com IVA. Por rever, fora do faturado validado: ${cents(s.unverified)}. Adjudicação e faturação são medidas distintas e não são somadas.</p><h3 class="section-title">Categorias da obra</h3><div class="badges">${(w.data.categories || []).map((c) => `<span class="badge">${esc(c)}</span>`).join("")}</div><h3 class="section-title">Registos manuais e adiantamentos</h3>${btn("+ Registar valor manual", "work-expense", `data-id="${id}"`, "small")}${expenses.map((e) => `<div class="list-row"><div><b>${esc(e.data.name)}</b><div class="muted">${date(e.data.date)} · ${esc(e.data.type)} · ${esc(e.data.reference || "Sem referência")}</div><span class="badge warn">Sem comprovativo</span></div><div>${euro(e.data.amount)} ${btn("Editar", "private-edit", `data-kind="expenses" data-id="${e.id}"`, "small")}</div></div>`).join("")}<h3 class="section-title">Documentos associados</h3>${docs.length ? docTable(docs) : '<p class="muted">Associe documentos à obra na revisão de cada documento.</p>'}<h3 class="section-title">Notas privadas</h3><div class="details">${esc(w.data.notes || "Sem notas.")}</div>`,
  );
}
async function sourceLines(id) {
  const d = await api("/api/documents/" + id);
  state.currentSource = d;
  modal(
    "Materiais · " + d.filename,
    `<div class="banner warn">${badge(d.ocr_status)}<p>Linhas sugeridas apenas quando o texto contém colunas reconhecíveis. Confirme os dados e introduza cobertura, medidas e IVA.</p></div>${(d.extraction.lines || []).map((l, i) => `<div class="list-row"><div><b>${esc(l.name)}</b><div class="muted">${l.quantity} ${esc(l.unit)} · ${euro(l.price)} · página ${l.page}</div></div>${btn("Rever e registar", "source-line", `data-index="${i}"`, "small")}</div>`).join("") || empty("Sem linhas reconhecidas", "Pode consultar o original e introduzir os materiais manualmente.")}<div class="buttons">${btn("Registar linha manual", "source-manual", "", "primary")}${btn("Ver original", "document", `data-id="${d.id}"`)}${btn("Atualizar extração", "source-lines", `data-id="${d.id}"`)}</div>`,
  );
}
function compareDialog() {
  const ids = [...state.materialSelection].filter((id) =>
    state.materials.some((m) => m.id === id),
  );
  if (ids.length < 2) {
    toast("Selecione pelo menos dois materiais.", true);
    return;
  }
  modal(
    "Comparar preços e necessidades",
    `<form id="compare-form"><div class="fields">${field("Área necessária (m²; opcional)", "area", "", "number", 'min="0" step="0.01"')}${field("Desperdício (%)", "waste", 10, "number", 'min="0" max="100" step="0.1"')}</div><label class="checkbox"><input type="checkbox" name="confirmed">Confirmei no original que estes produtos são comparáveis, incluindo medidas, características e espessura.</label><button class="btn primary">Calcular comparação</button></form><div id="compare-result"></div>`,
  );
}
function compareResult(r) {
  $("#compare-result").innerHTML =
    `<div class="banner warn">${esc(r.warning)}</div><div class="grid-two">${r.items.map((i) => `<article class="card ${r.best_id === i.id ? "compare-best" : ""}"><div class="card-head"><h2>${esc(i.data.name)}</h2>${r.best_id === i.id ? '<span class="badge green">Mais económico c/ IVA</span>' : ""}</div><p>${esc(i.data.supplier || "Fornecedor por confirmar")} · ${date(i.data.date)}</p><span class="badge ${i.comparable ? "green" : "warn"}">${esc(i.comparison)}</span><div class="list-row"><span>Preço original sem IVA</span><b>${euro(i.price.original)}</b></div><div class="list-row"><span>Normalizado sem IVA</span><b>${euro(i.price.unit_net)} / ${esc(i.price.unit)}</b></div><div class="list-row"><span>Normalizado com IVA</span><b>${i.price.vat_assumed ? "IVA por confirmar" : euro(i.price.unit_gross)} / ${esc(i.price.unit)}</b></div><div class="list-row"><span>Com portes</span><b>${euro(i.price.unit_with_shipping)} / ${esc(i.price.unit)}</b></div>${i.difference_eur != null ? `<div class="list-row"><span>Diferença para o mais económico</span><b>${euro(i.difference_eur)} · ${i.difference_percent ?? "—"}%</b></div>` : ""}${i.needs ? `<div class="banner info"><div><b>${i.needs.packs} embalagem(ns) / unidade(s) completas</b><p>Área com desperdício: ${i.needs.area_with_waste.toFixed(2)} m²</p><p>${euro(i.needs.total_net)} sem IVA · ${euro(i.needs.total_gross)} com IVA</p><p>${i.needs.shipping_known ? "Total com portes: " + euro(i.needs.total_with_shipping) : "Portes por confirmar"}</p></div></div>` : ""}${i.price.missing?.length ? `<p class="badge warn">${esc(i.price.missing.join(", "))}</p>` : ""}${i.price.consumption ? `<p class="footnote">Custo estimado: ${i.price.consumption} kg/m²; espessura ${esc(i.price.application_thickness || "por confirmar")} mm.</p>` : ""}<p class="footnote">${esc(i.suggestion_method)}</p></article>`).join("")}</div>${r.best_id == null ? '<p class="muted">Não há dois produtos com comparabilidade e IVA confirmados para indicar o mais económico.</p>' : ""}`;
}
async function settingsPage() {
  const integrations = await api("/api/integrations");
  let audit = [];
  if (admin()) audit = await api("/api/audit");
  $("#content").innerHTML =
    heading(
      "O seu espaço",
      "Definições",
      "Entidades, integrações, segurança e cópias dos seus dados.",
    ) +
    `<section class="card"><h2>A minha conta</h2><p>${esc(state.user.email)} · ${admin() ? "Administrador" : "Contabilista"}</p>${btn("Alterar palavra-passe", "password", "", "small")}</section>${admin() ? `<section class="card"><div class="card-head"><h2>Entidades</h2>${btn("+ Nova entidade", "entity", "", "small")}</div>${state.entities.map((e) => `<div class="list-row"><div><b>${esc(e.name)}</b><div class="muted">NIF ${esc(e.nif)} · ${esc(e.kind)}</div></div><span class="badge">Dados separados</span></div>`).join("") || empty("Adicione a primeira entidade", "Crie uma entidade pessoal ou empresa para organizar os seus documentos.")}</section>` : ""}<section class="card"><h2>Serviços e custos</h2>${Object.values(
      integrations,
    )
      .map(
        (i) =>
          `<div class="list-row"><div>${esc(i.service)}</div><span class="badge ${i.configured ? "green" : "warn"}">${i.configured ? "Disponível" : "Não configurado"}</span></div>`,
      )
      .join(
        "",
      )}<p class="footnote">Não são enviadas informações a serviços de IA externos. A extração local não tem custo por chamada. Alojamento, domínio, HTTPS e cópias externas dependem do fornecedor escolhido.</p></section>${admin() ? `<section class="card"><h2>Cópia de segurança e exportação completa</h2><p class="muted">Inclui base de dados, contas e todos os originais, até os documentos apagados. Guarde num local seguro, fora deste servidor.</p><a class="btn" href="/api/backup">↓ Descarregar cópia privada</a><p class="footnote">Cópia manual disponível. A cópia automática deve ser agendada no alojamento, conforme o README. Esta cópia nunca deve ser entregue ao contabilista.</p></section><section class="card"><h2>Registo de alterações</h2><div class="table-wrap"><table><thead><tr><th>Data</th><th>Quem</th><th>Ação</th><th>Registo</th></tr></thead><tbody>${audit.map((a) => `<tr><td>${date(a.created)} ${esc(a.created.slice(11, 19))} UTC</td><td>${esc(a.author || "Processamento local")}</td><td>${esc(a.action)}</td><td>${esc(a.resource)} #${a.resource_id ?? "—"}<div class="muted">${esc(a.detail)}</div></td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
}
function entityDialog() {
  modal(
    "Nova entidade",
    `<form id="entity-form"><div class="fields">${field("Nome", "name", "", "text", "required")}${field("NIF", "nif", "", "text", 'required pattern="[0-9]{9}" maxlength="9"')}${selectField(
      "Tipo",
      "kind",
      opts(
        [
          ["pessoal", "Pessoal"],
          ["empresa", "Empresa"],
        ],
        "pessoal",
      ),
    )}</div><button class="btn primary">Criar entidade</button></form>`,
  );
}
function passwordDialog() {
  modal(
    "Alterar palavra-passe",
    `<form id="password-form">${field("Palavra-passe atual", "current_password", "", "password", 'required autocomplete="current-password"')}${field("Nova palavra-passe", "password", "", "password", 'required minlength="12" autocomplete="new-password"')}<button class="btn primary">Guardar e terminar sessão</button></form>`,
  );
}

// All actions use delegated listeners: no executable document content or inline handlers.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action,
    id = button.dataset.id,
    kind = button.dataset.kind;
  try {
    switch (action) {
      case "close":
        $("#modal").close();
        break;
      case "menu":
        $(".shell").classList.toggle("menu-open");
        break;
      case "nav":
        await navigate(button.dataset.page);
        break;
      case "logout":
        await post("/api/logout", {});
        state.entity = "";
        await init();
        break;
      case "toggle-register":
        authPage(false, !state.registerInvite);
        break;
      case "entity":
        entityDialog();
        break;
      case "password":
        passwordDialog();
        break;
      case "upload-dialog":
        if (!state.entities.length) {
          entityDialog();
          break;
        }
        modal("Carregar documentos", uploadBox());
        break;
      case "choose-upload":
        $("#" + button.dataset.input).click();
        break;
      case "document":
        await openDocument(id);
        break;
      case "apply-suggestions":
        if (
          confirm(
            "Aplicar sugestões aos campos? As alterações ainda não guardadas serão substituídas.",
          )
        )
          await openDocument(id, true);
        break;
      case "retry-ocr":
        await post(`/api/documents/${id}/retry`, {});
        toast("Extração novamente em fila.");
        await openDocument(id);
        break;
      case "delete-document":
        if (
          confirm(
            "Apagar este documento? Pode recuperá-lo nas Definições do arquivo.",
          )
        ) {
          await api("/api/documents/" + id, { method: "DELETE" });
          $("#modal").close();
          await navigate(state.page);
        }
        break;
      case "trash":
        await trash();
        break;
      case "restore-document":
        await post(`/api/documents/${id}/restore`, {});
        await loadDocuments();
        await trash();
        if (state.page === "documents") renderDocTable();
        break;
      case "bank-import":
        bankImportDialog();
        break;
      case "bank-manual":
        bankManualDialog();
        break;
      case "bank-pdf-review": {
        const r = await api("/api/bank/preview/" + id);
        if (r.pending) {
          toast(
            "Extração ainda em curso. Atualize dentro de alguns instantes.",
          );
          break;
        }
        state.import = {
          ...r,
          entity_id: state.currentDoc.entity_id,
          bank: "",
          account: "",
          mapping: autoMap(r.columns),
          page: 0,
        };
        if (r.rows.length) {
          modal(
            "Conta do extrato",
            `<form id="bank-pdf-account-form">${field("Banco", "bank", "", "text", "required")}${field("Conta", "account", "", "text", "required")}<button class="btn primary">Rever movimentos</button></form>`,
          );
        } else {
          toast(r.warning, true);
          bankManualDialog();
        }
        break;
      }
      case "bank-prev":
        if (state.import.page > 0) {
          state.import.page--;
          bankReviewTable();
        }
        break;
      case "bank-next":
        if ((state.import.page + 1) * 50 < state.import.edited.length) {
          state.import.page++;
          bankReviewTable();
        }
        break;
      case "movement":
        await movementDialog(id);
        break;
      case "unlink":
        if (confirm("Remover a associação de pagamento?")) {
          await api("/api/allocations/" + id, { method: "DELETE" });
          await navigate("bank");
        }
        break;
      case "invite":
        inviteDialog();
        break;
      case "access-edit":
        inviteDialog(id);
        break;
      case "revoke-access":
        if (confirm("Revogar todas as permissões deste contabilista?")) {
          await api("/api/access/" + id, {
            method: "PUT",
            body: { scope: [] },
          });
          await navigate("accountant");
          toast("Acesso revogado.");
        }
        break;
      case "revoke-invite":
        await api("/api/invitations/" + id, { method: "DELETE" });
        await navigate("accountant");
        break;
      case "request":
        requestDialog();
        break;
      case "private-add":
        privateDialog(kind);
        break;
      case "private-edit":
        privateDialog(kind, id);
        break;
      case "private-delete":
        if (confirm("Apagar este registo privado?")) {
          await api(`/api/private/${kind}/${id}`, { method: "DELETE" });
          $("#modal").close();
          await navigate(state.page);
        }
        break;
      case "work-detail":
        workDetail(id);
        break;
      case "work-expense":
        privateDialog("expenses", null, { work_id: id });
        break;
      case "source-lines":
        await sourceLines(id);
        break;
      case "source-line": {
        const d = state.currentSource,
          l = d.extraction.lines[Number(button.dataset.index)];
        privateDialog("materials", null, {
          ...l,
          description: l.name,
          document_id: d.id,
          supplier: d.metadata.supplier,
          date: d.metadata.date,
          work_id: d.work_id,
        });
        break;
      }
      case "source-manual": {
        const d = state.currentSource;
        privateDialog("materials", null, {
          document_id: d.id,
          supplier: d.metadata.supplier,
          date: d.metadata.date,
          work_id: d.work_id,
        });
        break;
      }
      case "compare":
        compareDialog();
        break;
    }
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    d = values(form);
  const submit = $('button[type="submit"],button:not([type])', form);
  if (submit) submit.disabled = true;
  try {
    switch (form.id) {
      case "auth-form": {
        const path = state.needsSetup
          ? "/api/setup"
          : state.registerInvite
            ? "/api/register-invite"
            : "/api/login";
        if (state.registerInvite) d.token = state.invite;
        const r = await post(path, d);
        state.csrf = r.csrf;
        await init();
        break;
      }
      case "entity-form":
        await post("/api/entities", d);
        $("#modal").close();
        state.entities = await api("/api/entities");
        state.entity = String(state.entities.at(-1)?.id || "");
        shell();
        await navigate(state.page);
        toast("Entidade criada.");
        break;
      case "password-form":
        await post("/api/password", d);
        $("#modal").close();
        await init();
        toast("Palavra-passe alterada. Inicie sessão novamente.");
        break;
      case "upload-entity-form": {
        const pending = state.pendingFiles;
        $("#modal").close();
        await performUpload(pending.files, d.entity_id, pending.privateMode);
        break;
      }
      case "document-form": {
        const metadata = {};
        for (const [, key, type] of metaFields)
          metadata[key] =
            type === "number"
              ? d[key] === ""
                ? null
                : Number(d[key])
              : d[key];
        metadata.currency = "EUR";
        metadata.vat_rates = d.vat_rates ? JSON.parse(d.vat_rates) : [];
        const payload = {
          metadata,
          entity_id: Number(d.entity_id),
          work_id: d.work_id ? Number(d.work_id) : null,
          review: d.review,
          visibility: d.visibility,
        };
        try {
          await api("/api/documents/" + form.dataset.id, {
            method: "PUT",
            body: payload,
          });
        } catch (e) {
          if (e.status !== 409 || !confirm(e.message + " Guardar mesmo assim?"))
            throw e;
          payload.confirm_duplicate = true;
          await api("/api/documents/" + form.dataset.id, {
            method: "PUT",
            body: payload,
          });
        }
        await loadDocuments();
        await loadPrivate();
        await openDocument(form.dataset.id);
        if (state.page === "documents") renderDocTable();
        toast("Documento guardado.");
        break;
      }
      case "comment-form":
        await post(`/api/documents/${form.dataset.id}/comments`, d);
        await openDocument(form.dataset.id);
        break;
      case "accounting-form":
        await post(`/api/documents/${form.dataset.id}/accounting`, d);
        await openDocument(form.dataset.id);
        toast("Estado registado.");
        break;
      case "bank-preview-form": {
        const fd = new FormData(form);
        let r = await api("/api/bank/preview", { method: "POST", body: fd });
        if (r.pending) {
          const source = r.source_id;
          modal(
            "A processar extrato PDF",
            `<p>O original foi guardado. A extração decorre em segundo plano.</p><p class="muted">A aguardar movimentos para revisão…</p>${btn("Consultar original / repetir extração", "document", `data-id="${source}"`, "small")}`,
          );
          for (let i = 0; i < 90 && r.pending; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            r = await api("/api/bank/preview/" + source);
          }
          if (r.pending) {
            toast(
              "A extração continua em segundo plano. Pode reabrir o extrato no arquivo.",
              true,
            );
            return;
          }
        }
        state.import = {
          ...r,
          entity_id: Number(d.entity_id),
          bank: d.bank,
          account: d.account,
          mapping: autoMap(r.columns),
          page: 0,
        };
        if (!r.rows.length) {
          toast(r.warning, true);
          bankManualDialog();
        } else bankReviewDialog();
        break;
      }
      case "bank-pdf-account-form":
        state.import.bank = d.bank;
        state.import.account = d.account;
        bankReviewDialog();
        break;
      case "bank-mapping-form":
        state.import.mapping = d;
        mappedBankRows();
        bankReviewTable();
        break;
      case "bank-save-form": {
        const im = state.import;
        const payload = {
          entity_id: im.entity_id,
          bank: im.bank,
          account: im.account,
          source_id: im.source_id,
          rows: im.edited.filter((r) => r.selected),
        };
        await importBank(payload);
        break;
      }
      case "bank-manual-form": {
        const { entity_id, bank, account, ...row } = d;
        await importBank({
          entity_id: Number(entity_id),
          bank,
          account,
          source_id: state.import?.source_id,
          rows: [row],
        });
        break;
      }
      case "allocation-form":
        await post("/api/allocations", d);
        $("#modal").close();
        await navigate("bank");
        toast("Pagamento associado e estado atualizado.");
        break;
      case "classify-form":
        await api("/api/movements/" + form.dataset.id, {
          method: "PUT",
          body: d,
        });
        $("#modal").close();
        await navigate("bank");
        break;
      case "export-form": {
        const entity = Number(d.entity_id),
          period = d.period;
        window.location.assign(
          `/api/export?entity_id=${entity}&period=${encodeURIComponent(period)}`,
        );
        break;
      }
      case "invite-form": {
        d.scope = readScopes(form);
        if (form.dataset.id) {
          await api("/api/access/" + form.dataset.id, {
            method: "PUT",
            body: d,
          });
          $("#modal").close();
          await navigate("accountant");
        } else {
          const r = await post("/api/invitations", d);
          const url = new URL(r.path, location.origin).href;
          modal(
            "Convite criado",
            `<div class="success">Link válido durante 7 dias. Exige autenticação com o email convidado.</div><label class="field"><span>Copie e envie este link ao contabilista</span><input value="${esc(url)}" readonly id="invite-url"></label><p class="footnote">O link dá acesso apenas às permissões escolhidas. Pode revogá-lo a qualquer momento.</p>`,
          );
          $("#invite-url").select();
        }
        break;
      }
      case "request-form":
        await post("/api/requests", d);
        $("#modal").close();
        await navigate("accountant");
        break;
      case "private-form": {
        const kind = form.dataset.kind;
        if (kind === "works")
          d.categories = (d.categories || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        if (kind === "contacts") {
          d.specialties = (d.specialties || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          d.favorite = !!form.elements.favorite.checked;
          d.work_ids = $$('[name="work_ids"]:checked', form).map((i) =>
            Number(i.value),
          );
          d.document_ids = $$('[name="document_ids"]:checked', form).map((i) =>
            Number(i.value),
          );
        }
        await api(
          "/api/private/" +
            kind +
            (form.dataset.id ? "/" + form.dataset.id : ""),
          { method: form.dataset.id ? "PUT" : "POST", body: d },
        );
        $("#modal").close();
        await navigate(state.page);
        toast("Registo privado guardado.");
        break;
      }
      case "compare-form": {
        const r = await post("/api/materials/compare", {
          ids: [...state.materialSelection],
          area: d.area,
          waste: d.waste,
          confirmed: form.elements.confirmed.checked,
        });
        compareResult(r);
        break;
      }
      default:
        if (form.classList.contains("reply-form")) {
          d.resolved = form.elements.resolved.checked;
          await post(`/api/requests/${form.dataset.id}/reply`, d);
          await navigate("accountant");
        }
    }
  } catch (e) {
    formError(form, e);
  } finally {
    if (submit) submit.disabled = false;
  }
});
async function importBank(payload) {
  try {
    await post("/api/bank/import", payload);
  } catch (e) {
    if (
      e.status !== 409 ||
      !confirm(
        `${e.message} Linhas: ${e.details.duplicate_rows?.join(", ")}. Aceitar duplicados?`,
      )
    )
      throw e;
    payload.confirm_duplicates = true;
    await post("/api/bank/import", payload);
  }
  $("#modal").close();
  await navigate("bank");
  toast("Movimentos importados. Confirme as associações às faturas.");
}
document.addEventListener("change", async (event) => {
  const el = event.target;
  if (el.id === "global-entity") {
    state.entity = el.value;
    await navigate(state.page);
  } else if (el.id === "files" || el.id === "camera") {
    const mode = $("#dropzone")?.dataset.private === "true";
    await uploadFiles([...el.files], mode);
    el.value = "";
  } else if (el.dataset.materialId) {
    const id = Number(el.dataset.materialId);
    el.checked
      ? state.materialSelection.add(id)
      : state.materialSelection.delete(id);
  } else if (el.dataset.bankKey) {
    const r = state.import.edited[Number(el.closest("tr").dataset.index)];
    r[el.dataset.bankKey] = el.type === "checkbox" ? el.checked : el.value;
  } else if (["doc-state", "doc-period"].includes(el.id)) renderDocTable();
  else if (el.id === "bank-filter") renderBankTable();
  else if (["private-work", "private-favorite"].includes(el.id))
    renderPrivateList(state.page);
});
document.addEventListener("input", (event) => {
  const id = event.target.id;
  if (["doc-search", "doc-category", "doc-min", "doc-max"].includes(id))
    renderDocTable();
  if (id === "bank-search") renderBankTable();
  if (["private-search", "private-category"].includes(id))
    renderPrivateList(state.page);
  if (event.target.dataset.bankKey) {
    const r =
      state.import.edited[Number(event.target.closest("tr").dataset.index)];
    r[event.target.dataset.bankKey] =
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.value;
  }
});
document.addEventListener("dragover", (event) => {
  const zone = event.target.closest("#dropzone");
  if (zone) {
    event.preventDefault();
    zone.classList.add("drag");
  }
});
document.addEventListener("dragleave", (event) => {
  event.target.closest("#dropzone")?.classList.remove("drag");
});
document.addEventListener("drop", async (event) => {
  const zone = event.target.closest("#dropzone");
  if (zone) {
    event.preventDefault();
    zone.classList.remove("drag");
    await uploadFiles(
      [...event.dataTransfer.files],
      zone.dataset.private === "true",
    );
  }
});
$("#modal").addEventListener("click", (event) => {
  if (event.target === $("#modal")) {
    const r = event.target.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      $("#modal").close();
  }
});
init();
