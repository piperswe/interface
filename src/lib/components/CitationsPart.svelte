<script lang="ts">
	import type { CitationsPart } from '$lib/types/conversation';

	let { part }: { part: CitationsPart } = $props();
</script>

{#if part.citations.length > 0}
	<details class="citations-part rounded border">
		<summary class="citations-summary px-2 py-1 small">
			<span class="citations-label">Sources</span>
			<span class="citations-count text-muted">({part.citations.length})</span>
		</summary>
		<ol class="citations-list list-unstyled m-0 p-2 d-flex flex-column gap-2">
			{#each part.citations as c, i (`${i}-${c.url}`)}
				<li class="citation small">
					<a
						class="citation-link text-decoration-none"
						href={c.url}
						target="_blank"
						rel="noopener noreferrer"
					>{c.title || c.url}</a>
					<div class="citation-url text-muted text-truncate">{c.url}</div>
					{#if c.snippet}
						<div class="citation-snippet text-muted">{c.snippet}</div>
					{/if}
				</li>
			{/each}
		</ol>
	</details>
{/if}

<style>
	.citations-part {
		background: var(--bs-body-bg);
		border-color: var(--border-soft);
		font-size: 0.875rem;
		margin: 0.25rem 0;
	}

	.citations-summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		user-select: none;
	}

	.citations-summary::-webkit-details-marker {
		display: none;
	}

	.citations-label {
		font-weight: 500;
	}

	.citation-link {
		color: var(--accent);
		font-weight: 500;
		word-break: break-word;
	}

	.citation-link:hover {
		text-decoration: underline;
	}

	.citation-url {
		font-size: 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
	}

	.citation-snippet {
		font-size: 0.8rem;
		margin-top: 0.15rem;
	}
</style>
