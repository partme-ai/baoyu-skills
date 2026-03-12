import fs from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "json5",
  "yaml",
  "yml",
  "toml",
  "js",
  "cjs",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "rb",
  "go",
  "rs",
  "swift",
  "kt",
  "java",
  "cs",
  "cpp",
  "c",
  "h",
  "hpp",
  "sql",
  "csv",
  "ini",
  "cfg",
  "env",
  "xml",
  "html",
  "css",
  "scss",
  "sass",
  "svg",
]);

const PACKAGE_DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

export async function listTextFiles(root) {
  const files = [];

  async function walk(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      if (entry.name === ".clawhub" || entry.name === ".clawdhub") continue;

      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const bytes = await fs.readFile(fullPath);
      files.push({ relPath, bytes });
    }
  }

  await walk(root);
  files.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return files;
}

export async function collectReleaseFiles(root) {
  const baseFiles = await listTextFiles(root);
  const fileMap = new Map(baseFiles.map((file) => [file.relPath, file.bytes]));
  const vendoredPackages = new Set();

  for (const file of baseFiles.filter((entry) => path.posix.basename(entry.relPath) === "package.json")) {
    const packageDirRel = normalizeDirRel(path.posix.dirname(file.relPath));
    const rewritten = await rewritePackageJsonForRelease({
      root,
      packageDirRel,
      bytes: file.bytes,
      fileMap,
      vendoredPackages,
    });
    if (rewritten) {
      fileMap.set(file.relPath, rewritten);
    }
  }

  return [...fileMap.entries()]
    .map(([relPath, bytes]) => ({ relPath, bytes }))
    .sort((left, right) => left.relPath.localeCompare(right.relPath));
}

export async function materializeReleaseFiles(files, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  for (const file of files) {
    const outputPath = path.join(outDir, fromPosixRel(file.relPath));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, file.bytes);
  }
}

async function rewritePackageJsonForRelease({ root, packageDirRel, bytes, fileMap, vendoredPackages }) {
  const packageJson = JSON.parse(bytes.toString("utf8"));
  let changed = false;

  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object") continue;

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;

      const sourceDir = path.resolve(root, fromPosixRel(packageDirRel), spec.slice(5));
      const vendorDirRel = normalizeDirRel(path.posix.join(packageDirRel, "vendor", name));
      await vendorPackageTree({
        sourceDir,
        targetDirRel: vendorDirRel,
        fileMap,
        vendoredPackages,
      });
      dependencies[name] = toFileDependencySpec(packageDirRel, vendorDirRel);
      changed = true;
    }
  }

  if (!changed) return null;
  return Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);
}

async function vendorPackageTree({ sourceDir, targetDirRel, fileMap, vendoredPackages }) {
  const dedupeKey = `${path.resolve(sourceDir)}=>${targetDirRel}`;
  if (vendoredPackages.has(dedupeKey)) return;
  vendoredPackages.add(dedupeKey);

  const files = await listTextFiles(sourceDir);
  if (files.length === 0) {
    throw new Error(`Local package has no text files: ${sourceDir}`);
  }

  const packageJson = files.find((file) => file.relPath === "package.json");
  if (!packageJson) {
    throw new Error(`Local package is missing package.json: ${sourceDir}`);
  }

  for (const file of files) {
    if (file.relPath === "package.json") continue;
    fileMap.set(joinReleasePath(targetDirRel, file.relPath), file.bytes);
  }

  const rewrittenPackageJson = await rewritePackageJsonForRelease({
    root: sourceDir,
    packageDirRel: ".",
    bytes: packageJson.bytes,
    fileMap: {
      set(relPath, outputBytes) {
        fileMap.set(joinReleasePath(targetDirRel, relPath), outputBytes);
      },
    },
    vendoredPackages,
  });

  fileMap.set(
    joinReleasePath(targetDirRel, "package.json"),
    rewrittenPackageJson ?? packageJson.bytes,
  );
}

function normalizeDirRel(relPath) {
  return relPath === "." ? "." : relPath.split(path.sep).join("/");
}

function fromPosixRel(relPath) {
  return relPath === "." ? "." : relPath.split("/").join(path.sep);
}

function joinReleasePath(base, relPath) {
  const joined = normalizeDirRel(path.posix.join(base === "." ? "" : base, relPath));
  return joined.replace(/^\.\//, "");
}

function toFileDependencySpec(fromDirRel, targetDirRel) {
  const fromDir = fromDirRel === "." ? "" : fromDirRel;
  const relative = path.posix.relative(fromDir || ".", targetDirRel);
  const normalized = relative === "" ? "." : relative;
  return `file:${normalized.startsWith(".") ? normalized : `./${normalized}`}`;
}
