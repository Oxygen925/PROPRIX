<script lang="ts">
	// 오른쪽 위에 쌓이는 토스트 (입력창을 가리지 않게)
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { toasts } from './toast.svelte.js';

	const icons = { info: IconInfoCircle, success: IconCheck, error: IconAlertTriangle };
</script>

<div class="toaster" aria-live="polite">
	{#each toasts.items as t (t.id)}
		{@const I = icons[t.kind]}
		<div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
			<I size="1rem" stroke={1.75} aria-hidden="true" />
			<span>{t.text}</span>
			<button type="button" aria-label="닫기" onclick={() => toasts.dismiss(t.id)}>
				<IconX size="0.875rem" stroke={1.75} aria-hidden="true" />
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		top: 0.75rem;
		right: 0.75rem;
		z-index: 60;
		display: grid;
		gap: 0.5rem;
		width: min(22.5rem, calc(100vw - 1.5rem));
	}
	.toast {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.625rem 0.625rem 0.625rem 0.75rem;
		border-radius: var(--r-3);
		background: var(--c-surface-3);
		border: 1px solid var(--c-line-strong);
		color: var(--c-text);
		font-size: var(--t-md);
		animation: in var(--dur) var(--ease);
	}
	.toast span {
		flex: 1;
		white-space: pre-wrap;
	}
	.success :global(svg:first-child) {
		color: var(--c-done);
	}
	.error {
		border-color: var(--c-danger-line);
	}
	.error :global(svg:first-child) {
		color: var(--c-danger);
	}
	.info :global(svg:first-child) {
		color: var(--c-info);
	}
	button {
		background: none;
		border: none;
		padding: 2px;
		color: var(--c-text-3);
		cursor: pointer;
		border-radius: var(--r-1);
	}
	button:hover {
		color: var(--c-text);
	}
	@keyframes in {
		from {
			opacity: 0;
			transform: translateY(-0.25rem);
		}
	}
</style>
