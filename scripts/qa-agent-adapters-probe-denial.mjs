import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert/strict';
export const denied = async (resource, target) => {
  assert.equal(resource.before.path, resource.path);
  assert.ok(resource.before.ino > 0 && ['file', 'socket'].includes(resource.before.kind), 'Host existence control required');
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
  assert.ok(['EACCES', 'EPERM', 'ENOENT'].includes(error.code), 'Unexpected denial: ' + error.message);
  return { path: target, code: error.code, hostControl: resource.before,
    boundary: 'ENOENT is accepted only with the independent host before/after existence and liveness controls; host verification is mandatory.' };
};
