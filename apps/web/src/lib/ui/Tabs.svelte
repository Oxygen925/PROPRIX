<script lang="ts" generics="T extends string">
	// 화면 위의 탭 줄. 고른 탭을 어디에 둘지(주소·상태)는 쓰는 쪽이 정한다
	let {
		tabs,
		active,
		onselect
	}: {
		tabs: { id: T; label: string; count?: number | string }[];
		active: T;
		onselect: (id: T) => void;
	} = $props();
</script>

<div class="tabs" role="tablist" aria-label="보기">
	{#each tabs as t (t.id)}
		<button role="tab" aria-selected={active === t.id} class:on={active === t.id} onclick={() => onselect(t.id)}>
			{t.label}{#if t.count !== undefined}{' '}<span class="n">{t.count}</span>{/if}
		</button>
	{/each}
</div>

<style>
	.tabs {
		display: flex;
		gap: var(--s-1);
		border-bottom: 1px solid var(--c-line);
	}
	.tabs button {
		padding: var(--s-2) var(--s-3);
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: none;
		color: var(--c-text-3);
		margin-bottom: -1px;
	}
	.tabs button.on {
		color: var(--c-text);
		border-bottom-color: var(--c-text);
	}
	.n {
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
</style>
