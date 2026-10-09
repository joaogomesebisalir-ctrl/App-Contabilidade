// Password hashing stays out of the Workers Free CPU budget. No document data is sent here.
import { scrypt, pbkdf2, timingSafeEqual, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
const deriveScrypt = promisify(scrypt);
const derivePbkdf = promisify(pbkdf2);
Deno.serve(async (request: Request) => {
  const authorization = request.headers.get("authorization") || "";
  const backendKey = Deno.env.get("CONTA_BACKEND_KEY");
  if (!backendKey) return new Response("Unavailable", { status: 503 });
  const expected = "Bearer " + backendKey;
  if (
    Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
  )
    return new Response("Forbidden", { status: 403 });
  try {
    const d = await request.json();
    if (
      typeof d.password !== "string" ||
      d.password.length > 256 ||
      !["hash", "verify"].includes(d.operation)
    )
      throw Error("Invalid");
    if (d.operation === "hash") {
      if (d.password.length < 12) throw Error("Invalid");
      const salt = randomBytes(16).toString("hex");
      const key = await deriveScrypt(d.password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      return Response.json({
        hash: `scrypt:32768:8:1$${salt}$${Buffer.from(key).toString("hex")}`,
      });
    }
    if (typeof d.hash !== "string" || d.hash.length > 1024)
      throw Error("Invalid");
    const [method, salt, stored] = d.hash.split("$");
    let key: Buffer;
    if (method.startsWith("scrypt:")) {
      const [, n, r, p] = method.split(":").map(Number);
      if (n !== 32768 || r !== 8 || p !== 1) throw Error("Unsupported");
      key = Buffer.from(
        await deriveScrypt(d.password, salt, 64, {
          N: n,
          r,
          p,
          maxmem: 64 * 1024 * 1024,
        }),
      );
    } else if (method.startsWith("pbkdf2:sha256:")) {
      const iterations = Number(method.split(":")[2]);
      if (
        !Number.isInteger(iterations) ||
        iterations < 100000 ||
        iterations > 2000000
      )
        throw Error("Unsupported");
      key = Buffer.from(
        await derivePbkdf(d.password, salt, iterations, 32, "sha256"),
      );
    } else throw Error("Unsupported");
    const target = Buffer.from(stored, "hex");
    return Response.json({
      valid: target.length === key.length && timingSafeEqual(target, key),
    });
  } catch {
    return Response.json({ error: "Pedido inválido." }, { status: 400 });
  }
});
