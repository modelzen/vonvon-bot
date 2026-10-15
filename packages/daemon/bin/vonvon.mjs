#!/usr/bin/env node
// Hooks that 咖啡一下 put into Claude Code and Codex CLI still run `vonvon hook --agent claude|codex [--bot …]` and
// write the event as JSON to stdin. 咖啡一下 is gone (s02c2), so the command does nothing and the tool asks in its
// terminal as before. It is answered here, before the CLI bundle, because loading the bundle takes most of a second.
// Any arguments are accepted. stdin is read to the end so the writer never meets a closed pipe, but for at most 2 s,
// because a stdin that never closes must not hold the tool up. Nothing is printed and the exit code is always 0.
if (process.argv[2] === 'hook') {
  await new Promise(done => {
    try {
      const stdin = process.stdin;
      if (stdin.isTTY) return done();
      setTimeout(done, 2000);
      stdin.on('end', done).on('close', done).on('error', done).resume();
    } catch {
      done();
    }
  });
  process.exit(0);
}
await import('../dist/cli.js');
