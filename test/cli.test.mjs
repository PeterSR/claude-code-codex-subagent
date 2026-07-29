// Regression tests. No network and no Codex CLI required: every case here
// exercises argument handling, the run-state machine, or the install lifecycle.
//
//   node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "codex-subagent");

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-test-")); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// Run the CLI with a private cache and Claude config so tests never touch the
// developer's real installation.
function cli(args, { stdin = "", env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(TMP, "claude"),
      XDG_CACHE_HOME: path.join(TMP, "cache"),
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const agentPath = () => path.join(TMP, "claude", "agents", "codex.md");
const mkRun = (name, files = {}) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), v);
  return dir;
};

test("argument validation", async (t) => {
  await t.test("a trailing flag with no value exits 64, it used to loop forever", () => {
    assert.equal(cli(["wait", TMP, "--timeout-sec"]).code, 64);
  });
  await t.test("non-numeric timeout is rejected", () => {
    assert.equal(cli(["wait", TMP, "--timeout-sec", "abc"]).code, 64);
  });
  await t.test("an option is not swallowed as another option's value", () => {
    assert.equal(cli(["start", "--resume", "--last"], { stdin: "x" }).code, 64);
  });
  await t.test("a missing value exits 64", () => {
    assert.equal(cli(["start", "--model"], { stdin: "x" }).code, 64);
  });
  await t.test("an invalid sandbox is rejected for the right reason", () => {
    const r = cli(["start", "--sandbox", "nonsense"], { stdin: "x" });
    assert.equal(r.code, 64);
    assert.match(r.out, /invalid --sandbox/, "argument errors must not be masked by environment checks");
  });
  await t.test("an unknown subcommand is rejected", () => {
    assert.equal(cli(["bogus"]).code, 64);
  });
  await t.test("a missing prompt file is rejected for the right reason", () => {
    const r = cli(["start", "--prompt-file", path.join(TMP, "nope.txt")]);
    assert.equal(r.code, 64);
    assert.match(r.out, /--prompt-file not found/);
  });
});

test("run state machine", async (t) => {
  await t.test("a run that died without a marker exits 70 and says so", () => {
    const dir = mkRun("dead", { pid: "999999" });
    const r = cli(["wait", dir, "--timeout-sec", "5"]);
    assert.equal(r.code, 70);
    assert.match(r.out, /RUN DIED/);
  });

  await t.test("a live but unfinished run exits 75 without overshooting the timeout", () => {
    const dir = mkRun("live", { pid: String(process.pid) }); // this process is alive
    const started = Date.now();
    const r = cli(["wait", dir, "--timeout-sec", "2"]);
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(r.code, 75);
    assert.match(r.out, /NOT FINISHED/);
    assert.ok(elapsed < 5, `waited ${elapsed}s for --timeout-sec 2`);
  });

  await t.test("the retry hint quotes a path containing spaces", () => {
    const dir = mkRun("with space", { pid: String(process.pid) });
    const r = cli(["wait", dir, "--timeout-sec", "1"]);
    const line = r.out.split("\n").find((l) => l.includes("Call again")) || "";
    assert.match(line, /"/, `unquoted path in: ${line}`);
  });

  await t.test("a finished run returns its exit code and prints the answer", () => {
    const dir = mkRun("done", { exit: "0", "answer.md": "hello world\n" });
    const r = cli(["wait", dir, "--timeout-sec", "1"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /hello world/);
  });

  await t.test("a nonzero Codex exit is passed through", () => {
    const dir = mkRun("failed", { exit: "3", "stderr.txt": "boom\n" });
    assert.equal(cli(["wait", dir, "--timeout-sec", "1"]).code, 3);
  });

  await t.test("the thread id is read out of the event stream", () => {
    const dir = mkRun("threaded", {
      exit: "0",
      "events.jsonl": '{"type":"thread.started","thread_id":"abc-123"}\n',
      "answer.md": "x",
    });
    assert.match(cli(["wait", dir, "--timeout-sec", "1"]).out, /thread_id: abc-123/);
  });

  await t.test("a whitespace-formatted thread id is still matched", () => {
    const dir = mkRun("threaded2", {
      exit: "0",
      "events.jsonl": '{"type": "thread.started", "thread_id": "spaced-9"}\n',
      "answer.md": "x",
    });
    assert.match(cli(["wait", dir, "--timeout-sec", "1"]).out, /thread_id: spaced-9/);
  });

  await t.test("reusing a run directory is refused for the right reason", () => {
    const dir = mkRun("reuse", { exit: "0" });
    const r = cli(["start", "--run-dir", dir], { stdin: "x" });
    assert.equal(r.code, 64);
    assert.match(r.out, /run dir already used/);
  });
});

test("install lifecycle", async (t) => {
  await t.test("install writes the agent with paths substituted", () => {
    assert.equal(cli(["install"]).code, 0);
    const body = fs.readFileSync(agentPath(), "utf8");
    assert.match(body, /installed-by: claude-code-codex-subagent/);
    assert.ok(!body.includes("CLAUDE_PLUGIN_ROOT"), "plugin-root token survived");
    assert.ok(body.includes(path.join(ROOT, "bin", "codex-subagent")), "launcher path not baked in");
  });

  await t.test("reinstall is idempotent", () => {
    assert.equal(cli(["install"]).code, 0);
    const markers = fs.readFileSync(agentPath(), "utf8").split("installed-by").length - 1;
    assert.equal(markers, 1);
  });

  await t.test("status reports a healthy install", () => {
    const r = cli(["status"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /installed from this copy/);
  });

  await t.test("a foreign agent is neither clobbered nor deleted", () => {
    fs.writeFileSync(agentPath(), "hand written\n");
    assert.equal(cli(["install"]).code, 64);
    assert.equal(cli(["uninstall"]).code, 64);
    assert.match(fs.readFileSync(agentPath(), "utf8"), /hand written/);
  });

  await t.test("--force installs over it after backing it up", () => {
    assert.equal(cli(["install", "--force"]).code, 0);
    const backups = fs.readdirSync(path.dirname(agentPath())).filter((f) => f.includes(".bak."));
    assert.ok(backups.length > 0, "no backup was written");
  });

  await t.test("uninstall removes its own agent and is idempotent", () => {
    assert.equal(cli(["uninstall"]).code, 0);
    assert.ok(!fs.existsSync(agentPath()));
    assert.match(cli(["uninstall"]).out, /nothing to remove/i);
  });

  await t.test("purge refuses to run unattended without --yes", () => {
    cli(["install"]);
    const runs = path.join(TMP, "cache", "codex-subagent", "some-run");
    fs.mkdirSync(runs, { recursive: true });
    const r = cli(["purge"]);            // no TTY in a spawned test
    assert.equal(r.code, 64);
    assert.match(r.out, /Refusing to purge/);
    assert.ok(fs.existsSync(runs), "purge deleted without confirmation");
  });

  await t.test("purge --dry-run itemises without deleting", () => {
    const runs = path.join(TMP, "cache", "codex-subagent", "some-run");
    const r = cli(["purge", "--dry-run"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /This will delete:/);
    assert.match(r.out, /run director/);
    assert.match(r.out, /Dry run, nothing was deleted/);
    assert.ok(fs.existsSync(runs), "dry run deleted something");
    assert.ok(fs.existsSync(agentPath()), "dry run removed the agent");
  });

  await t.test("purge --yes removes the agent and run directories", () => {
    const runs = path.join(TMP, "cache", "codex-subagent", "some-run");
    assert.equal(cli(["purge", "--yes"]).code, 0);
    assert.ok(!fs.existsSync(runs), "run directory survived purge");
    assert.ok(!fs.existsSync(agentPath()), "agent survived purge");
  });
});

// A stub `codex` on PATH lets the whole start/supervise/wait path run for real
// without a network call or an API key. On Windows this is what catches a
// launcher that cannot execute the .cmd shim npm installs.
function stubCodex(behaviour) {
  const dir = fs.mkdtempSync(path.join(TMP, "stub-"));
  const js = path.join(dir, "stub.mjs");
  fs.writeFileSync(js, behaviour);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "codex.cmd"), `@echo off\r\nnode "${js}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

// Emits one thread.started event, writes the answer to the -o path, exits 0.
const STUB_OK = `
import fs from "node:fs";
const args = process.argv.slice(2);
const outIdx = args.findIndex((a) => a === "-o");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread-1" }) + "\\n");
if (outIdx !== -1) fs.writeFileSync(args[outIdx + 1], "STUB ANSWER");
process.exit(0);
`;

test("end to end with a stub codex", async (t) => {
  await t.test("start, supervise, and wait complete a real run", async () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", TMP, "--sandbox", "read-only"], { stdin: "do a thing", env });
    assert.equal(started.code, 0, started.out);
    const runDir = started.out.trim().split("\n").pop();

    const waited = cli(["wait", runDir, "--timeout-sec", "20"], { env });
    assert.equal(waited.code, 0, waited.out);
    assert.match(waited.out, /STUB ANSWER/);
    assert.match(waited.out, /thread_id: stub-thread-1/);
    assert.match(waited.out, /finished \(exit 0\)/);
  });

  await t.test("the prompt and resolved command are recorded", () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", TMP, "--sandbox", "read-only",
                         "--model", "some-model", "--effort", "low", "--no-network"],
                        { stdin: "remember this prompt", env });
    const runDir = started.out.trim().split("\n").pop();
    cli(["wait", runDir, "--timeout-sec", "20"], { env });

    assert.equal(fs.readFileSync(path.join(runDir, "prompt.txt"), "utf8"), "remember this prompt");
    const { cmd, args } = JSON.parse(fs.readFileSync(path.join(runDir, "command.json"), "utf8"));
    assert.ok(cmd.includes("codex"), `resolved command looks wrong: ${cmd}`);
    assert.deepEqual(args.slice(0, 4), ["exec", "-s", "read-only", "-C"]);
    assert.ok(args.includes("some-model"), "model not passed through");
    assert.ok(args.includes("model_reasoning_effort=low"), "effort not passed through");
    assert.ok(!args.some((a) => a.includes("network_access")), "network flag set for read-only");
  });

  await t.test("resume passes the sandbox via -c and omits -C", () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--resume", "thread-xyz", "--sandbox", "workspace-write"],
                        { stdin: "continue", env });
    const runDir = started.out.trim().split("\n").pop();
    const { args } = JSON.parse(fs.readFileSync(path.join(runDir, "command.json"), "utf8"));
    assert.deepEqual(args.slice(0, 5), ["exec", "resume", "thread-xyz", "-c", "sandbox_mode=workspace-write"]);
    assert.ok(!args.includes("-C"), "resume must not pass a working directory");
    assert.ok(args.includes("sandbox_workspace_write.network_access=true"), "network default lost");
  });

  await t.test("a nonzero codex exit is surfaced with its stderr", () => {
    const bin = stubCodex(`
      import fs from "node:fs";
      process.stderr.write("stub exploded\\n");
      process.exit(7);
    `);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", TMP, "--sandbox", "read-only"], { stdin: "x", env });
    const runDir = started.out.trim().split("\n").pop();
    const waited = cli(["wait", runDir, "--timeout-sec", "20"], { env });
    assert.equal(waited.code, 7);
    assert.match(waited.out, /stub exploded/);
  });
});

test("packaging", async (t) => {
  await t.test("the agent template still carries its substitution token", () => {
    assert.match(fs.readFileSync(path.join(ROOT, "agents", "codex.md"), "utf8"), /CLAUDE_PLUGIN_ROOT/);
  });
  await t.test("no shell heredocs remain in the agent instructions", () => {
    assert.ok(!fs.readFileSync(path.join(ROOT, "agents", "codex.md"), "utf8").includes("<<'"));
  });
  await t.test("bundled schemas are valid JSON", () => {
    const dir = path.join(ROOT, "schemas");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    }
  });
  await t.test("no developer-specific absolute paths are shipped", () => {
    for (const rel of ["bin/codex-subagent", "agents/codex.md", "scripts/postinstall.mjs"]) {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!/\/home\/[a-z]|\/Users\/[a-z]/.test(body), `absolute home path in ${rel}`);
    }
  });
  await t.test("--help succeeds", () => {
    assert.equal(execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).includes("Exit codes"), true);
  });
});
