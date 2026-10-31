<script lang="ts">
	// 활동: 도구 실행 감사 로그 (P10b) · 사용량 히트맵·예산 (P10c) · 예약 작업 (P8, 사용자 결정 2026-10-30 으로 합침).
	// ?tab=usage · ?tab=tasks 로 그 탭 (예산 알림·예약 작업 링크)
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AuditTab from '#lib/manage/AuditTab.svelte';
	import TasksTab from '#lib/manage/TasksTab.svelte';
	import UsageTab from '#lib/manage/UsageTab.svelte';
	import Tabs from '#lib/ui/Tabs.svelte';

	type Tab = 'tools' | 'usage' | 'tasks';
	const tab = $derived<Tab>((['usage', 'tasks'] as const).find((t) => t === page.url.searchParams.get('tab')) ?? 'tools');
	const select = (t: Tab) => goto(t === 'tools' ? '/activity' : `/activity?tab=${t}`, { replaceState: true });
</script>

<div class="page">
	<header>
		<h1>활동</h1>
	</header>

	<Tabs
		tabs={[
			{ id: 'tools', label: '도구 실행' },
			{ id: 'usage', label: '사용량' },
			{ id: 'tasks', label: '예약 작업' }
		]}
		active={tab}
		onselect={select}
	/>

	{#if tab === 'usage'}
		<UsageTab />
	{:else if tab === 'tasks'}
		<TasksTab />
	{:else}
		<AuditTab />
	{/if}
</div>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5);
		display: grid;
		align-content: start;
		gap: var(--s-4);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	h1 {
		font-size: var(--t-2xl);
	}
</style>
