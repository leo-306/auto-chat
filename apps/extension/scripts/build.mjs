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

for (const file of ["popup.html", "popup.css"]) {
  fs.copyFileSync(path.join(root, "src", file), path.join(dist, file));
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "manifest.json"), "utf8"));
manifest.version = readRootVersionAsManifestVersion(root);
fs.writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

function readRootVersionAsManifestVersion(extensionRoot) {
  const rootPackagePath = path.join(extensionRoot, "..", "..", "package.json");
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  // Chrome manifest versions allow only up to four dot-separated integers, so strip
  // any prerelease suffix (e.g. "0.1.19-test" -> "0.1.19").
  return String(rootPackage.version).split("-")[0];
}

fs.cpSync(path.join(root, "src", "icons"), path.join(dist, "icons"), { recursive: true });
