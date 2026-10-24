import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const marker = '.trt633-prepared.json';
const fail = (message: string): never => { throw Error(`TRT633 setup: ${message}`); };
const within = (file: string, root: string) => file === root || file.startsWith(root + '/');
function check(ok: unknown, message: string): asserts ok { if (!ok) fail(message); }

type Input = { env: NodeJS.ProcessEnv; source: string; ownerRoot: string; evidence: string };
export type PreparedHome = {
  home: string; tmpdir: string; codexHome: string; evidence: string;
  provenance: { canonicalHome: string; uid: number; device: number; inode: number; emptyAtPreparation: true; preparedAt: string; source: string; ownerRoot: string; method: string };
};

export function assertOwnedDirectory(file: string, identity?: { uid: number; device: number; inode: number }): fs.Stats {
  check(path.isAbsolute(file) && path.resolve(file) === file, 'HOME must be absolute and canonical');
  check(fs.existsSync(file), 'HOME directory must exist');
  const stat = fs.lstatSync(file);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(file) === file, 'HOME must be a canonical directory without symlinks');
  check(stat.uid === process.getuid!(), 'HOME uid must be the current user');
  check((stat.mode & 0o777) === 0o700, 'HOME must be private (700)');
  if (identity) check(stat.uid === identity.uid && stat.dev === identity.device && stat.ino === identity.inode, 'HOME provenance identity changed');
  return stat;
}

function layout({ env, source, ownerRoot, evidence }: Input) {
  const home = env.HOME;
  check(home && home === env.RAF_QA_HOME && home === env.TMPDIR, 'HOME=RAF_QA_HOME=TMPDIR must be the same explicit mktemp');
  check(path.isAbsolute(home) && path.resolve(home) === home, 'HOME must be absolute and canonical');
  const forbidden = [os.userInfo().homedir, '/proc', '/sys', '/dev', '/run', source, ownerRoot, `/tmp/raf-unit-${process.getuid!()}`];
  check(!forbidden.some(root => within(home, root) || within(root, home)), 'HOME overlaps operational or source paths');
  check(/^TRT633[-_][A-Za-z0-9_-]{6,}$/.test(path.basename(home)), 'HOME must be a fresh TRT633-prefixed mktemp directory');
  const stat = assertOwnedDirectory(home);
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
  check(!mounts.some(mount => mount && within(mount, home)), 'HOME must not contain bind or mounted paths');
  const codexHome = path.join(home, '.codex');
  check(env.CODEX_HOME === codexHome, 'CODEX_HOME must be the stand HOME/.codex; shared credentials are forbidden');
  for (const suffix of ['/main.sock', '/.raf/tmp/tmux/server.sock', '/.raf/service.sock']) check(Buffer.byteLength(home + suffix) <= 107, 'HOME is too long for tmux/service socket pathname');
  check(typeof evidence === 'string' && path.isAbsolute(evidence) && path.resolve(evidence) === evidence, 'evidence must be an absolute canonical path');
  check(!within(evidence, home) && !within(home, evidence), 'evidence must be outside HOME');
  check(fs.existsSync(path.dirname(evidence)), 'evidence parent must exist');
  check(!fs.existsSync(evidence) && !fs.lstatSync(path.dirname(evidence)).isSymbolicLink() && fs.realpathSync(path.dirname(evidence)) === path.dirname(evidence), 'evidence must be new with an existing canonical parent');
  return { home, tmpdir: home, codexHome, evidence, stat };
}

export function prepareHostHome(input: Input): PreparedHome {
  const { stat, ...selected } = layout(input);
  check(fs.readdirSync(selected.home).length === 0, 'HOME must be empty before preparation; never reuse a previous stand');
  const prepared: PreparedHome = {
    ...selected,
    provenance: { canonicalHome: selected.home, uid: stat.uid, device: stat.dev, inode: stat.ino, emptyAtPreparation: true, preparedAt: new Date().toISOString(), source: input.source, ownerRoot: input.ownerRoot, method: 'explicit TRT633 mktemp; canonical owned empty directory verified before Codex preparation' },
  };
  fs.mkdirSync(selected.codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(selected.codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(selected.home, marker), JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return prepared;
}

export function verifyPreparedHostHome(input: Input): PreparedHome {
  const { stat, ...selected } = layout(input);
  const privateFile = (file: string) => {
    check(fs.existsSync(file), `separate Codex authorization/preparation required: missing ${path.basename(file)}`);
    const s = fs.lstatSync(file);
    check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === stat.uid && (s.mode & 0o077) === 0, `private regular file without symlink/hardlink required: ${path.basename(file)}`);
  };
  privateFile(path.join(selected.home, marker));
  const prepared: PreparedHome = JSON.parse(fs.readFileSync(path.join(selected.home, marker), 'utf8'));
  check(prepared.provenance?.emptyAtPreparation === true && prepared.provenance.canonicalHome === selected.home && prepared.provenance.source === input.source && prepared.provenance.ownerRoot === input.ownerRoot, 'HOME preparation provenance mismatch');
  assertOwnedDirectory(selected.home, prepared.provenance);
  check(Object.entries(selected).every(([key, value]) => prepared[key as keyof PreparedHome] === value), 'HOME preparation selectors changed');
  check(fs.readdirSync(selected.home).every(name => [marker, '.codex'].includes(name)), 'HOME has unexpected entries; previous or unknown stand must not be reused');
  assertOwnedDirectory(selected.codexHome);
  for (const name of ['config.toml', 'auth.json']) privateFile(path.join(selected.codexHome, name));
  check(fs.readFileSync(path.join(selected.codexHome, 'config.toml'), 'utf8') === 'cli_auth_credentials_store = "file"\n', 'Codex must use the separately prepared file credentials store');
  return prepared;
}
