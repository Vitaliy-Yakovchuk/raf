import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert/strict';
export const denied = async (resource, target) => {
  assert.equal(resource.before.path, resource.path);
  assert.ok(resource.before.ino > 0 && ['file', 'socket'].includes(resource.before.kind), 'Host existence control required');
  assert.equal(resource.kind, resource.before.kind, 'Host resource kind must match');
  let error;
  if (resource.kind === 'file') {
    try { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); } catch(value) { error = value; }
  } else {
    error = await new Promise(resolve => {
      const socket = net.connect(target);
      socket.setTimeout(3000, () => { socket.destroy(); resolve(Error('Unverified timeout')); });
      socket.on('connect', () => { socket.destroy(); resolve(null); });
      socket.on('error', resolve);
    });
  }
  assert.ok(error, 'Protected existing resource was accessible: ' + target);
  assert.ok(['EACCES', 'EPERM', 'ENOENT'].includes(error.code) || resource.kind === 'socket' && error.code === 'ECONNREFUSED', 'Unexpected denial: ' + error.message);
  return { path: target, code: error.code, hostControl: resource.before, hostVerificationRequired: true,
    boundary: 'ENOENT and socket-only ECONNREFUSED require independent host before/after existence, unchanged identity and socket liveness controls; without those controls this result cannot pass host acceptance.' };
};
