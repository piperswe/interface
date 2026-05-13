#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';

const svelteFiles = globSync('src/**/*.svelte');

let exitCode = 0;

const LOOP_RE = /\{#each\s/;

// Matches a `<form` tag followed by `{...` svelte spread with a `.enhance(` call
// but without a `.for(` before the `.enhance(`.
const BARE_FORM_RE = /<form\s+\{\.\.\.([\w.]+)\.enhance\(/g;
const FORM_WITH_FOR_RE = /<form\s+\{\.\.\.([\w.]+)\.for\(/g;

for (const file of svelteFiles) {
	const src = readFileSync(file, 'utf-8');
	const lines = src.split('\n');

	// Only check files that have loops
	const hasLoop = LOOP_RE.test(src);
	if (!hasLoop) continue;

	let inLoop = false;
	let loopDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Track loop depth
		if (LOOP_RE.test(line)) {
			inLoop = true;
			loopDepth++;
			continue;
		}
		if (inLoop && /^\{\/each\}/.test(trimmed)) {
			loopDepth--;
			if (loopDepth === 0) inLoop = false;
			continue;
		}

		if (!inLoop) continue;

		// Check for <form {...xxx.enhance(...)} without .for(...)
		const bareMatch = trimmed.match(BARE_FORM_RE);
		if (bareMatch) {
			const formName = bareMatch[1];
			// Verify no .for() on this line
			if (!trimmed.includes('.for(')) {
				console.error(
					`\x1b[31mERROR\x1b[0m: ${file}:${i + 1} — \`<form {...${formName}.enhance(...)}>\` inside {#each} without unique .for() key.\n  Each rendered <form> in a loop needs a unique key to avoid "form object can only be attached to a single <form> element".`,
				);
				console.error(`  Fix: \`<form {...${formName}.for(uniqueKey).enhance(...)}>\``);
				exitCode = 1;
			}
		}

		// Check that .for() keys inside loops are dynamic expressions, not static strings that repeat
		// (This catches cases where the .for() key is accidentally shared)
		const forMatch = trimmed.match(FORM_WITH_FOR_RE);
		if (forMatch) {
			const _formName = forMatch[1];
			// Extract the .for(argument) part
			const forPart = trimmed.match(/\.for\(([^)]+)\)/);
			if (forPart) {
				const keyArg = forPart[1].trim();
				// If it's a static string (no template expressions, no variables), warn
				if (/^'[^']*'$/.test(keyArg) || /^"[^"]*"$/.test(keyArg)) {
					if (!keyArg.includes('${')) {
						console.error(
							`\x1b[33mWARNING\x1b[0m: ${file}:${i + 1} — \`.for("${keyArg}")\` inside {#each} uses a static key.\n  Each iteration needs a different key; consider using a dynamic value like \`{p.id}\`.`,
						);
					}
				}
			}
		}
	}
}

if (exitCode === 0) {
	console.log('\x1b[32m✓\x1b[0m All remote form usage looks correct.');
}
process.exit(exitCode);
