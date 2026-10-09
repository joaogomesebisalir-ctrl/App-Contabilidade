/* Cloud-only enhancements; the local Flask application keeps its existing workflow. */
window.ContaCloud = (() => {
  let config = null,
    processor = null,
    sequence = 0,
    assets = null;
  const jobs = new Map(),
    documents = new Map();
  function message(error) {
    return error?.message || String(error);
  }
  function worker() {
    if (!processor) {
      processor = new Worker("/static/cloud-processor.js");
      processor.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        if (data.progress) {
          job.progress?.(data.progress);
          return;
        }
        jobs.delete(data.id);
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.result);
      };
      processor.onerror = (e) => {
        for (const job of jobs.values())
          job.reject(
            new Error(e.message || "O motor de extração não arrancou."),
          );
        jobs.clear();
        processor.terminate();
        processor = null;
      };
    }
    return processor;
  }
  function run(type, file, progress) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      jobs.set(id, { resolve, reject, progress });
      worker().postMessage({ id, type, file });
    });
  }
  async function process(id, file, progress) {
    if (!config?.enabled) return;
    if (documents.has(id)) return documents.get(id);
    const job = (async () => {
      try {
        if (!file) {
          const link = await config.api(`/api/documents/${id}/link`);
          const response = await fetch(link.url, {
            credentials: "same-origin",
          });
          if (!response.ok)
            throw new Error("Não foi possível obter o original.");
          const blob = await response.blob();
          file = new File(
            [blob],
            "original." +
              (blob.type === "application/pdf"
                ? "pdf"
                : blob.type === "image/png"
                  ? "png"
                  : "jpg"),
            { type: blob.type },
          );
        }
        progress?.("A extrair neste dispositivo…");
        const extraction = await run("extract", file, progress);
        await config.api(`/api/documents/${id}/extraction`, {
          method: "POST",
          body: { extraction },
        });
        progress?.("Extração concluída. Confirme os dados.");
      } catch (e) {
        try {
          await config.api(`/api/documents/${id}/extraction`, {
            method: "POST",
            body: { error: message(e) },
          });
        } catch {}
        progress?.(
          "Não foi possível extrair automaticamente. Pode preencher os dados.",
        );
        throw e;
      } finally {
        documents.delete(id);
      }
    })();
    documents.set(id, job);
    return job;
  }
  async function preview(file) {
    if (!config?.enabled || /\.pdf$/i.test(file.name)) return null;
    return run("statement", file);
  }
  async function resume(docs) {
    if (!config?.enabled) return;
    for (const doc of docs.filter(
      (d) =>
        d.ocr_status === "queued" &&
        ["application/pdf", "image/jpeg", "image/png"].includes(d.mime),
    )) {
      try {
        await process(doc.id);
      } catch {}
    }
  }
  async function archive(url, progress) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
      let err = {};
      try {
        err = await response.json();
      } catch {}
      throw new Error(err.error || "Não foi possível preparar a cópia.");
    }
    let manifest = await response.json();
    if (response.headers.get("X-Conta-Archive") === "snapshot") {
      const snapshot = manifest;
      manifest = {
        filename:
          "copia-privada-" + new Date().toISOString().slice(0, 10) + ".zip",
        files: [
          { name: "dados.json", text: JSON.stringify(snapshot) },
          {
            name: "LEIA-ME.txt",
            text: "Cópia privada: contém contas, hashes e todos os originais. Não partilhe com o contabilista.",
          },
          ...snapshot.tables.documents.map((d) => ({
            name: "files/" + d.storage,
            document_id: d.id,
            sha256: d.sha256,
            backup: true,
          })),
        ],
      };
    }
    if (
      !manifest.client_archive &&
      response.headers.get("X-Conta-Archive") !== "snapshot"
    )
      throw new Error("Formato de exportação inválido.");
    const data = {};
    let index = 0;
    for (const file of manifest.files) {
      if (
        !file.name ||
        file.name.startsWith("/") ||
        file.name.split("/").includes("..")
      )
        throw new Error("Caminho de arquivo inválido.");
      progress?.(`A preparar ${++index}/${manifest.files.length}…`);
      if (file.text != null) {
        data[file.name] = new TextEncoder().encode(file.text);
        continue;
      }
      let link = file.url;
      if (file.document_id) {
        const route = file.backup
          ? `/api/backup/link?document_id=${file.document_id}`
          : `/api/documents/${file.document_id}/link`;
        link = (await config.api(route)).url;
      }
      const r = await fetch(link, { credentials: "same-origin" });
      if (!r.ok)
        throw new Error(
          "A descarga não foi autorizada. Verifique as permissões.",
        );
      const bytes = new Uint8Array(await r.arrayBuffer());
      const actual = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      if (actual !== file.sha256)
        throw new Error("O original não corresponde à cópia esperada.");
      data[file.name] = bytes;
    }
    assets ||= await fetch("/static/cloud-assets.json").then((r) => r.json());
    const { zip } = await import(assets.zip + "/browser.js");
    const result = await new Promise((resolve, reject) =>
      zip(data, { level: 0 }, (err, result) =>
        err ? reject(err) : resolve(result),
      ),
    );
    const object = URL.createObjectURL(
      new Blob([result], { type: "application/zip" }),
    );
    const a = document.createElement("a");
    a.href = object;
    a.download = manifest.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(object), 60000);
    progress?.("Cópia preparada.");
  }
  document.addEventListener("click", async (e) => {
    const link = e.target.closest('a[href="/api/backup"]');
    if (!link || !config?.enabled) return;
    e.preventDefault();
    const label = link.textContent;
    link.setAttribute("aria-busy", "true");
    try {
      await archive("/api/backup", (text) => {
        link.textContent = text;
      });
    } catch (err) {
      alert(message(err));
    } finally {
      link.removeAttribute("aria-busy");
      link.textContent = label;
    }
  });
  return {
    configure: (c) => {
      config = c;
    },
    process,
    preview,
    resume,
    archive,
  };
})();
