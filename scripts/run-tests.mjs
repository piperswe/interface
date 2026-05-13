// Wrap `vitest run` and drop benign workerd disconnect noise.
//
// vitest-pool-workers runs tests in real workerd subprocesses. When workerd
// tears down WebSocket / ReadableStream connections between test files
// (Sandbox DO sockets, ConversationDurableObject SSE streams, etc.), it
// writes raw "disconnected:" diagnostics. vitest captures workerd's stderr
// and forwards it to its own stdout, intermixed with the test report — so
// we filter the child's stdout, not stderr. They are not test failures —
// all assertions still pass — but they drown out real output.
//
// We only suppress the three exact line shapes workerd emits for these
// teardowns. Anything else (a different exception, an unmatched stack
// format, a different uncaught error) still surfaces.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const FILTERS = [
	/^exception = .*?: disconnected: /,
	/^stack: .*workerd@[0-9a-f]+( workerd@[0-9a-f]+)*\s*$/,
	/^uncaught exception; source = Uncaught \(in promise\); stack = Error: Network connection lost\.\s*$/,
];

const child = spawn('npx', ['vitest', 'run', ...process.argv.slice(2)], {
	stdio: ['inherit', 'pipe', 'inherit'],
});

let suppressed = 0;
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
	if (FILTERS.some((re) => re.test(line))) {
		suppressed++;
		return;
	}
	process.stdout.write(`${line}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
	if (suppressed > 0) {
		process.stderr.write(`(suppressed ${suppressed} benign workerd disconnect messages)\n`);
	}
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});
