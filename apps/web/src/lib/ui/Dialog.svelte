<script lang="ts">
	// 대화상자: 열리면 안쪽으로 포커스를 옮기고(Tab 은 안에서만 돎), Esc·바깥 클릭으로 닫고, 닫히면 원래 자리로 포커스를 돌린다
	import type { Snippet } from 'svelte';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconButton from './IconButton.svelte';

	let {
		open,
		title,
		onclose,
		width = 440,
		role = 'dialog',
		dismissable = true,
		children,
		footer
	}: {
		open: boolean;
		title: string;
		onclose: () => void;
		width?: number;
		role?: 'dialog' | 'alertdialog';
		dismissable?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let box: HTMLDivElement | undefined = $state();
	const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;

	const focusables = () =>
		box
			? [...box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
					(e) => !e.hasAttribute('disabled')
				)
			: [];

	$effect(() => {
		if (!open) return;
		const before = document.activeElement as HTMLElement | null;
		// 입력칸이 있으면 거기로, 없으면 첫 버튼(닫기 제외)으로
		queueMicrotask(() => {
			const field = box?.querySelector<HTMLElement>('[autofocus], input:not([type="checkbox"]):not([type="radio"]), textarea, select');
			const els = focusables();
			(field ?? els.find((e) => e.closest('.body, footer')) ?? els[0] ?? box)?.focus();
		});
		return () => before?.focus?.();
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && dismissable) {
			e.stopPropagation();
			onclose();
			return;
		}
		if (e.key !== 'Tab') return;
		const els = focusables();
		if (els.length === 0) return;
		const first = els[0] as HTMLElement;
		const last = els[els.length - 1] as HTMLElement;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && dismissable && onclose()}>
		<div
			class="dialog"
			bind:this={box}
			{role}
			aria-modal="true"
			aria-labelledby={titleId}
			tabindex="-1"
			style:max-width="{width / 16}rem"
			onkeydown={onKey}
		>
			<header>
				<h2 id={titleId}>{title}</h2>
				{#if dismissable}<IconButton icon={IconX} label="닫기" size="sm" onclick={onclose} />{/if}
			</header>
			<div class="body">{@render children()}</div>
			{#if footer}<footer>{@render footer()}</footer>{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgb(0 0 0 / 0.6);
		display: grid;
		place-items: center;
		padding: var(--s-4);
		animation: fade var(--dur) var(--ease);
	}
	.dialog {
		width: 100%;
		max-height: calc(100vh - 3rem);
		display: flex;
		flex-direction: column;
		background: var(--c-surface-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-4);
		animation: rise var(--dur) var(--ease);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-4) var(--s-4) var(--s-2) var(--s-5);
	}
	h2 {
		flex: 1;
		font-size: var(--t-lg);
	}
	.body {
		padding: var(--s-2) var(--s-5) var(--s-4);
		overflow-y: auto;
		color: var(--c-text-2);
		display: grid;
		gap: var(--s-3);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-5) var(--s-4);
		border-top: 1px solid var(--c-line);
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(0.375rem) scale(0.99);
		}
	}
</style>
