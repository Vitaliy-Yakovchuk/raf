import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileAgentChannelNativePolicy,
  runAgentChannelNativeProbe,
} from "../src/main-switch-agent-channel.ts";
import type { AgentNativePolicyInput } from "../src/main-switch-agent-channel.ts";

async function nativeFixture() {
  const base = await fs.mkdtemp(path.join(tmpdir(), "raf-channel-"));
  const A = path.join(base, "raf-main-a");
  const B = path.join(base, "raf-main-b");
  const logical = path.join(base, "raf-main");
  const work = path.join(base, "raf-develop");
  const hotfix = path.join(base, "raf-hotfix");
  const run = path.join(base, "own-run");
  const state = path.join(base, "host-state");
  const metadata = [
    ".gitmodules", ".git/index", ".git/refs/heads/main",
    ".git/modules/raf/index", ".git/modules/raf/refs/heads/main",
    ".git/modules/raf/worktrees/main-a/index", ".git/modules/raf/worktrees/main-b/index",
    ".git/modules/raf/activation/intent.json",
  ].map(file => path.join(base, file));
  const code = [path.join(A, "bin/raf.ts"), path.join(B, "bin/raf.ts")];
  const hidden = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "bugs.sqlite", "secrets.json"]
    .map(file => path.join(state, file));
  const aliases = path.join(work, "aliases");
  const protectedFiles = [...code, ...metadata, ...hidden];
  const servers: ReturnType<typeof createServer>[] = [];
  let connections = 0;
  try {
    for (const dir of [A, B, work, hotfix, run, state, aliases]) await fs.mkdir(dir, { recursive: true });
    for (const file of protectedFiles) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `host-sentinel:${path.relative(base, file)}\n`);
    }
    await fs.symlink(A, logical);
    await fs.symlink(path.join(base, ".git"), path.join(aliases, "git"));
    await fs.symlink(A, path.join(aliases, "slot-a"));
    await fs.symlink(B, path.join(aliases, "slot-b"));
    await fs.symlink(state, path.join(aliases, "state"));
    const sockets = [path.join(base, "host-main.sock"), path.join(work, "peer.sock"), path.join(run, "host.sock")];
    for (const socket of sockets) {
      const server = createServer(client => { connections += 1; client.end("host-alive"); });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
    }
    for (const [index, socket] of sockets.entries()) await fs.symlink(socket, path.join(aliases, `socket-${index}`));
    const input: AgentNativePolicyInput = {
      mainCopies: [A, B], logicalMain: logical,
      activationMetadata: metadata,
      writableRoots: [base, work, run],
      exactWritableFiles: [],
      denyReadPaths: [...hidden],
      denyConnectPaths: sockets,
      issuedCommandPrefixes: [`node ${A}/bin/raf.ts agent message`, `node ${A}/bin/raf.ts agent ps`],
    };
    async function fingerprint() {
      const hash = createHash("sha256");
      for (const file of protectedFiles) {
        hash.update(file);
        hash.update(await fs.readFile(file));
      }
      hash.update(await fs.readlink(logical));
      return hash.digest("hex");
    }
    async function hostControl(): Promise<void> {
      for (const socket of sockets) {
        const response = await new Promise<string>((resolve, reject) => {
          const client = createConnection(socket);
          let data = "";
          client.setTimeout(5000, () => client.destroy(new Error("fixture host socket timed out")));
          client.on("data", chunk => { data += chunk.toString(); });
          client.on("error", reject);
          client.on("end", () => resolve(data));
        });
        assert.equal(response, "host-alive");
      }
    }
    async function policy() {
      return compileAgentChannelNativePolicy(input, { async canonicalPath(file) { return fs.realpath(file); } });
    }
    async function probe(script: string, args: string[] = [], childShell = false) {
      const argv = ["--input-type=module", "-e", script, ...args];
      return runAgentChannelNativeProbe({
        policy: await policy(),
        executable: childShell ? "/bin/sh" : process.execPath,
        argv: childShell ? ["-c", 'exec "$@"', "native-child", process.execPath, ...argv] : argv,
        cwd: work,
        env: { HOME: work, TMPDIR: run, PATH: path.dirname(process.execPath), TMUX: "", TMUX_PANE: "" },
      });
    }
    async function close(): Promise<void> {
      await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
      await fs.rm(base, { recursive: true, force: true });
    }
    return { base, A, B, logical, work, hotfix, run, metadata, hidden, code, aliases, sockets, fingerprint, hostControl, probe, close, connectionCount: () => connections };
  } catch (error) {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await fs.rm(base, { recursive: true, force: true });
    throw error;
  }
}

async function positiveControl(f: Awaited<ReturnType<typeof nativeFixture>>): Promise<void> {
  await f.hostControl();
  const file = path.join(f.work, "own-write.txt");
  const output = await f.probe("import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'allowed');process.stdout.write('native-ready');", [file]);
  assert.equal(output.exitCode, 0, Buffer.from(output.stderr).toString());
  assert.equal(Buffer.from(output.stdout).toString(), "native-ready");
  assert.equal(await fs.readFile(file, "utf8"), "allowed");
  const hotfixFile = path.join(f.hotfix, "own-hotfix.txt");
  const hotfix = await f.probe("import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'hotfix-allowed');", [hotfixFile]);
  assert.equal(hotfix.exitCode, 0, Buffer.from(hotfix.stderr).toString());
  assert.equal(await fs.readFile(hotfixFile, "utf8"), "hotfix-allowed");
}

test("native write-deny protects both copies, symlink and Git metadata despite broad parent write grants", async () => {
  const f = await nativeFixture();
  try {
    await positiveControl(f);
    const before = await f.fingerprint();
    const targets = [
      ...f.code, ...f.metadata, path.join(f.logical, "bin/raf.ts"),
      path.join(f.aliases, "slot-a/bin/raf.ts"), path.join(f.aliases, "slot-b/bin/raf.ts"),
      path.join(f.aliases, "git/index"),
    ];
    for (const target of targets) {
      for (const childShell of [false, true]) {
        const result = await f.probe("import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'tampered');", [target], childShell);
        assert.notEqual(result.exitCode, 0, target);
        assert.equal(await f.fingerprint(), before, target);
      }
    }
    for (const target of [path.join(f.A, "new-file"), path.join(f.B, "new-file")]) {
      const result = await f.probe("import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'new');", [target]);
      assert.notEqual(result.exitCode, 0, target);
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
    }
    const mutation = await f.probe("import{unlinkSync,symlinkSync}from'node:fs';unlinkSync(process.argv[1]);symlinkSync(process.argv[2],process.argv[1]);", [f.logical, f.B]);
    assert.notEqual(mutation.exitCode, 0);
    assert.equal(await f.fingerprint(), before);
    for (const target of [...f.code, ...f.metadata]) {
      const removal = await f.probe("import{unlinkSync}from'node:fs';unlinkSync(process.argv[1]);", [target], true);
      assert.notEqual(removal.exitCode, 0, target);
      assert.equal(await f.fingerprint(), before, target);
    }
    await f.hostControl();
  } finally { await f.close(); }
});

test("native read-deny for SQLite sidecars and secrets survives writable aliases and child shells", async () => {
  const f = await nativeFixture();
  try {
    await positiveControl(f);
    const before = await f.fingerprint();
    for (const file of f.hidden) {
      for (const target of [file, path.join(f.aliases, "state", path.basename(file))]) {
        for (const childShell of [false, true]) {
          const result = await f.probe("import{readFileSync}from'node:fs';process.stdout.write(readFileSync(process.argv[1]));", [target], childShell);
          assert.notEqual(result.exitCode, 0, target);
          assert.equal(Buffer.from(result.stdout).includes(Buffer.from("host-sentinel:")), false);
        }
      }
    }
    assert.equal(await f.fingerprint(), before);
    await f.hostControl();
  } finally { await f.close(); }
});

test("native connect-deny protects live host and peer sockets inside writable roots without closing own IPC", async () => {
  const f = await nativeFixture();
  try {
    await positiveControl(f);
    const before = f.connectionCount();
    const script = "import{createConnection}from'node:net';const c=createConnection(process.argv[1]);c.on('error',()=>{process.exitCode=19});c.on('data',b=>process.stdout.write(b));c.setTimeout(2000,()=>{c.destroy();process.exitCode=20});";
    for (const [index, socket] of f.sockets.entries()) {
      for (const target of [socket, path.join(f.aliases, `socket-${index}`)]) {
        for (const childShell of [false, true]) {
          const result = await f.probe(script, [target], childShell);
          assert.notEqual(result.exitCode, 0, target);
          assert.equal(Buffer.from(result.stdout).includes(Buffer.from("host-alive")), false);
          assert.equal(f.connectionCount(), before);
        }
      }
    }
    const ownSocket = path.join(f.run, "own-ipc.sock");
    const own = await f.probe("import{createServer,createConnection}from'node:net';const s=createServer(c=>c.end('own-ipc'));s.listen(process.argv[1],()=>{const c=createConnection(process.argv[1]);c.on('data',b=>process.stdout.write(b));c.on('end',()=>s.close());});", [ownSocket]);
    assert.equal(own.exitCode, 0, Buffer.from(own.stderr).toString());
    assert.equal(Buffer.from(own.stdout).toString(), "own-ipc");
    await f.hostControl();
  } finally { await f.close(); }
});

test("native deny boundaries remain effective after host changes logical main from A to B", async () => {
  const f = await nativeFixture();
  try {
    await positiveControl(f);
    const stagedLink = path.join(f.base, "next-main");
    await fs.symlink(f.B, stagedLink);
    await fs.rename(stagedLink, f.logical);
    const before = await f.fingerprint();
    for (const file of [...f.code, path.join(f.logical, "bin/raf.ts")]) {
      const result = await f.probe("import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'tampered');", [file]);
      assert.notEqual(result.exitCode, 0, file);
      assert.equal(await f.fingerprint(), before);
    }
    await f.hostControl();
  } finally { await f.close(); }
});
