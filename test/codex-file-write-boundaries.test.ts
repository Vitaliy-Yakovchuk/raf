import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { prepareCodexSandbox, type PreparedCodexSandbox } from '../src/codex-sandbox.ts';
import type { Invocation } from '../src/runner-protocols.ts';

type Access = 'read' | 'write' | 'none';

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function filesystem(invocation: Invocation): Map<string, Access> {
  const overrides = invocation.args.flatMap((arg, index, args) =>
    arg === '-c' || arg === '--config' ? [args[index + 1]] : []);
  const selected = overrides.filter(arg => arg?.startsWith('default_permissions='));
  const flags = invocation.args.flatMap((arg, index, args) => arg === '-P' ? [args[index + 1]] : []);
  const profiles: string[] = [...flags, ...selected.map(arg => JSON.parse(arg.slice('default_permissions='.length)))];
  assert.ok(profiles.length > 0 && profiles.every(profile => profile === profiles[0]), 'one selected native permission profile');
  const profile = profiles[0];
  const key = `permissions.${profile}.filesystem=`;
  const tables = overrides.filter(arg => arg?.startsWith(key));
  assert.equal(tables.length, 1, 'the selected native profile defines its filesystem');
  const table = tables[0].slice(key.length);
  assert.ok(table.startsWith('{') && table.endsWith('}'), 'filesystem is a TOML inline table');
  const body = table.slice(1, -1);
  const entry = /\s*("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")\s*(,|$)/gy;
  const permissions = new Map<string, Access>();
  let offset = 0;
  while (offset < body.length) {
    entry.lastIndex = offset;
    const match = entry.exec(body);
    assert.ok(match, `invalid permission entry at ${offset}`);
    const path: string = JSON.parse(match[1]);
    const access: Access = JSON.parse(match[2]);
    assert.ok(['read', 'write', 'none'].includes(access));
    assert.ok(!permissions.has(path), `duplicate permission for ${path}`);
    permissions.set(path, access);
    offset = entry.lastIndex;
  }
  return permissions;
}

async function fixture() {
  const base = resolve(process.env.RAF_Z369_FIXTURE_ROOT ?? join(import.meta.dirname, '..'));
  const root = await realpath(await mkdtemp(join(base, '.z369-file-boundaries-')));
  const cwd = join(root, 'workspace');
  const runDirectory = join(root, 'runs', 'own');
  const home = join(root, 'home');
  const hidden = join(home, '.raf');
  const files = [
    join(root, 'questions', 'projects', 'raf', 'questions.md'),
    join(root, 'questions', 'projects', 'project with spaces', 'questions.md'),
    join(root, 'outside workspace', 'review "notes".md'),
  ];
  const siblings = files.map(file => join(dirname(file), 'unassigned.md'));
  const created = files.map(file => join(dirname(file), 'new-unassigned.md'));
  let prepared: PreparedCodexSandbox | undefined;
  try {
    await Promise.all([cwd, runDirectory, hidden, ...files.map(dirname)].map(path => mkdir(path, { recursive: true })));
    await Promise.all([...files, ...siblings].map(path => writeFile(path, 'original\n')));
    prepared = await prepareCodexSandbox({
      runId: randomUUID(),
      invocation: {
        executable: 'codex',
        args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
        liveTaskVerified: false,
      },
      cwd,
      runDirectory,
      writableDirectories: [cwd, ...files],
      readOnlyDirectories: [root],
      scope: { hidden: [hidden], readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] },
      environment: {
        ...process.env,
        HOME: home,
        TMUX: '',
        TMUX_PANE: '',
        SSH_AUTH_SOCK: '',
        SSH_AGENT_PID: '',
        DBUS_SESSION_BUS_ADDRESS: '',
        XDG_RUNTIME_DIR: '',
      },
      timeoutMs: 30_000,
    });
    return {
      root, cwd, runDirectory, files, siblings, created, prepared,
      async cleanup(): Promise<void> {
        try { await prepared!.cleanup(); }
        finally { await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await prepared?.cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

async function execute(prepared: PreparedCodexSandbox, cwd: string, script: string, paths: object): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(prepared.toolSandbox.executable,
      [...prepared.toolSandbox.args, process.execPath, '--input-type=module', '-e', script, JSON.stringify(paths)],
      { cwd, env: prepared.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolveOutput(stdout);
      else reject(new Error(`tool sandbox failed: code=${code} signal=${signal}\n${stderr}\n${stdout}`));
    });
  });
}

test('[Z.369 policy] every file write boundary is writable in the native edit policy without granting its parent', async () => {
  const f = await fixture();
  try {
    for (const [name, invocation] of [['runner', f.prepared.invocation], ['shell', f.prepared.toolSandbox]] as const) {
      const permissions = filesystem(invocation);
      for (const file of f.files) {
        assert.equal(permissions.get(file), 'write', `${name}: native edits must allow the exact boundary ${file}`);
        for (const [path, access] of permissions) {
          if (access === 'write' && isAbsolute(path) && path !== file) {
            assert.ok(!contains(path, file), `${name}: ${path} must not widen the file boundary ${file}`);
          }
        }
      }
      for (const sibling of [...f.siblings, ...f.created]) {
        assert.notEqual(permissions.get(sibling), 'write', `${name}: unassigned sibling is not writable`);
      }
    }
  } finally { await f.cleanup(); }
});

test('[Z.369 shell] file boundaries permit writes while existing and new siblings remain protected', async () => {
  const f = await fixture();
  try {
    assert.ok(!contains('/tmp', f.root), 'use RAF_Z369_FIXTURE_ROOT outside /tmp so :slash_tmp cannot mask file isolation');
    const script = `
      import { writeFile } from 'node:fs/promises';
      const paths = JSON.parse(process.argv[1]);
      const allowed = [];
      const denied = [];
      for (const path of paths.files) {
        await writeFile(path, 'shell updated\\n');
        allowed.push(path);
      }
      for (const path of [...paths.siblings, ...paths.created]) {
        try { await writeFile(path, 'forbidden\\n'); denied.push({ path, code: 'WRITE_SUCCEEDED' }); }
        catch (error) { denied.push({ path, code: error.code }); }
      }
      process.stdout.write(JSON.stringify({ allowed, denied }));
    `;
    const result = JSON.parse(await execute(f.prepared, f.cwd, script, {
      files: f.files, siblings: f.siblings, created: f.created,
    }));
    assert.deepEqual(result.allowed, f.files);
    assert.equal(result.denied.length, f.siblings.length + f.created.length);
    for (const denial of result.denied) {
      assert.ok(['EACCES', 'EPERM', 'EROFS'].includes(denial.code), `${denial.path}: expected write denial, got ${denial.code}`);
    }
    for (const file of f.files) assert.equal(await readFile(file, 'utf8'), 'shell updated\n');
    for (const sibling of f.siblings) assert.equal(await readFile(sibling, 'utf8'), 'original\n');
    for (const created of f.created) await assert.rejects(readFile(created), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
