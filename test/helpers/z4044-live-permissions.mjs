export function setPrivateLiveUmask() {
  return process.umask(0o077);
}
