#!/usr/bin/env node

import path from "node:path";

import { collectReleaseFiles, materializeReleaseFiles } from "./lib/skill-artifact.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skillDir || !options.outDir) {
    throw new Error("--skill-dir and --out-dir are required");
  }

  const skillDir = path.resolve(options.skillDir);
  const outDir = path.resolve(options.outDir);
  const files = await collectReleaseFiles(skillDir);
  await materializeReleaseFiles(files, outDir);

  console.log(`Prepared artifact for ${path.basename(skillDir)}`);
  console.log(`Source: ${skillDir}`);
  console.log(`Output: ${outDir}`);
  console.log(`Files: ${files.length}`);
}

function parseArgs(argv) {
  const options = {
    skillDir: "",
    outDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skill-dir") {
      options.skillDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      options.outDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log(`Usage: prepare-skill-artifact.mjs --skill-dir <dir> --out-dir <dir>

Options:
  --skill-dir <dir>   Source skill directory
  --out-dir <dir>     Artifact output directory
  -h, --help          Show help`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
