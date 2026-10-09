/* Document decoding runs in a dedicated browser thread, never in a server runtime. */
let assets, ocr, pdfjs, xlsx;
async function paths() {
  return (assets ||= await fetch("/static/cloud-assets.json").then((r) =>
    r.json(),
  ));
}
const money = (v) => {
  if (v == null || String(v).trim() === "") return null;
  let s = String(v).replace(/€|EUR|\s/g, "");
  if (s.includes(",")) s = s.replaceAll(".", "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= 1e10 ? Math.round(n * 100) : null;
};
function dateISO(s) {
  if (!s) return null;
  let m;
  if ((m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s)))
    s = `${m[3]}-${m[2]}-${m[1]}`;
  else if (/^\d{8}$/.test(s))
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(+new Date(s))
    ? s
    : null;
}
function qrFields(value) {
  if (!value.startsWith("A:") || !value.includes("*O:")) return null;
  const parts = Object.fromEntries(
    value
      .split("*")
      .filter((x) => x.includes(":"))
      .map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1)]),
  );
  const fields = {};
  for (const [k, target] of [
    ["A", "supplier_nif"],
    ["B", "recipient_nif"],
    ["G", "number"],
  ])
    if (parts[k]) fields[target] = parts[k];
  if (dateISO(parts.F)) fields.date = dateISO(parts.F);
  for (const [k, target] of [
    ["N", "vat"],
    ["O", "total"],
  ])
    if (money(parts[k]) != null) fields[target] = money(parts[k]) / 100;
  if (fields.total != null && fields.vat != null)
    fields.net = Math.round((fields.total - fields.vat) * 100) / 100;
  fields.type =
    { FT: "Fatura", FR: "Fatura-recibo", RC: "Recibo", NC: "Nota de crédito" }[
      parts.D
    ] || "Outro";
  fields.currency = "EUR";
  fields.vat_rates = [];
  for (const region of ["I", "J", "K"])
    for (const [base, tax, rate] of [
      ["3", "4", "reduzida"],
      ["5", "6", "intermédia"],
      ["7", "8", "normal"],
    ])
      if (parts[region + base] || parts[region + tax])
        fields.vat_rates.push({
          region: parts[region + "1"],
          rate,
          base: parts[region + base],
          vat: parts[region + tax],
        });
  return fields;
}
function suggestions(pages, qrs) {
  const text = pages.join("\n\n").slice(0, 150000),
    fields = {},
    confidence = {},
    warnings = [],
    lines = [];
  for (const [label, key] of [
    ["fornecedor", "supplier"],
    ["destinatário", "recipient"],
    ["descrição", "description"],
    ["NIF fornecedor", "supplier_nif"],
    ["NIF destinatário", "recipient_nif"],
  ]) {
    const m = new RegExp("^" + label + "\\s*:\\s*(.+)$", "im").exec(text);
    if (m) {
      fields[key] = m[1].trim();
      confidence[key] = "baixa";
    }
  }
  for (const [label, key] of [
    ["total(?: a pagar)?", "total"],
    ["total sem IVA|subtotal", "net"],
    ["total IVA|IVA total", "vat"],
  ]) {
    const m = new RegExp(
      "^\\s*(?:" +
        label +
        ")\\s*[:\\-]?\\s*([\\d .]+[,.]\\d{2})\\s*(?:€|EUR)?\\s*$",
      "im",
    ).exec(text);
    if (m && money(m[1]) != null) {
      fields[key] = money(m[1]) / 100;
      confidence[key] = "baixa";
    }
  }
  const dt =
    /(?:data(?: de emissão)?)\s*:?\s*(\d{2}[/-]\d{2}[/-]\d{4}|\d{4}-\d{2}-\d{2})/i.exec(
      text,
    );
  if (dt && dateISO(dt[1])) {
    fields.date = dateISO(dt[1]);
    confidence.date = "baixa";
  }
  const nr =
    /(fatura[- ]recibo|fatura|factura|recibo|nota de crédito|orçamento)\s*(?:n[.ºo°]*\s*)?[:#]?\s*([A-Z]{0,5}\s*\d[\w/.-]*)/i.exec(
      text,
    );
  if (nr) {
    fields.type = nr[1][0].toUpperCase() + nr[1].slice(1).toLowerCase();
    fields.number = nr[2].trim();
    confidence.number = "baixa";
  }
  const fiscal = qrs.map(qrFields).find(Boolean);
  if (fiscal)
    for (const [k, v] of Object.entries(fiscal)) {
      if (k in fields && String(fields[k]) !== String(v))
        warnings.push(
          `Divergência entre texto e QR: ${k}. Confirme no original.`,
        );
      fields[k] = v;
      confidence[k] = "QR fiscal — confirmar";
    }
  pages.forEach((page, i) => {
    for (const line of page.split("\n")) {
      const cells = line.split(/\s*;\s*|\s*\|\s*|\t/).map((s) => s.trim());
      if (cells.length >= 4) {
        const quantity = Number(cells[1].replace(",", ".")),
          price = money(cells[3]);
        if (
          quantity > 0 &&
          Number.isFinite(quantity) &&
          price != null &&
          price >= 0
        )
          lines.push({
            name: cells[0],
            quantity,
            unit: cells[2],
            price: price / 100,
            page: i + 1,
            confidence: "baixa",
          });
      }
    }
  });
  return {
    fields,
    confidence,
    warnings,
    text,
    lines: lines.slice(0, 5000),
    pages: pages.length,
    method: "OCR / texto PDF / QR fiscal neste dispositivo",
    ai_configured: false,
  };
}
class CanvasFactory {
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(target, width, height) {
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target) {
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}
async function recognize(canvas, id) {
  const a = await paths();
  if (!ocr) {
    postMessage({ id, progress: "A preparar o motor de OCR e os idiomas…" });
    importScripts(a.tesseract + "/tesseract.min.js");
    ocr = await Tesseract.createWorker("por+eng", 1, {
      workerPath: a.tesseract + "/worker.min.js",
      corePath: a.core,
      langPath: a.languages,
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === "recognizing text")
          postMessage({
            id,
            progress: `A reconhecer texto… ${Math.round(m.progress * 100)}%`,
          });
      },
    });
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return (await ocr.recognize(await blob.arrayBuffer())).data.text;
}
async function inspect(canvas, text, qrs, id) {
  const a = await paths();
  if (!self.jsQR) importScripts(a.qr + "/jsQR.js");
  const ctx = canvas.getContext("2d", { willReadFrequently: true }),
    image = ctx.getImageData(0, 0, canvas.width, canvas.height),
    qr = jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth",
    });
  if (qr?.data) qrs.push(qr.data);
  if (text.trim().length < 40)
    text += (text.trim() ? "\n\n" : "") + (await recognize(canvas, id));
  return text;
}
async function extract(file, id) {
  const pages = [],
    qrs = [],
    a = await paths();
  if (file.size > 20 * 1024 * 1024) throw Error("Limite de 20 MB.");
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    pdfjs ||= await import(a.pdf + "/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = a.pdf + "/build/pdf.worker.mjs";
    const task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      useWorkerFetch: true,
      disableFontFace: true,
      CanvasFactory,
      standardFontDataUrl: a.pdf + "/standard_fonts/",
      cMapUrl: a.pdf + "/cmaps/",
      cMapPacked: true,
      wasmUrl: a.pdf + "/wasm/",
    });
    const pdf = await task.promise;
    if (pdf.numPages > 100) {
      await task.destroy();
      throw Error("Limite de 100 páginas.");
    }
    for (let i = 1; i <= pdf.numPages; i++) {
      postMessage({ id, progress: `A ler página ${i}/${pdf.numPages}…` });
      const page = await pdf.getPage(i),
        content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
      const base = page.getViewport({ scale: 1 }),
        scale = Math.min(1800 / base.width, 1800 / base.height),
        viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({ canvasContext: canvas.getContext("2d"), viewport })
        .promise;
      text = await inspect(canvas, text, qrs, id);
      pages.push(text);
      canvas.width = canvas.height = 1;
      page.cleanup();
    }
    await task.destroy();
  } else {
    const image = await createImageBitmap(file);
    if (image.width * image.height > 40000000) {
      image.close();
      throw Error("Limite de 40 megapíxeis.");
    }
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height)),
      canvas = new OffscreenCanvas(
        Math.round(image.width * scale),
        Math.round(image.height * scale),
      );
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    pages.push(await inspect(canvas, "", qrs, id));
    canvas.width = canvas.height = 1;
  }
  return suggestions(pages, qrs);
}
function csv(text) {
  let delimiter = ";";
  const header = text.split(/\r?\n/)[0];
  for (const candidate of [",", "\t", "|"])
    if (header.split(candidate).length > header.split(delimiter).length)
      delimiter = candidate;
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("CSV com aspas não fechadas.");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function checkZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error("Excel inválido.");
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true),
    total = 0;
  if (count === 65535) throw Error("Excel demasiado grande.");
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50)
      throw Error("Excel inválido.");
    total += view.getUint32(pos + 24, true);
    if (total > 100 * 1024 * 1024)
      throw Error("Excel demasiado grande após descompressão.");
    pos +=
      46 +
      view.getUint16(pos + 28, true) +
      view.getUint16(pos + 30, true) +
      view.getUint16(pos + 32, true);
  }
}
async function statement(file) {
  if (file.size > 20 * 1024 * 1024) throw Error("Limite de 20 MB.");
  const raw = new Uint8Array(await file.arrayBuffer());
  let table;
  if (/\.csv$/i.test(file.name)) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder("windows-1252").decode(raw);
    }
    table = csv(text.replace(/^\ufeff/, ""));
  } else {
    if (/\.xlsx$/i.test(file.name)) checkZip(raw);
    if (!self.XLSX) importScripts((await paths()).xlsx + "/xlsx.full.min.js");
    const book = XLSX.read(raw, { type: "array", cellDates: true });
    const sheet = book.Sheets[book.SheetNames[0]],
      range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    if (range.e.r > 5000 || range.e.c > 99)
      throw Error("Limite de 5000 movimentos e 100 colunas.");
    table = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });
  }
  if (!table.length) throw Error("Extrato vazio.");
  const columns = table[0].map((v, i) => String(v || `Coluna ${i + 1}`));
  if (new Set(columns).size !== columns.length)
    throw Error("Os cabeçalhos devem ser únicos.");
  if (table.length > 5001 || columns.length > 100)
    throw Error("Limite de 5000 movimentos e 100 colunas.");
  const rows = table
    .slice(1)
    .filter((r) => r.some((v) => v !== "" && v != null))
    .map((row) =>
      Object.fromEntries(
        columns.map((key, i) => [
          key,
          row[i] instanceof Date
            ? row[i].toISOString().slice(0, 10)
            : (row[i] ?? ""),
        ]),
      ),
    );
  return { rows, columns };
}
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const result =
        data.type === "extract"
          ? await extract(data.file, data.id)
          : await statement(data.file);
      postMessage({ id: data.id, result });
    } catch (e) {
      postMessage({
        id: data.id,
        error: e.message || "Não foi possível ler este ficheiro.",
      });
    }
  });
};
