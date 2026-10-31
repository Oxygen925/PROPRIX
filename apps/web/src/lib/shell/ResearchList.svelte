<script lang="ts">
	// 리서치 화면의 목록 패널
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import ResearchDialog from '#lib/manage/ResearchDialog.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import ListRow from '#lib/ui/ListRow.svelte';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let creating = $state(false);
	const current = $derived(page.route.id === '/research/[id]' ? (page.params.id ?? '') : '');
</script>

<aside class="list" data-ui="list" aria-label="리서치 목록">
	<header>
		<span class="title">리서치</span>
		<IconButton icon={IconPlus} label="새 리서치" size="sm" onclick={() => (creating = true)} />
	</header>
	<div class="scroll">
		{#each app.researches as r (r.id)}
			<ListRow title={r.title} sub={r.goal} href="/research/{r.id}" active={r.id === current}>
				{#snippet trail()}
					{#if app.researchRunning(r.id)}<i class="busy" aria-label="실행 중"></i>{/if}
				{/snippet}
			</ListRow>
		{:else}
			<p class="empty">아직 리서치가 없습니다.</p>
		{/each}
	</div>
</aside>

<ResearchDialog open={creating} onclose={() => (creating = false)} onsaved={(r) => goto(`/research/${r.id}`)} />

<style>
	.list {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--c-surface-1);
		border-right: 1px solid var(--c-line);
	}
	header {
		display: flex;
		align-items: center;
		padding: 0.625rem 0.5rem 0.375rem 0.875rem;
	}
	.title {
		flex: 1;
		font-weight: var(--w-bold);
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.empty {
		padding: var(--s-2);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.busy {
		display: block;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--c-working);
		animation: blink 1.2s ease-in-out infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
</style>
