<script lang="ts">
	// 고른 기억을 한꺼번에: 범위·종류·중요도 바꾸기, 병합, 삭제
	import { MEMORY_KIND_LABEL } from '#lib/labels.js';
	import MemoryScopeSelect from '#lib/manage/MemoryScopeSelect.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { type Memory, MemoryKind } from '@proprix/shared';

	let {
		count,
		busy,
		onset,
		onmerge,
		onremove,
		onclear
	}: {
		count: number;
		busy: boolean;
		onset: (set: { scope?: string; kind?: Memory['kind']; importance?: number }) => void;
		onmerge: () => void;
		onremove: () => void;
		onclear: () => void;
	} = $props();
</script>

<div class="bulk" role="toolbar" aria-label="고른 기억">
	<strong>{count}개 선택</strong>
	<MemoryScopeSelect
		label="범위 바꾸기"
		placeholder="범위 바꾸기"
		disabled={busy}
		onpick={(scope) => {
			if (scope) onset({ scope });
		}}
	/>
	<select
		aria-label="종류 바꾸기"
		disabled={busy}
		onchange={(e) => {
			const v = e.currentTarget.value as Memory['kind'] | '';
			e.currentTarget.value = '';
			if (v) onset({ kind: v });
		}}
	>
		<option value="">종류 바꾸기</option>
		{#each MemoryKind.options as k (k)}<option value={k}>{MEMORY_KIND_LABEL[k]}</option>{/each}
	</select>
	<select
		aria-label="중요도 바꾸기"
		disabled={busy}
		onchange={(e) => {
			const v = Number(e.currentTarget.value);
			e.currentTarget.value = '';
			if (v) onset({ importance: v });
		}}
	>
		<option value="">중요도 바꾸기</option>
		{#each [5, 4, 3, 2, 1] as n (n)}<option value={n}>{n}</option>{/each}
	</select>
	<span class="grow"></span>
	<Button size="sm" disabled={busy || count < 2} onclick={onmerge}>병합</Button>
	<Button size="sm" variant="danger" disabled={busy} onclick={onremove}>삭제</Button>
	<Button size="sm" onclick={onclear}>선택 해제</Button>
</div>

<style>
	.bulk {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		background: var(--c-surface-2);
		font-size: var(--t-sm);
	}
	.grow {
		flex: 1;
	}
</style>
