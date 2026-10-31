import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as commandAccess from '../src/codex-raf-command-access.ts';

test('[codex-command-fd] darwin uses /dev/fd for an open descriptor', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(13, 'darwin'), '/dev/fd/13');
});

test('[codex-command-fd] Linux keeps /proc/self/fd for an open descriptor', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(44, 'linux'), '/proc/self/fd/44');
});

test('[codex-command-fd] omitted platform uses the running platform', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(0), process.platform === 'darwin' ? '/dev/fd/0' : '/proc/self/fd/0');
});
