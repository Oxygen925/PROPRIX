<script lang="ts">
	// 목록 + 상세 2단: 설정·에이전트처럼 왼쪽에서 고르고 오른쪽에서 보는 화면
	import type { Snippet } from 'svelte';

	let { list, children, label = '목록' }: { list: Snippet; children: Snippet; label?: string } = $props();
</script>

<div class="wrap">
	<nav aria-label={label}>{@render list()}</nav>
	<div class="detail">{@render children()}</div>
</div>

<style>
	.wrap {
		display: grid;
		grid-template-columns: var(--list-w) minmax(0, 1fr);
		height: 100%;
		min-height: 0;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-height: 0;
		overflow-y: auto;
		padding: var(--s-3) var(--s-2);
		background: var(--c-surface-1);
		border-right: 1px solid var(--c-line);
	}
	.detail {
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
	}
</style>
