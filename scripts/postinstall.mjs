// Printed after `npm install`. This package is a launcher plus an agent
// definition; it bundles no runtime and npm installs none of the tools below.
// Report what is present so a missing prerequisite is obvious now rather than
// at first dispatch. Never fails the install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const onPath = (cmd) => {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
};
const version = (cmd) => {
  try { return execFileSync(cmd, ["--version"], { encoding: "utf8" }).split("\n")[0].trim(); }
  catch { return ""; }
};

const row = (present, name, hint) =>
  console.log(`  ${present ? "present" : "MISSING"}  ${name.padEnd(14)} ${hint}`);

console.log("\nclaude-code-codex-subagent: external prerequisites (npm does not install these)\n");

const hasCodex = onPath("codex");
row(hasCodex, "codex CLI", hasCodex ? version("codex") : "npm install -g @openai/codex");

const authed = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"));
row(authed, "codex auth", authed ? "" : "run: codex   (sign in once)");

const hasClaude = onPath("claude");
row(hasClaude, "Claude Code", hasClaude ? version("claude") : "https://claude.com/claude-code");

console.log("\n  Next:  codex-subagent install     (writes the agent, then restart Claude Code)");
console.log("  Check: codex-subagent check       (re-run this report at any time)\n");
