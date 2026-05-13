<script lang="ts">
	import type * as Monaco from 'monaco-editor';
	import { onDestroy, onMount } from 'svelte';

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
				addEventListener: () => {},
				dispatchEvent: () => false,
				onerror: null,
				onmessage: null,
				onmessageerror: null,
				postMessage: () => {},
				removeEventListener: () => {},
				terminate: () => {},
			}),
		};

		if (!container) return;
		editor = monaco.editor.create(container, {
			automaticLayout: true,
			fontSize: 13,
			language,
			minimap: { enabled: false },
			readOnly: readonly,
			scrollBeyondLastLine: false,
			tabSize: 2,
			theme: 'vs',
			value,
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
