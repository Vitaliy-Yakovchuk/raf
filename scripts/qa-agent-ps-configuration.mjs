import fs from 'node:fs';
import path from 'node:path';

export function copyAgentPsConfiguration(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
  const writable = file => {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error('QA configuration copy must contain regular files and directories');
    fs.chmodSync(file, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const child of fs.readdirSync(file)) writable(path.join(file, child));
  };
  writable(destination);
}

export function createAgentPsDevelopWorktree(setup, root, main, reviewed) {
  setup('git', ['worktree', 'add', '-b', 'develop', path.join(root, 'raf-develop'), reviewed], main);
}
