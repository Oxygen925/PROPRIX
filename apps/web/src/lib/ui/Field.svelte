<script lang="ts">
	// 라벨 + 입력 + 도움말·오류. 입력 요소는 children 으로 넣는다
	import type { Snippet } from 'svelte';

	let {
		label,
		hint = '',
		error = '',
		children
	}: { label: string; hint?: string; error?: string; children: Snippet } = $props();
</script>

<label class="field">
	<span class="label">{label}</span>
	{@render children()}
	{#if error}<span class="error" role="alert">{error}</span>{:else if hint}<span class="hint">{hint}</span>{/if}
</label>

<style>
	.field {
		display: grid;
		gap: 0.375rem;
	}
	.label {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.error {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
	.field :global(input),
	.field :global(select),
	.field :global(textarea) {
		width: 100%;
	}
</style>
