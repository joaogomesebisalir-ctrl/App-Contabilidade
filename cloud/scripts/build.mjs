import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  pub = resolve(root, "public"),
  repo = resolve(root, ".."),
  modules = resolve(root, "node_modules");
await rm(pub, { recursive: true, force: true });
await mkdir(pub, { recursive: true });
await cp(resolve(repo, "app/static"), resolve(pub, "static"), {
  recursive: true,
});
await cp(resolve(repo, "app/templates/index.html"), resolve(pub, "index.html"));
const assets = {};
async function vendor(pkg, sub, files) {
  const info = JSON.parse(
    await readFile(resolve(modules, pkg, "package.json")),
  );
  const base = `vendor/${pkg.replaceAll("/", "-").replace("@", "")}-${info.version}`;
  await mkdir(resolve(pub, base), { recursive: true });
  for (const file of files)
    await cp(resolve(modules, pkg, sub, file), resolve(pub, base, file), {
      recursive: true,
    });
  for (const name of ["LICENSE", "LICENSE.txt"]) {
    try {
      await cp(resolve(modules, pkg, name), resolve(pub, base, name));
    } catch {}
  }
  return "/" + base;
}
assets.tesseract = await vendor("tesseract.js", "dist", [
  "tesseract.min.js",
  "worker.min.js",
  "tesseract.min.js.LICENSE.txt",
  "worker.min.js.LICENSE.txt",
]);
const coreFiles = (await readdir(resolve(modules, "tesseract.js-core"))).filter(
  (f) => f.endsWith(".wasm") || f.endsWith(".wasm.js"),
);
assets.core = await vendor("tesseract.js-core", "", coreFiles);
assets.pdf = await vendor("pdfjs-dist", "", [
  "build",
  "wasm",
  "cmaps",
  "standard_fonts",
]);
assets.xlsx = await vendor("@e965/xlsx", "dist", ["xlsx.full.min.js"]);
assets.qr = await vendor("jsqr", "dist", ["jsQR.js"]);
assets.zip = await vendor("fflate", "esm", ["browser.js"]);
await mkdir(resolve(pub, "vendor/languages-v1"), { recursive: true });
for (const lang of ["por", "eng"])
  await cp(
    resolve(
      modules,
      `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    ),
    resolve(pub, `vendor/languages-v1/${lang}.traineddata.gz`),
  );
assets.languages = "/vendor/languages-v1";
await writeFile(
  resolve(pub, "static/cloud-assets.json"),
  JSON.stringify(assets),
);
await writeFile(
  resolve(pub, "_headers"),
  `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'\n/vendor/*\n  Cache-Control: public, max-age=31536000, immutable\n/static/*\n  Cache-Control: no-cache\n`,
);
console.log(
  "Cloudflare assets built; libraries, languages and documents use the same origin.",
);
