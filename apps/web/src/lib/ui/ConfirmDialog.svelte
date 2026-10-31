<script lang="ts">
	// 되돌리기 어려운 동작의 확인: 본문은 children, 아래에 취소와 위험 버튼. 포커스·Esc·바깥 클릭은 Dialog 그대로
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';
	import Dialog from './Dialog.svelte';

	let {
		open,
		title,
		confirmLabel = '삭제',
		cancelLabel = '취소',
		disabled = false,
		onconfirm,
		onclose,
		children
	}: {
		open: boolean;
		title: string;
		confirmLabel?: string;
		cancelLabel?: string;
		disabled?: boolean;
		onconfirm: () => void;
		onclose: () => void;
		children: Snippet;
	} = $props();
</script>

<Dialog {open} {title} role="alertdialog" {onclose}>
	{@render children()}
	{#snippet footer()}
		<Button onclick={onclose}>{cancelLabel}</Button>
		<Button variant="danger" {disabled} onclick={onconfirm}>{confirmLabel}</Button>
	{/snippet}
</Dialog>
