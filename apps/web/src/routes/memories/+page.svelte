<script lang="ts">
	// 기억·메모 (사용자 결정 2026-10-30: 한 화면 + 탭). ?tab=notes 로 메모 탭, ?focus=기억id 는 기억 탭
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import MemoriesTab from '#lib/manage/MemoriesTab.svelte';
	import NotesPanel from '#lib/manage/NotesPanel.svelte';
	import Tabs from '#lib/ui/Tabs.svelte';

	const tab = $derived(page.url.searchParams.get('tab') === 'notes' ? 'notes' : 'memories');
	const select = (t: 'memories' | 'notes') => goto(t === 'notes' ? '/memories?tab=notes' : '/memories', { replaceState: true });
</script>

<div class="wrap">
	<div class="top">
		<h1>기억·메모</h1>
		<Tabs
			tabs={[
				{ id: 'memories', label: '기억', count: app.memories.filter((m) => !m.supersededBy).length || '' },
				{ id: 'notes', label: '메모', count: app.notes.length || '' }
			]}
			active={tab}
			onselect={select}
		/>
	</div>
	<div class="body" class:notes={tab === 'notes'}>
		{#if tab === 'notes'}
			<NotesPanel />
		{:else}
			<MemoriesTab />
		{/if}
	</div>
</div>

<style>
	.wrap {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.top {
		width: 100%;
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5) 0;
		display: grid;
		gap: var(--s-3);
	}
	h1 {
		font-size: var(--t-2xl);
	}
	.body {
		flex: 1;
		min-height: 0;
	}
	.body.notes {
		margin-top: var(--s-3);
		border-top: 1px solid var(--c-line);
	}
</style>
