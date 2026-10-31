<script lang="ts">
	// 아이콘만 있는 버튼: label 은 화면 낭독기·툴팁에 쓰인다 (필수)
	import type { Icon } from '@tabler/icons-svelte-runes';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	let {
		icon,
		label,
		size = 'md',
		active = false,
		...rest
	}: { icon: Icon; label: string; size?: 'sm' | 'md'; active?: boolean } & HTMLButtonAttributes = $props();
	const I = $derived(icon);
</script>

<button class="ib {size}" class:active type="button" aria-label={label} title={label} {...rest}>
	<I size={size === 'sm' ? "0.9375rem" : "1.125rem"} stroke={1.75} aria-hidden="true" />
</button>

<style>
	.ib {
		display: inline-grid;
		place-items: center;
		background: transparent;
		border: none;
		border-radius: var(--r-2);
		color: var(--c-text-3);
		cursor: pointer;
		padding: 0;
		transition:
			background var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease),
			transform 80ms var(--ease);
	}
	button:active:not(:disabled) {
		transform: scale(0.92);
	}
	.md {
		width: 2rem;
		height: 2rem;
	}
	.sm {
		width: 1.625rem;
		height: 1.625rem;
		border-radius: var(--r-1);
	}
	.ib:hover:not(:disabled),
	.active {
		background: var(--c-hover);
		color: var(--c-text);
	}
	.ib:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
