<script lang="ts">
	// 전체 화면 편집기 틀: 위 막대(뒤로·제목·취소·저장) + 왼쪽 섹션 목록 + 오른쪽 내용
	// 섹션은 내용 안에 id="sec-{id}" 로 둔다
	import Button from '#lib/ui/Button.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import type { Snippet } from 'svelte';

	let {
		title,
		sections,
		saving = false,
		error = '',
		embedded = false,
		onclose,
		onsave,
		children
	}: {
		title: string;
		sections: { id: string; label: string }[];
		saving?: boolean;
		error?: string;
		embedded?: boolean; // 목록 옆에 붙어 있으면 뒤로 화살표가 필요 없다
		onclose: () => void;
		onsave: () => void;
		children: Snippet;
	} = $props();

	let body: HTMLDivElement | undefined = $state();
	let current = $state('');

	function go(id: string) {
		body?.querySelector(`#sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		current = id;
	}

	// 스크롤 위치에 따라 왼쪽 목록 강조
	function onScroll() {
		if (!body) return;
		const top = body.getBoundingClientRect().top + 24;
		let seen = sections[0]?.id ?? '';
		for (const s of sections) {
			const el = body.querySelector(`#sec-${s.id}`);
			if (el && el.getBoundingClientRect().top <= top) seen = s.id;
		}
		current = seen;
	}

	function onKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			onsave();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="shell" onkeydown={onKey}>
	<header>
		{#if !embedded}<IconButton icon={IconArrowLeft} label="목록으로" onclick={onclose} />{/if}
		<h1>{title}</h1>
		<span class="grow"></span>
		{#if error}<span class="error" role="alert">{error}</span>{/if}
		<Button onclick={onclose}>취소</Button>
		<Button variant="primary" disabled={saving} onclick={onsave} title="저장 (Ctrl+S)">저장</Button>
	</header>
	<div class="main">
		<nav aria-label="섹션">
			{#each sections as s (s.id)}
				<button type="button" class:on={(current || sections[0]?.id) === s.id} onclick={() => go(s.id)}>{s.label}</button>
			{/each}
		</nav>
		<div class="body" bind:this={body} onscroll={onScroll}>
			<div class="content">{@render children()}</div>
		</div>
	</div>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--c-line);
		min-height: 3.5rem;
	}
	h1 {
		font-size: var(--t-lg);
	}
	.grow {
		flex: 1;
	}
	.error {
		color: var(--c-danger);
		font-size: var(--t-sm);
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.main {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 11rem minmax(0, 1fr);
	}
	nav {
		display: grid;
		align-content: start;
		gap: 0.125rem;
		padding: var(--s-4) var(--s-2);
		border-right: 1px solid var(--c-line);
	}
	nav button {
		text-align: left;
		padding: var(--s-2) var(--s-3);
		border: none;
		border-radius: var(--r-2);
		background: none;
		color: var(--c-text-3);
	}
	nav button:hover {
		background: var(--c-hover);
		color: var(--c-text);
	}
	nav button.on {
		background: var(--c-selected);
		color: var(--c-text);
	}
	.body {
		overflow-y: auto;
		scroll-padding-top: var(--s-4);
	}
	.content {
		max-width: 44rem;
		padding: var(--s-5) var(--s-5) 40vh;
		display: grid;
		gap: var(--s-6);
	}
	/* 내용 쪽 공통 꼴 (섹션·칸) */
	.content :global(section) {
		display: grid;
		gap: var(--s-3);
	}
	.content :global(section > h2) {
		font-size: var(--t-lg);
	}
	.content :global(.field) {
		display: grid;
		gap: 0.375rem;
	}
	.content :global(.field > span:first-child) {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.content :global(.hint) {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.content :global(.check) {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
	}
	.content :global(.check input) {
		margin-top: 0.3em;
	}
	.content :global(.row) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
	}
	.content :global(textarea) {
		width: 100%;
		resize: vertical;
	}
	.content :global(input:not([type='checkbox']):not([type='color']):not([type='file'])),
	.content :global(select) {
		width: 100%;
	}
	@media (max-width: 1100px) {
		.main {
			grid-template-columns: minmax(0, 1fr);
		}
		nav {
			display: none;
		}
	}
</style>
