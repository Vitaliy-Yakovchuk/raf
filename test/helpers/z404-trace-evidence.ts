export function traceEvidence(lines: readonly string[], helper: string, filter: string) {
  const quoted = (value: string) => JSON.stringify(value);
  const successful = (line: string) => / = (?:0|[1-9][0-9]*(?:<[^>]*>)?)$/.test(line);
  const systemSandbox = lines.flatMap(line => {
    if (!line.includes('execve("/usr/bin/bwrap", [') || !/ = 0$/.test(line)) return [];
    const match = line.match(/execve\("\/usr\/bin\/bwrap", (\[.*\]), /);
    if (!match) return [];
    try {
      const args: string[] = JSON.parse(match[1]);
      const separator = args.indexOf('--');
      return separator >= 0 ? [args.slice(0, separator)] : [];
    } catch { return []; }
  });
  return {
    helperExecuted: lines.some(line => line.includes(`execve(${quoted(helper)}, [`)
      && / = 0$/.test(line)),
    systemBwrapExecuted: lines.some(line => line.includes('execve("/usr/bin/bwrap", [')
      && / = 0$/.test(line)),
    systemSandboxWithoutRafFlags: systemSandbox.some(args => !args.includes('--unshare-net') && !args.includes('--add-seccomp-fd')),
    filterRead: lines.some(line => /\bopen(?:at)?\(/.test(line)
      && line.includes(quoted(filter)) && /\bO_RDONLY\b/.test(line) && successful(line)),
    seccompInstalled: lines.some(line => /\bseccomp\(SECCOMP_SET_MODE_FILTER,/.test(line)
      && / = 0$/.test(line)),
  };
}
