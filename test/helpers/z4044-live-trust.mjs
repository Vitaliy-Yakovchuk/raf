import assert from 'node:assert/strict';
import path from 'node:path';

export function configureLiveCodexTrust(configuration, root) {
  assert.ok(path.isAbsolute(root) && root !== path.parse(root).root, 'owned fixture Git root required');
  const protocol = configuration.runnerProtocols.find(entry => entry.runner === 'codex');
  assert.ok(protocol && Array.isArray(protocol.baseArgs) && Array.isArray(protocol.quota?.args), 'configured Codex worker and quota invocations required');
  const gitRoots = [root, ...['raf-main', 'raf-develop', 'raf-hotfix'].map(name => path.join(root, name))];
  const overrides = ['projects={' + gitRoots.map(directory => `${JSON.stringify(directory)}={trust_level="trusted"}`).join(',') + '}'];
  const args = overrides.flatMap(value => ['-c', value]);
  const quotaCwd = path.join(root, 'raf-main');
  protocol.baseArgs.push(...args);
  protocol.quota.args.push(...args, '-C', quotaCwd);
  return { gitRoots, overrides, quotaCwd };
}
