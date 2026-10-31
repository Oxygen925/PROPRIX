<script lang="ts">
	// 마크다운 본문: 렌더는 lib/markdown.ts, 여기서는 코드 강조·복사 버튼·외부 링크만 덧붙인다
	import 'katex/dist/katex.min.css';
	import { renderMarkdown } from '#lib/markdown.js';
	import { untrack } from 'svelte';

	let { text }: { text: string } = $props();

	// 스트리밍 중에는 조각마다 파싱하지 않고 간격을 둔다 (화면이 버벅이지 않게). 마지막 글은 반드시 그린다
	const RENDER_MS = 120;
	let html = $state(renderMarkdown(untrack(() => text)));
	let renderedAt = 0;
	$effect(() => {
		const value = text;
		const wait = RENDER_MS - (Date.now() - renderedAt);
		const render = () => {
			html = renderMarkdown(value);
			renderedAt = Date.now();
		};
		if (wait <= 0) return render();
		const t = setTimeout(render, wait);
		return () => clearTimeout(t);
	});
	let box: HTMLDivElement | undefined = $state();

	// {@html} 이 바뀔 때마다 새 DOM 이므로 매번 다시 꾸민다 (스트리밍 중에도)
	$effect(() => {
		void html;
		if (box) decorate(box);
	});

	function decorate(root: HTMLElement) {
		for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
			a.target = '_blank';
			a.rel = 'noreferrer noopener';
		}
		const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')];
		for (const code of blocks) addCopy(code);
		const langs = blocks.filter((c) => /\blanguage-/.test(c.className));
		if (langs.length) void highlight(langs);
	}

	function addCopy(code: HTMLElement) {
		const pre = code.parentElement;
		if (!pre || pre.querySelector('.copy')) return;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'copy';
		button.textContent = '복사';
		button.onclick = async () => {
			try {
				await navigator.clipboard.writeText(code.textContent ?? '');
				button.textContent = '복사됨';
			} catch {
				button.textContent = '복사 실패';
			}
			setTimeout(() => (button.textContent = '복사'), 1500);
		};
		pre.append(button);
	}

	// 강조 라이브러리는 코드 블록이 처음 나올 때 불러온다 (첫 화면 번들을 가볍게)
	async function highlight(codes: HTMLElement[]) {
		const { default: hljs } = await import('highlight.js/lib/common');
		hljs.configure({ ignoreUnescapedHTML: true });
		for (const code of codes) {
			if (!code.isConnected || code.dataset.highlighted) continue;
			const lang = /\blanguage-([\w+#-]+)/.exec(code.className)?.[1] ?? '';
			if (hljs.getLanguage(lang)) hljs.highlightElement(code);
		}
	}
</script>

<div class="md" bind:this={box}>{@html html}</div>

<style>
	.md {
		/* 메시지 HTML 이 말풍선 밖을 가리지 못하게 */
		contain: paint;
		overflow-wrap: anywhere;
		line-height: 1.6;
	}
	.md > :global(:first-child) {
		margin-top: 0;
	}
	.md > :global(:last-child) {
		margin-bottom: 0;
	}
	/* 문단 안 줄바꿈도 보이게 (채팅에서는 Shift+Enter 줄바꿈이 그대로 보이는 게 자연스럽다) */
	.md :global(p) {
		margin: 0.5em 0;
		white-space: pre-line;
	}
	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4),
	.md :global(h5),
	.md :global(h6) {
		margin: 0.9em 0 0.4em;
		font-size: var(--t-lg);
		line-height: 1.35;
	}
	.md :global(h1) {
		font-size: var(--t-xl);
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.4em;
	}
	.md :global(li + li) {
		margin-top: 0.2em;
	}
	.md :global(li > p) {
		margin: 0.2em 0;
	}
	.md :global(blockquote) {
		margin: 0.5em 0;
		padding: 0.1em 0 0.1em 0.8em;
		border-left: 3px solid var(--c-line-stronger);
		color: var(--c-text-2);
	}
	.md :global(hr) {
		border: none;
		border-top: 1px solid var(--c-line-strong);
		margin: 0.9em 0;
	}
	.md :global(a) {
		color: var(--c-info);
	}
	.md :global(:not(pre) > code) {
		padding: 0.1em 0.35em;
		border-radius: var(--r-1);
		background: var(--c-surface-3);
		font-size: 0.9em;
	}
	.md :global(pre) {
		position: relative;
		margin: 0.6em 0;
		padding: 0.75em 0.9em;
		border: 1px solid var(--c-line);
		border-radius: var(--r-2);
		background: var(--c-bg);
		overflow-x: auto;
		font-size: var(--t-sm);
		line-height: 1.5;
	}
	.md :global(pre code) {
		white-space: pre;
	}
	.md :global(pre .copy) {
		position: absolute;
		top: 0.4em;
		right: 0.4em;
		padding: 0.15em 0.5em;
		font-size: var(--t-xs);
		color: var(--c-text-3);
		background: var(--c-surface-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-1);
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease);
	}
	.md :global(pre:hover .copy),
	.md :global(pre .copy:focus-visible) {
		opacity: 1;
	}
	.md :global(table) {
		display: block;
		max-width: 100%;
		overflow-x: auto;
		margin: 0.6em 0;
		border-collapse: collapse;
		font-size: var(--t-sm);
	}
	.md :global(th),
	.md :global(td) {
		padding: 0.35em 0.7em;
		border: 1px solid var(--c-line-strong);
		text-align: left;
	}
	.md :global(th) {
		background: var(--c-surface-3);
		font-weight: var(--w-bold);
	}
	.md :global(.math-display) {
		margin: 0.6em 0;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.md :global(input[type='checkbox']) {
		margin: 0 0.3em 0 0;
		vertical-align: middle;
	}

	/* 코드 강조 색 (다크 토큰에 맞춤) */
	.md :global(.hljs-comment),
	.md :global(.hljs-quote) {
		color: var(--c-text-4);
		font-style: italic;
	}
	.md :global(.hljs-keyword),
	.md :global(.hljs-selector-tag),
	.md :global(.hljs-meta .hljs-keyword) {
		color: #c4a7ff;
	}
	.md :global(.hljs-string),
	.md :global(.hljs-regexp),
	.md :global(.hljs-addition) {
		color: #a5d6a7;
	}
	.md :global(.hljs-number),
	.md :global(.hljs-literal),
	.md :global(.hljs-symbol) {
		color: #f5b971;
	}
	.md :global(.hljs-title),
	.md :global(.hljs-section),
	.md :global(.hljs-title.function_) {
		color: #8ab4ff;
	}
	.md :global(.hljs-type),
	.md :global(.hljs-built_in),
	.md :global(.hljs-title.class_) {
		color: #7dd3c0;
	}
	.md :global(.hljs-attr),
	.md :global(.hljs-attribute),
	.md :global(.hljs-variable),
	.md :global(.hljs-template-variable),
	.md :global(.hljs-name),
	.md :global(.hljs-selector-class),
	.md :global(.hljs-selector-id) {
		color: #f0a3c4;
	}
	.md :global(.hljs-meta),
	.md :global(.hljs-params) {
		color: var(--c-text-2);
	}
	.md :global(.hljs-deletion) {
		color: var(--c-danger);
	}
	.md :global(.hljs-emphasis) {
		font-style: italic;
	}
	.md :global(.hljs-strong) {
		font-weight: var(--w-bold);
	}
</style>
