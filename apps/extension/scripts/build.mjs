import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const entry of ["background", "content", "popup"]) {
  await esbuild.build({
    entryPoints: [path.join(root, "src", `${entry}.ts`)],
    outfile: path.join(dist, `${entry}.js`),
    bundle: true,
    format: "iife",
    target: "chrome120",
    sourcemap: true
  });
}

for (const file of ["manifest.json", "popup.html", "popup.css"]) {
  fs.copyFileSync(path.join(root, "src", file), path.join(dist, file));
}
