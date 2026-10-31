<script lang="ts">
	// 기억 범위 고르기 (공용 + 에이전트). 값은 onpick 으로 올리고, select 는 늘 받은 value 를 보인다.
	// value 를 그대로 두면 고른 뒤 처음 항목으로 돌아가므로 '바꾸기' 메뉴로도 쓴다
	import { app } from '#lib/app.svelte.js';
	import { SHARED_SCOPE } from '@proprix/shared';

	let {
		value = '',
		placeholder,
		label,
		disabled = false,
		onpick
	}: { value?: string; placeholder?: string; label?: string; disabled?: boolean; onpick: (scope: string) => void } = $props();

	const scopes = $derived([SHARED_SCOPE, ...app.agents.map((a) => a.id)]);
</script>

<select
	{value}
	{disabled}
	aria-label={label}
	onchange={(e) => {
		onpick(e.currentTarget.value);
		e.currentTarget.value = value;
	}}
>
	{#if placeholder !== undefined}<option value="">{placeholder}</option>{/if}
	{#each scopes as s (s)}<option value={s}>{app.scopeLabel(s)}</option>{/each}
</select>
