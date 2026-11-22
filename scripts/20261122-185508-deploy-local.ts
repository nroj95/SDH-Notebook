// =====================================================================================================
// scripts/20261122-185508-deploy-local.ts — build and install this checkout into the local Decky
// =====================================================================================================
// Personal helper for nroj95's SDH-Notebook fork on the Legion Go S (SteamOS). Not part of upstream.
// Run it ON the Go S, in a terminal:   node ~/dev/SDH-Notebook/scripts/20261122-185508-deploy-local.ts
//
// What it does, in order:
//   1. `pnpm run build` (frontend → dist/index.js).
//   2. Copies the runtime files (plugin.json, package.json, main.py, py_modules/, LICENSE, README.md,
//      dist/) over the store install in ~/homebrew/plugins/SDH-Notebook with `sudo rsync` (--delete
//      inside the copied folders keeps them exact copies). sudo: Decky keeps the plugin folder
//      root-owned; it asks for the deck password once.
//   3. Restarts Decky (`sudo systemctl restart plugin_loader`); Decky doesn't live-reload. Skip with
//      --no-restart.
// Your pages (~/homebrew/settings/SDH-Notebook/<appid>/<page>.json) are not touched.
//
// Requirements: Node 23.6+ (TypeScript stripping) and pnpm in PATH (~/.local/bin), rsync, sudo.
// Undo: the store install (v0.1.5) is backed up in ~/dev/SDH-Notebook-installed-0.1.5 — copy it back with
//   sudo rsync -a --delete ~/dev/SDH-Notebook-installed-0.1.5/ ~/homebrew/plugins/SDH-Notebook/
// =====================================================================================================

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(homedir(), "homebrew", "plugins", "SDH-Notebook");
const RUNTIME_FILES = ["plugin.json", "package.json", "main.py", "py_modules", "LICENSE", "README.md", "dist"];

const run = (cmd: string, args: string[]) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  try { execFileSync(cmd, args, { cwd: REPO, stdio: "inherit" }); }
  catch { console.error(`✗ ${cmd} failed`); process.exit(1); }
};

run("pnpm", ["run", "build"]);
run("sudo", ["rsync", "-a", "--delete", "--exclude", "__pycache__", ...RUNTIME_FILES, `${TARGET}/`]);

if (process.argv.includes("--no-restart")) {
  console.log("✓ Copied. Restart Decky yourself: sudo systemctl restart plugin_loader");
} else {
  run("sudo", ["systemctl", "restart", "plugin_loader"]);
  console.log("✓ Deployed. Log: ~/homebrew/logs/SDH-Notebook/");
}
