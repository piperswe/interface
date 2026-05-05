<script lang="ts">
	import type { InfoPart } from '$lib/types/conversation';

	let { part }: { part: InfoPart } = $props();
</script>

<div class="info-part d-flex align-items-center gap-2 rounded p-2 border-start border-3">
	<span class="info-part-icon">ℹ</span>
	{part.text}
</div>

<style>
	.info-part {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--muted);
		font-size: 0.875rem;
		margin: 0.25rem 0;
	}

	.info-part-icon {
		font-size: 1rem;
		line-height: 1;
		flex-shrink: 0;
	}
</style>
