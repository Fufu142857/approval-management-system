import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle only pinned public library resources, never user-uploaded PDF documents.
const source = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
);
const { version } = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
const target = join("public/vendor/pdfjs", version);
await mkdir(target, { recursive: true });
await cp(
  join(source, "build/pdf.worker.min.mjs"),
  join(target, "pdf.worker.min.mjs"),
);
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(join(source, directory), join(target, directory), {
    recursive: true,
  });
}
await cp(join(source, "LICENSE"), join(target, "LICENSE"));
