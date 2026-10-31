<script lang="ts">
	// 목록의 한 줄: 앞(아바타·아이콘), 제목, 부제, 뒤(상태·버튼). href 를 주면 링크, onclick 이면 버튼
	import type { Snippet } from 'svelte';

	let {
		title,
		sub = '',
		href,
		onclick,
		active = false,
		lead,
		trail
	}: {
		title: string;
		sub?: string;
		href?: string;
		onclick?: () => void;
		active?: boolean;
		lead?: Snippet;
		trail?: Snippet;
	} = $props();
</script>

{#snippet inner()}
	{#if lead}<span class="lead">{@render lead()}</span>{/if}
	<span class="text">
		<span class="title">{title}</span>
		{#if sub}<span class="sub">{sub}</span>{/if}
	</span>
{/snippet}

<!-- 뒤쪽 버튼이 행 버튼 안에 들어가지 않게 나란히 둔다 -->
<div class="row" class:active class:live={!!href || !!onclick}>
	{#if href}
		<a class="hit" {href} aria-current={active ? 'page' : undefined}>{@render inner()}</a>
	{:else if onclick}
		<button type="button" class="hit" {onclick} aria-current={active ? 'true' : undefined}>{@render inner()}</button>
	{:else}
		<div class="hit">{@render inner()}</div>
	{/if}
	{#if trail}<span class="trail">{@render trail()}</span>{/if}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		min-width: 0;
		border-radius: var(--r-2);
		color: var(--c-text-2);
	}
	.row.live:hover {
		background: var(--c-hover);
		color: var(--c-text);
	}
	.row.active {
		background: var(--c-selected);
		color: var(--c-text);
	}
	.hit {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
		padding: 0.3125rem var(--s-2);
		border: none;
		border-radius: var(--r-2);
		background: none;
		color: inherit;
		text-align: left;
		text-decoration: none;
	}
	button.hit:hover:not(:disabled),
	a.hit:hover {
		background: none;
		text-decoration: none;
	}
	.lead,
	.trail {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.trail {
		padding-right: var(--s-1);
	}
	.text {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.title,
	.sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
</style>
