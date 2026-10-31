<script lang="ts">
	// 버튼: primary(화면당 하나) / secondary(기본) / ghost(도구 막대·목록) / danger
	import type { Icon } from '@tabler/icons-svelte-runes';
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		full = false,
		children,
		...rest
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		icon?: Icon;
		full?: boolean;
		children?: Snippet;
	} & HTMLButtonAttributes = $props();
</script>

<button class="btn {variant} {size}" class:full type="button" {...rest}>
	{#if icon}{@const I = icon}<I size={size === 'sm' ? "0.875rem" : "1rem"} stroke={1.75} aria-hidden="true" />{/if}
	{@render children?.()}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		border-radius: var(--r-2);
		border: 1px solid transparent;
		font-size: var(--t-md);
		font-weight: var(--w-regular);
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease),
			transform 80ms var(--ease);
	}
	button:active:not(:disabled) {
		transform: scale(0.97);
	}
	.md {
		height: 2rem;
		padding: 0 0.75rem;
	}
	.sm {
		height: 1.625rem;
		padding: 0 0.5625rem;
		font-size: var(--t-sm);
		border-radius: var(--r-1);
	}
	.full {
		width: 100%;
	}
	.primary {
		background: var(--c-primary);
		color: var(--c-on-primary);
	}
	.primary:hover:not(:disabled) {
		background: var(--c-primary-hover);
	}
	.secondary {
		background: transparent;
		border-color: var(--c-line-strong);
		color: var(--c-text);
	}
	.secondary:hover:not(:disabled) {
		background: var(--c-hover);
		border-color: var(--c-line-stronger);
	}
	.ghost {
		background: transparent;
		color: var(--c-text-2);
	}
	.ghost:hover:not(:disabled) {
		background: var(--c-hover);
		color: var(--c-text);
	}
	.danger {
		background: transparent;
		border-color: var(--c-danger-line);
		color: var(--c-danger);
	}
	.danger:hover:not(:disabled) {
		background: var(--c-danger-bg);
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
