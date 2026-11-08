#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
/* fixture options */
const log = name => {
  if (typeof eventsPath !== 'undefined') appendFileSync(eventsPath, JSON.stringify({ name, at: Date.now() }) + '\n');
};
if (process.argv.includes('--version')) { console.log('codex-cli 0.133.0'); process.exit(0); }
if (typeof runnerPidPath !== 'undefined') writeFileSync(runnerPidPath, String(process.pid));
const statusDelay = typeof statusDelayMs === 'undefined' ? 0 : statusDelayMs;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let input = '', working = false, buffer = '', paste = false, pasted = '', statusPending = false;
function draw() {
  process.stdout.write('\x1b[2J\x1b[H' + (working ? '• Working (1s • esc to interrupt)\r\n' : '') + '› ' + (input || 'Ask Codex to do anything') + '\r\n');
}
process.stdout.write('\x1b[?2004h');
draw();
process.stdin.on('data', data => {
  buffer += data;
  while (buffer) {
    if (buffer.startsWith('\x1b[200~')) { paste = true; pasted = ''; buffer = buffer.slice(6); continue; }
    if (buffer.startsWith('\x1b[201~')) { paste = false; input = `[Pasted Content ${pasted.length} chars]`; buffer = buffer.slice(6); log('brief-pasted'); draw(); continue; }
    if (buffer.startsWith('\x1b[') && buffer.length < 6) return;
    const c = buffer[0]; buffer = buffer.slice(1);
    if (paste) { pasted += c; continue; }
    if (c === '\r' || c === '\n') {
      if (input === '/status' || statusPending) {
        log('status-submit');
        statusPending = true;
        setTimeout(() => {
          input = ''; statusPending = false;
          log('status-shown');
          process.stdout.write('\x1b[2J\x1b[HSession: 3dbaae4a-e4cc-477f-b36c-3669d71ad68a\r\n› Ask Codex to do anything\r\n');
        }, statusDelay);
      } else if (input === '/exit') process.exit(0);
      else if (input) { input = ''; working = true; log('brief-submit'); draw(); }
    } else if (c === '\x03') process.exit(0);
    else { input += c; if (input === '/status') log('status-typed'); }
  }
  if (input && !paste) draw();
});
