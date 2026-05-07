<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type * as Monaco from 'monaco-editor';

	let {
		value = $bindable(''),
		language = 'javascript',
		height = '420px',
		readonly = false,
	}: {
		value: string;
		language?: string;
		height?: string;
		readonly?: boolean;
	} = $props();

	let container: HTMLDivElement | undefined = $state();
	let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	let monaco: typeof Monaco | null = null;
	let suppressNextChange = false;

	onMount(async () => {
		// Lazy import keeps Monaco out of the SSR bundle.
		monaco = await import('monaco-editor');

		// Tell Monaco to use embedded language services without spawning a
		// dedicated worker URL. Setting `getWorker` to a no-op falls back to
		// the in-thread tokenizer, which is enough for editing-only use.
		(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
			getWorker: () => ({
				postMessage: () => {},
				terminate: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
				onmessage: null,
				onerror: null,
				onmessageerror: null,
			}),
		};

		if (!container) return;
		editor = monaco.editor.create(container, {
			value,
			language,
			theme: 'vs',
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 13,
			tabSize: 2,
			readOnly: readonly,
		});
		editor.onDidChangeModelContent(() => {
			if (!editor) return;
			suppressNextChange = true;
			value = editor.getValue();
		});
	});

	$effect(() => {
		if (!editor) return;
		if (suppressNextChange) {
			suppressNextChange = false;
			return;
		}
		if (editor.getValue() !== value) {
			editor.setValue(value);
		}
	});

	onDestroy(() => {
		editor?.dispose();
		editor = null;
	});
</script>

<div bind:this={container} class="monaco-host border rounded" style="height: {height};"></div>

<style>
	.monaco-host {
		width: 100%;
		overflow: hidden;
	}
</style>
