<script lang="ts">
	// 기억 추가·편집과 병합이 같이 쓰는 범위·종류·중요도 칸
	import { MEMORY_KIND_LABEL } from '#lib/labels.js';
	import MemoryScopeSelect from '#lib/manage/MemoryScopeSelect.svelte';
	import Field from '#lib/ui/Field.svelte';
	import { MemoryKind } from '@proprix/shared';

	let {
		scope = $bindable(),
		kind = $bindable(),
		importance = $bindable()
	}: { scope: string; kind: string; importance: number } = $props();
</script>

<div class="form-row">
	<Field label="범위">
		<MemoryScopeSelect value={scope} onpick={(s) => (scope = s)} />
	</Field>
	<Field label="종류">
		<select bind:value={kind}>
			{#each MemoryKind.options as k (k)}<option value={k}>{MEMORY_KIND_LABEL[k]}</option>{/each}
		</select>
	</Field>
	<Field label="중요도 {importance}">
		<input type="range" min="1" max="5" step="1" bind:value={importance} />
	</Field>
</div>

<style>
	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: var(--s-3);
	}
</style>
