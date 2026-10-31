<script lang="ts">
	// SIWC 승인 버튼 형식: 검정 바탕 + 공식 로고 + 'Continue with ChatGPT'. 테마와 상관없이 색을 고정한다
	import logo from '#lib/assets/chatgpt-logo-white.svg';

	let {
		size = 'md',
		disabled = false,
		onclick
	}: { size?: 'sm' | 'md'; disabled?: boolean; onclick: () => void } = $props();
</script>

<button class={size} type="button" {disabled} {onclick}>
	<img src={logo} alt="" />
	Continue with ChatGPT
</button>

<style>
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		border: 1px solid var(--c-line-strong);
		background: #000;
		color: #fff;
		font-size: var(--t-md);
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease);
	}
	button:hover:not(:disabled) {
		background: #2a2a2a;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.md {
		height: 2rem;
		padding: 0 0.75rem;
		border-radius: var(--r-2);
	}
	.sm {
		height: 1.625rem;
		padding: 0 0.5625rem;
		border-radius: var(--r-1);
		font-size: var(--t-sm);
	}
	img {
		width: 1.2em;
		height: 1.2em;
	}
</style>
