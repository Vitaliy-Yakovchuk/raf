import { appendFileSync } from 'node:fs';
import net from 'node:net';

function pathname(args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  return typeof value === 'string' ? value : value?.path;
}

function record(event, address) {
  if (typeof address !== 'string' || !process.env.Z390_TRACE) return;
  try {
    appendFileSync(process.env.Z390_TRACE, JSON.stringify({ event, address, bytes: Buffer.byteLength(address), cwd: process.cwd(), home: process.env.HOME, pid: process.pid }) + '\n');
  } catch {}
}

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const address = pathname(args);
  record('listen-attempt', address);
  this.once('listening', () => record('listen-ready', address));
  return Reflect.apply(listen, this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const address = pathname(args);
  record('connect-attempt', address);
  this.once('connect', () => record('connect-ready', address));
  return Reflect.apply(connect, this, args);
};
