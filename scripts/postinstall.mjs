// Runs after `npm install`. Reports external prerequisites (this package
// bundles no runtime and npm installs none of them), then installs the agent
// into Claude Code when doing that unattended is safe.
//
// Never fails the npm install. Anything it declines to do is printed together
// with the command to do it by hand.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "codex-subagent");
const MARKER = "installed-by: claude-code-codex-subagent";

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
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").split("\n")[0].trim() : "";
};
const row = (present, name, hint) =>
  console.log(`  ${present ? "present" : "MISSING"}  ${name.padEnd(14)} ${hint}`);

console.log("\nclaude-code-codex-subagent\n");
console.log("External prerequisites (npm does not install these):\n");

const hasCodex = onPath("codex");
row(hasCodex, "codex CLI", hasCodex ? version("codex") : "npm install -g @openai/codex");

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const authed = fs.existsSync(path.join(codexHome, "auth.json"));
row(authed, "codex auth", authed ? "" : "run: codex   (sign in once)");

const hasClaude = onPath("claude");
row(hasClaude, "Claude Code", hasClaude ? version("claude") : "https://claude.com/claude-code");

// ---- install the agent, when doing so unattended is safe --------------------
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const target = path.join(claudeDir, "agents", "codex.md");

const manual = (why, extra) => {
  console.log(`\nAgent not installed automatically: ${why}`);
  if (extra) console.log(`  ${extra}`);
  console.log("  Run when ready:  codex-subagent install\n");
};

// Under sudo, HOME is usually root's rather than the invoking user's, so an
// automatic install would write the agent into the wrong home directory.
const sudo = typeof process.getuid === "function" && process.getuid() === 0 && process.env.SUDO_USER;
const foreign = fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(MARKER);

console.log("");
if (sudo) {
  manual("running under sudo, and the agent belongs in your own home directory");
} else if (!fs.existsSync(claudeDir)) {
  manual(`no Claude Code config found at ${claudeDir}`);
} else if (foreign) {
  manual(`${target} exists and was not created by this package`,
         "`codex-subagent install --force` backs it up first");
} else {
  const r = spawnSync(process.execPath, [CLI, "install"], { encoding: "utf8" });
  if (r.status === 0) {
    console.log(`Agent installed at ${target}`);
    console.log("\n  Restart Claude Code, then dispatch with:");
    console.log('    Agent(subagent_type: "codex", prompt: "...")\n');
  } else {
    manual("the install step reported a problem");
    if (r.stderr) console.log(r.stderr.trim().split("\n").map((l) => "  " + l).join("\n") + "\n");
  }
}

console.log("  codex-subagent check     re-run the prerequisite report");
console.log("  codex-subagent status    what is installed and whether it works\n");
