<script lang="ts">
	// 빈 화면: 사과 대신 무엇을 할 수 있는지 안내한다
	import type { Icon } from '@tabler/icons-svelte-runes';
	import type { Snippet } from 'svelte';

	let { icon, title, body = '', action }: { icon?: Icon; title: string; body?: string; action?: Snippet } = $props();
</script>

<div class="empty">
	{#if icon}{@const I = icon}<span class="icon"><I size="1.375rem" stroke={1.5} aria-hidden="true" /></span>{/if}
	<p class="title">{title}</p>
	{#if body}<p class="body">{body}</p>{/if}
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: 0.375rem;
		padding: var(--s-6) var(--s-4);
		text-align: center;
	}
	.icon {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		background: var(--c-surface-2);
		color: var(--c-text-3);
		margin-bottom: 0.25rem;
	}
	.title {
		color: var(--c-text);
		font-weight: var(--w-bold);
	}
	.body {
		color: var(--c-text-3);
		font-size: var(--t-sm);
		max-width: 20rem;
	}
	.action {
		margin-top: var(--s-2);
	}
</style>
