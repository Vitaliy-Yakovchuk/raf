import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = '/srv/dev/work/orchestrator';
const raf = path.join(root, 'raf-develop');
const etchly = path.join(root, 'etchly-develop');
const generation = path.join(root, '.git/modules/raf/raf-hotfix/generations/de319c1f-fc5b-432e-884a-a25ac062c5bf/raf-main');
const destination = path.dirname(new URL(import.meta.url).pathname);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function metadata(file) {
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, realpath: fs.realpathSync(file), kind: stat.isDirectory() ? 'directory' : 'file', mode: (stat.mode & 0o777).toString(8), bytes: stat.size, sha256: stat.isFile() ? hash(file) : null };
  } catch (error) { return { path: file, exists: false, errorCode: error.code }; }
}
const config = json(path.join(root, 'conf/test-runs.json'));
const profile = config.projects.etchly.profiles['vitest-worker-d1-integration'];
const group = config.projects.etchly.groups['add-raf-test-run/etchly-worker-d1-smoke'];
const patch = json(path.join(destination, '../etchly-integration-scaffold/etchly-registration.patch.json'));
const registrations = patch.map(operation => {
  const observed = operation.path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((value, key) => value?.[key], config);
  return { pointer: operation.path, exactPatchMatch: JSON.stringify(observed) === JSON.stringify(operation.value) };
});
const unitFiles = new Set(Object.values(config.projects.etchly.profiles).flatMap(value => value.unitFiles ?? []));
const codeFiles = ['bin/raf.ts', 'src/test-run-runtime.ts', 'src/sandbox-test-run.ts', 'src/test-run-etchly-integration.ts', 'src/test-run-etchly-inventory.ts', 'src/test-run-etchly.ts', 'src/test-run-vitest-reporter.ts', 'scripts/test-run-vitest.ts', 'scripts/test-run-vitest-api.ts', 'scripts/test-run-node.ts'];
const build = metadata(path.join(etchly, 'app/dist/local/index.html'));
const prerequisites = profile.checks.map(file => metadata(path.join(etchly, file)));
const executables = ['node_modules/workerd/bin/workerd', 'node_modules/esbuild/bin/esbuild'].map(file => metadata(path.join(etchly, file)));
const localPackages = ['vitest', 'wrangler', 'miniflare', 'workerd', 'esbuild'].map(name => {
  const file = path.join(etchly, 'node_modules', name, 'package.json');
  const info = metadata(file);
  return { ...info, name, version: info.exists ? json(file).version : null };
});
const sources = ['worker/vitest.config.ts', 'test-support/vitest-project-files.ts', 'test-support/temp-resources.ts', 'test-support/file-budget-runner.ts', 'scripts/shared-library-runtime.mjs', 'scripts/shared-library-aliases.ts', 'scripts/shared-libs-path.mjs', 'worker/src/test-support/shared-worker-global-setup.ts', 'worker/src/test-support/d1-template-global-setup.ts', 'worker/src/test-support/d1-template-setup.ts', 'worker/src/test-support/shared-worker-setup.ts', 'worker/src/test-support/shared-worker-runtime.ts', 'worker/src/test-support/live-worker.ts'];
const result = {
  sourceItem: 'add-raf-test-run:6.2.6.3', observedAt: new Date().toISOString(),
  method: 'Read-only Git, file metadata, hashes and JSON registration comparison. No runner, test body, Vitest discovery, D1 setup, loopback listener, process harness, operational raf state, build or install was executed.',
  actor: { agentId: 'raf-trt6263b-qa', agentRunId: '9d1bbeb7-7ae8-4031-8157-297eff31b379', assignmentProject: 'raf', assignmentPhase: 'qa', executable: process.execPath, nodeVersion: process.version, platform: process.platform, arch: process.arch },
  repositories: [raf, etchly].map(repository => ({ repository, sha: git(repository, 'rev-parse', 'HEAD'), branch: git(repository, 'branch', '--show-current'), dirty: git(repository, 'status', '--porcelain=v1') })),
  orchestratorSha: git(root, 'rev-parse', 'HEAD'),
  generation: { path: generation, files: codeFiles.map(file => ({ file, generation: metadata(path.join(generation, file)), workspace: metadata(path.join(raf, file)) })) },
  configuration: ['conf/test-runs.json', 'conf/flow.json', 'conf/projects.json', 'conf/raf-constants.json'].map(file => metadata(path.join(root, file))),
  registrations,
  unitGroup: config.projects.raf.groups['add-raf-test-run/etchly-integration'],
  smoke: { group: 'add-raf-test-run/etchly-worker-d1-smoke', ...group, profile: { ...profile, integrationFiles: undefined }, inventoryCount: profile.integrationFiles.length, uniqueInventoryCount: new Set(profile.integrationFiles).size, missingFiles: profile.integrationFiles.filter(file => !fs.existsSync(path.join(etchly, file))), unitOverlap: profile.integrationFiles.filter(file => unitFiles.has(file)), examples: group.files.map(file => metadata(path.join(etchly, file))) },
  prerequisites, executables, localPackages,
  localBuild: { ...build, containsDev1Favicon: build.exists ? fs.readFileSync(build.path, 'utf8').includes('href="/favicon-dev1.svg"') : null, liveBuildValidityConfirmed: false },
  sharedLibs: { ...metadata(path.join(etchly, 'shared-libs')), branch: git(path.join(etchly, 'shared-libs'), 'branch', '--show-current'), resourceProtocol: metadata(path.join(etchly, 'shared-libs/resource-protocol/node_modules')), scopedModules: metadata(path.join(etchly, 'shared-libs/resource-protocol/node_modules/@resource-protocol')) },
  sourceHashes: sources.map(file => metadata(path.join(etchly, file))),
  lifecycle: { unitRunnerSpawnedInFirstInvocation: true, integrationRunnerSpawned: false, d1SetupConfirmed: false, bridgeCommandObserved: null, innerCommandObserved: null, ownedTestProcesses: [], ownedD1Artifacts: [], independentProcessCleanupVerification: 'First unit invocation reported cleanup complete; original output truncated. Authorized repeat refused before spawn. Live D1 lifecycle is unexecuted.' },
  unavailable: ['Trusted unit/control context after publication change: STATE_CONTEXT_REFUSED', 'Immutable project=etchly assignment/workspace for own active change', 'Live D1 build/dependency/loopback validation', 'D08 real forks/workerd deadline/interruption/concurrent/crash/recovery harness', 'Independent OS stdout/stderr capture; current tool combines streams', 'Message delivery currently fails with unregistered generation module origin']
};
fs.writeFileSync(path.join(destination, 'context.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ registrations, etchlySha: result.repositories[1].sha, inventory: result.smoke.inventoryCount, missingFiles: result.smoke.missingFiles.length, overlap: result.smoke.unitOverlap.length, missingPrerequisites: prerequisites.filter(item => !item.exists).map(item => item.path), executables: executables.map(item => ({ path: item.path, exists: item.exists, mode: item.mode })), localBuild: { exists: build.exists, containsDev1Favicon: result.localBuild.containsDev1Favicon }, liveExecution: false }));
