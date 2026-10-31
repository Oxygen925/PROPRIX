<script lang="ts" module>
	import type { Icon } from '@tabler/icons-svelte-runes';

	export interface MenuItem {
		label: string;
		icon?: Icon;
		danger?: boolean;
		disabled?: boolean;
		hint?: string; // 오른쪽 작은 글자 (단축키 등)
		onSelect: () => void;
	}
</script>

<script lang="ts">
	// 버튼 아래에 뜨는 메뉴: 위·아래 화살표로 이동, Enter 선택, Esc·바깥 클릭으로 닫힘
	import type { Snippet } from 'svelte';

	let {
		items,
		align = 'end',
		side = 'bottom',
		trigger
	}: {
		items: MenuItem[];
		align?: 'start' | 'end';
		side?: 'bottom' | 'top'; // top: 버튼 위로 연다 (화면 아래쪽의 입력창 등)
		trigger: Snippet<[{ open: boolean; toggle: () => void; props: Record<string, unknown> }]>;
	} = $props();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let list: HTMLDivElement | undefined = $state();
	const id = `menu-${Math.random().toString(36).slice(2, 8)}`;

	const buttons = () => (list ? [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : []);

	function toggle() {
		open = !open;
		if (open) queueMicrotask(() => buttons()[0]?.focus());
	}

	function close(refocus = true) {
		open = false;
		if (refocus) root?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		const els = buttons();
		const i = els.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			els[(i + 1) % els.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			els[(i - 1 + els.length) % els.length]?.focus();
		}
	}

	$effect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) close(false);
		};
		document.addEventListener('pointerdown', onDown);
		return () => document.removeEventListener('pointerdown', onDown);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-root" bind:this={root} onkeydown={onKey}>
	{@render trigger({
		open,
		toggle,
		props: { 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id }
	})}
	{#if open}
		<div class="menu {align} {side}" role="menu" {id} bind:this={list}>
			{#each items as item (item.label)}
				{@const I = item.icon}
				<button
					type="button"
					role="menuitem"
					class:danger={item.danger}
					disabled={item.disabled}
					onclick={() => {
						close(false);
						item.onSelect();
					}}
				>
					{#if I}<I size="0.9375rem" stroke={1.75} aria-hidden="true" />{/if}
					<span class="label">{item.label}</span>
					{#if item.hint}<span class="hint">{item.hint}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.menu-root {
		position: relative;
		display: inline-flex;
	}
	.menu {
		position: absolute;
		top: calc(100% + 0.25rem);
		z-index: 40;
		min-width: 11.875rem;
		padding: 0.25rem;
		background: var(--c-surface-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		display: grid;
		animation: pop var(--dur-fast) var(--ease);
	}
	.top {
		top: auto;
		bottom: calc(100% + 0.25rem);
		max-height: 60vh;
		overflow-y: auto;
		animation-name: pop-up;
	}
	.end {
		right: 0;
	}
	.start {
		left: 0;
	}
	button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: none;
		border: none;
		border-radius: var(--r-1);
		padding: 0.4375rem 0.5625rem;
		color: var(--c-text-2);
		text-align: left;
		font-size: var(--t-md);
	}
	button:hover:not(:disabled),
	button:focus-visible {
		background: var(--c-hover);
		color: var(--c-text);
		box-shadow: none;
	}
	.label {
		flex: 1;
	}
	.hint {
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.danger {
		color: var(--c-danger);
	}
	.danger:hover:not(:disabled) {
		color: var(--c-danger);
		background: var(--c-danger-bg);
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(-0.1875rem);
		}
	}
	@keyframes pop-up {
		from {
			opacity: 0;
			transform: translateY(0.1875rem);
		}
	}
</style>
