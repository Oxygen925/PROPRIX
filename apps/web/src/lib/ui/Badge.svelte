<script lang="ts">
	// 작은 라벨: 상태색은 의미가 있을 때만 (작업 중·확인 필요·완료·오류·정보)
	import type { Snippet } from 'svelte';

	let {
		tone = 'neutral',
		children
	}: { tone?: 'neutral' | 'working' | 'waiting' | 'done' | 'danger' | 'info'; children: Snippet } = $props();
</script>

<span class="badge {tone}">{@render children()}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.25rem;
		padding: 0 0.4375rem;
		border-radius: var(--r-1);
		font-size: var(--t-xs);
		white-space: nowrap;
		border: 1px solid var(--c-line-strong);
		color: var(--c-text-2);
	}
	.working {
		color: var(--c-working);
		background: var(--c-working-bg);
		border-color: transparent;
	}
	.waiting {
		color: var(--c-waiting);
		background: var(--c-waiting-bg);
		border-color: var(--c-waiting-line);
	}
	.done {
		color: var(--c-done);
		background: var(--c-done-bg);
		border-color: transparent;
	}
	.danger {
		color: var(--c-danger);
		background: var(--c-danger-bg);
		border-color: var(--c-danger-line);
	}
	.info {
		color: var(--c-info);
		background: var(--c-info-bg);
		border-color: transparent;
	}
</style>
