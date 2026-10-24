import { open, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [channel, destination] = process.argv.slice(2);
if (!channel || !destination) throw new Error('Own command channel and evidence destination are required');
await mkdir(resolve(destination, '..'), { recursive: true });
const deadline = Date.now() + 1200000;
let files;
while (Date.now() < deadline && !files) {
  for (const directory of await readdir(channel)) {
    if (!directory.startsWith('capture-')) continue;
    const opened = [];
    try {
      for (const name of ['stdout', 'stderr', 'result.json']) opened.push(await open(join(channel, directory, name), 'r'));
      files = opened;
      break;
    } catch (error) {
      await Promise.all(opened.map(file => file.close()));
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!files) await delay(5);
}
if (!files) throw new Error('No command capture observed; do not repeat the test without reconciling its outcome');
try {
  while (Date.now() < deadline) {
    const info = await files[2].stat();
    if (info.size) {
      const metadata = Buffer.alloc(info.size);
      await files[2].read(metadata, 0, metadata.length, 0);
      let transport;
      try { transport = JSON.parse(metadata.toString()); } catch { await delay(5); continue; }
      const buffers = [];
      for (const [index, length] of [transport.stdoutBytes, transport.stderrBytes].entries()) {
        const data = Buffer.alloc(length);
        const result = await files[index].read(data, 0, data.length, 0);
        if (result.bytesRead !== length) throw new Error('Incomplete command stream');
        buffers.push(data);
      }
      await writeFile(destination + '.stdout', buffers[0]);
      await writeFile(destination + '.stderr', buffers[1]);
      await writeFile(destination + '.transport.json', metadata);
      console.log(JSON.stringify({ cliExitCode: transport.code, stdoutBytes: transport.stdoutBytes, stderrBytes: transport.stderrBytes, destination }));
      process.exitCode = 0;
      break;
    }
    await delay(5);
  }
  if (process.exitCode !== 0) throw new Error('Command capture incomplete; outcome remains unknown');
} finally {
  await Promise.all(files.map(file => file.close()));
}
