<script lang="ts">
	// 그래프에서 고른 기억의 상세
	import { app } from '#lib/app.svelte.js';
	import { MEMORY_KIND_LABEL } from '#lib/labels.js';
	import MemoryUses from '#lib/manage/MemoryUses.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import type { Memory } from '@proprix/shared';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';

	let {
		memory,
		source,
		uses,
		onedit
	}: {
		memory: Memory;
		source: { href: string; label: string } | null;
		uses: number;
		onedit: () => void;
	} = $props();
</script>

<section class="detail">
	<div class="detail-head">
		<strong>{memory.content}</strong>
		<span class="grow"></span>
		<IconButton icon={IconPencil} label="편집" size="sm" onclick={onedit} />
	</div>
	<div class="meta">
		<span>{app.scopeLabel(memory.scope)}</span>
		<span>{MEMORY_KIND_LABEL[memory.kind]}</span>
		<span>중요도 {memory.importance}</span>
		{#if source}{#if source.href}<a href={source.href}>출처: {source.label}</a>{:else}<span>출처: {source.label}</span>{/if}{/if}
	</div>
	<p class="sub">참고한 답변 {uses}</p>
	<MemoryUses memoryId={memory.id} />
</section>

<style>
	.detail {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
	}
	.detail-head {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		overflow-wrap: anywhere;
	}
	.grow {
		flex: 1;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.detail .meta a {
		color: var(--c-text-3);
	}
	.sub {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
</style>
