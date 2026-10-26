export interface CliOutputWrite {
  (fd: 'stdout' | 'stderr', chunk: string | Uint8Array, encoding: BufferEncoding | undefined, callback: (error: Error | null) => void): void;
}

export interface CliOutput {
  writeStdout(chunk: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  writeStderr(chunk: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
}

export interface ExecutionDelivery {
  stdout: string;
  stderr: string;
  exitCode: number;
  afterDelivery?: () => Promise<void>;
}

export function createSerializedCliOutput(ports: { write: CliOutputWrite }): CliOutput {
  let chain = Promise.resolve();
  const write = (fd: 'stdout' | 'stderr', chunk: string | Uint8Array, encoding?: BufferEncoding) => {
    const run = chain.then(() => new Promise<void>((resolve, reject) => {
      ports.write(fd, chunk, encoding, error => error ? reject(error) : resolve());
    }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  return {
    writeStdout: (chunk, encoding) => write('stdout', chunk, encoding),
    writeStderr: (chunk, encoding) => write('stderr', chunk, encoding),
  };
}

export function bindProcessCliOutput(stdout: NodeJS.WriteStream = process.stdout, stderr: NodeJS.WriteStream = process.stderr): CliOutput {
  const stdoutWrite = stdout.write.bind(stdout);
  const stderrWrite = stderr.write.bind(stderr);
  const output = createSerializedCliOutput({
    write(fd, chunk, encoding, callback) {
      const write = fd === 'stdout' ? stdoutWrite : stderrWrite;
      if (encoding) write(chunk as string, encoding, error => callback(error ?? null));
      else write(chunk as string, error => callback(error ?? null));
    },
  });
  const wrap = (fd: 'stdout' | 'stderr', stream: NodeJS.WriteStream) => {
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void) => {
      const callback = typeof encoding === 'function' ? encoding : cb;
      const enc = typeof encoding === 'string' ? encoding : undefined;
      const delivered = fd === 'stdout' ? output.writeStdout(chunk, enc) : output.writeStderr(chunk, enc);
      void delivered.then(() => callback?.(), error => callback?.(error));
      return true;
    }) as typeof stream.write;
  };
  wrap('stdout', stdout);
  wrap('stderr', stderr);
  return output;
}

export async function deliverExecutionResult(result: ExecutionDelivery, output: CliOutput): Promise<number> {
  try {
    if (result.stdout) await output.writeStdout(result.stdout + '\n');
    try { await result.afterDelivery?.(); } catch { /* acknowledgement stays best-effort */ }
    if (result.stderr) await output.writeStderr(result.stderr + '\n');
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await output.writeStderr(`${JSON.stringify({ code: 'PRODUCTION_ENTRY_FAILED', message })}\n`); } catch { /* stderr is already unusable */ }
    return 1;
  }
}
