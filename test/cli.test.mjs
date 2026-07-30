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

// The wrapper agent's Claude context, and then its caller's, pay for anything
// `wait` prints. An answer inlined here is billed to Claude roughly three times
// for work that was meant to run on Codex's side, so the default has to stay
// bounded no matter how much Codex wrote.
//
// The 50 kB payload below is load-bearing, not arbitrary. Node's stdout is
// asynchronous when it is a pipe on macOS, so a payload large enough to still
// be buffered at exit caught a truncation bug that every other platform hid.
// Shrinking it would drop that coverage silently.
test("answer output policy", async (t) => {
  const BIG = "x".repeat(50_000);

  await t.test("a large answer is previewed, not dumped", () => {
    const dir = mkRun("big", { exit: "0", "answer.md": BIG });
    const r = cli(["wait", dir, "--timeout-sec", "1"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.length < 4000, `wait emitted ${r.out.length} bytes for a 50 kB answer`);
    assert.match(r.out, /first 1200 of 50000 bytes/);
    assert.match(r.out, /answer\.md/, "the path to the full answer must survive");
  });

  await t.test("the preview never cuts a line in half", () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
    const dir = mkRun("lines", { exit: "0", "answer.md": body });
    const r = cli(["wait", dir, "--timeout-sec", "1"]);
    const preview = r.out.split(/--- answer, first \d+ of \d+ bytes ---\n/)[1].split("\n[...truncated")[0];
    const whole = new Set(body.split("\n"));
    for (const line of preview.split("\n")) assert.ok(whole.has(line), `partial line: ${line}`);
  });

  await t.test("an answer smaller than the preview budget is shown whole", () => {
    const dir = mkRun("small", { exit: "0", "answer.md": "short and complete\n" });
    const r = cli(["wait", dir, "--timeout-sec", "1"]);
    assert.match(r.out, /--- answer ---/);
    assert.ok(!r.out.includes("truncated"), "a whole answer must not claim truncation");
  });

  await t.test("--answer none prints no answer body at all", () => {
    const dir = mkRun("quiet", { exit: "0", "answer.md": BIG });
    const r = cli(["wait", dir, "--timeout-sec", "1", "--answer", "none"]);
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes("--- answer"), "answer body leaked with --answer none");
    assert.match(r.out, /\(50000 bytes\)/, "the size must still be reported");
  });

  await t.test("--answer full is the opt-in that inlines everything", () => {
    const dir = mkRun("loud", { exit: "0", "answer.md": BIG });
    const r = cli(["wait", dir, "--timeout-sec", "1", "--answer", "full"]);
    assert.ok(r.out.includes(BIG), "--answer full did not emit the whole answer");
  });

  await t.test("--preview-bytes resizes the preview", () => {
    const dir = mkRun("sized", { exit: "0", "answer.md": BIG });
    assert.match(cli(["wait", dir, "--timeout-sec", "1", "--preview-bytes", "100"]).out,
                 /first 100 of 50000 bytes/);
  });

  await t.test("the preview budget is bytes, not characters", () => {
    const dir = mkRun("utf8", { exit: "0", "answer.md": "€".repeat(5000) });
    const r = cli(["wait", dir, "--timeout-sec", "1", "--preview-bytes", "200"]);
    const preview = r.out.split(/--- answer, first \d+ of \d+ bytes ---\n/)[1].split("\n[...truncated")[0];
    assert.ok(Buffer.byteLength(preview) <= 200,
              `3-byte characters overshot the budget: ${Buffer.byteLength(preview)} bytes`);
    assert.ok(!preview.includes("�"), "the cut landed mid-codepoint and left a replacement char");
  });

  await t.test("an invalid answer mode is rejected", () => {
    const dir = mkRun("badmode", { exit: "0", "answer.md": "x" });
    const r = cli(["wait", dir, "--timeout-sec", "1", "--answer", "everything"]);
    assert.equal(r.code, 64);
    assert.match(r.out, /--answer must be none, preview, or full/);
  });

  await t.test("the answer subcommand prints the whole file", () => {
    const dir = mkRun("fetch", { exit: "0", "answer.md": BIG });
    const r = cli(["answer", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.out, BIG);
  });

  await t.test("asking for an answer before the run finishes fails clearly", () => {
    const r = cli(["answer", mkRun("pending", { pid: String(process.pid) })]);
    assert.equal(r.code, 64);
    assert.match(r.out, /has not finished/);
  });
});

test("install lifecycle", async (t) => {
  await t.test("install writes the agent with paths substituted", () => {
    assert.equal(cli(["install"]).code, 0);
    const body = fs.readFileSync(agentPath(), "utf8");
    assert.match(body, /installed-by: claude-code-codex-subagent/);
    assert.ok(!body.includes("CLAUDE_PLUGIN_ROOT"), "plugin-root token survived");
    const rootForShell = ROOT.split(path.sep).join("/");
    assert.ok(body.includes(`${rootForShell}/bin/codex-subagent`), "launcher path not baked in");
    assert.ok(!/[A-Za-z]:\\[^\n]*\//.test(body), "rendered agent mixes path separators");
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

// Same, but edits the working root so the blast-radius report has something to
// find: one new untracked file and one modification to a tracked file.
const STUB_WRITES = `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const cd = args[args.indexOf("-C") + 1];
fs.writeFileSync(path.join(cd, "new-file.txt"), "made by codex\\n");
fs.appendFileSync(path.join(cd, "tracked.txt"), "changed\\n");
const outIdx = args.findIndex((a) => a === "-o");
if (outIdx !== -1) fs.writeFileSync(args[outIdx + 1], "STUB ANSWER");
process.exit(0);
`;

const hasGit = () => spawnSync("git", ["--version"]).status === 0;

function gitRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return dir;
}

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

    const recorded = fs.readFileSync(path.join(runDir, "prompt.txt"), "utf8");
    assert.match(recorded, /^remember this prompt\n/);
    assert.match(recorded, /<action_safety>/, "guardrails not appended");
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

  await t.test("guardrails are appended by the launcher, not the caller", () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", TMP, "--sandbox", "read-only"], { stdin: "task text", env });
    const runDir = started.out.trim().split("\n").pop();
    const recorded = fs.readFileSync(path.join(runDir, "prompt.txt"), "utf8");
    for (const block of ["action_safety", "missing_context_gating", "sandbox_fallback",
                         "verification_loop", "reporting"]) {
      assert.match(recorded, new RegExp(`<${block}>`), `${block} guardrail missing`);
    }
  });

  await t.test("--no-guardrails leaves the prompt exactly as given", () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", TMP, "--sandbox", "read-only", "--no-guardrails"],
                        { stdin: "task text", env });
    const runDir = started.out.trim().split("\n").pop();
    assert.equal(fs.readFileSync(path.join(runDir, "prompt.txt"), "utf8"), "task text");
  });

  await t.test("run routes wait options through to the wait", () => {
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const r = cli(["run", "--workdir", TMP, "--sandbox", "read-only",
                   "--timeout-sec", "20", "--answer", "none"], { stdin: "x", env });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes("STUB ANSWER"), "run ignored --answer");
  });

  await t.test("the summary reports which files the run changed", { skip: !hasGit() }, () => {
    const repo = gitRepo("blast");
    const bin = stubCodex(STUB_WRITES);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", repo], { stdin: "write things", env });
    const runDir = started.out.trim().split("\n").pop();
    const r = cli(["wait", runDir, "--timeout-sec", "20"], { env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /changed:\s+2 paths/);
    assert.match(r.out, /new-file\.txt/);
    assert.match(r.out, /tracked\.txt/);
  });

  await t.test("a run that touches nothing says so", { skip: !hasGit() }, () => {
    const repo = gitRepo("untouched");
    const bin = stubCodex(STUB_OK);
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const started = cli(["start", "--workdir", repo, "--sandbox", "read-only"], { stdin: "look only", env });
    const runDir = started.out.trim().split("\n").pop();
    assert.match(cli(["wait", runDir, "--timeout-sec", "20"], { env }).out, /changed:\s+nothing/);
  });

  // A run killed halfway may still have edited files, which is exactly when the
  // caller most needs to know which ones.
  await t.test("a run that died still reports what it changed", { skip: !hasGit() }, () => {
    const repo = gitRepo("died");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const dir = mkRun("died-run", {
      pid: "999999",
      "git-before.json": JSON.stringify({ root: repo, head, status: "" }),
    });
    fs.writeFileSync(path.join(repo, "half-written.ts"), "incomplete\n");
    const r = cli(["wait", dir, "--timeout-sec", "5"]);
    assert.equal(r.code, 70);
    assert.match(r.out, /RUN DIED/);
    assert.match(r.out, /half-written\.ts/, "a died run hid its blast radius");
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
