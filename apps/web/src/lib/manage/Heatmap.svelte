<script lang="ts">
	// 사용량 히트맵 격자: 칸 크기를 너비에 맞춰 늘이고 줄여 스크롤 없이 모두 보인다 (주 = 열, 일~토 = 행).
	// 칸에 커서를 올리면 그날 범주별 요청 수와 예산 비율을 띄운다
	import { app } from '#lib/app.svelte.js';
	import { FEATURE_LABEL } from '#lib/labels.js';
	import type { BudgetFeature } from '@proprix/shared';
	import { type Cell, cellSummary, type Grid } from './heatmap.js';

	let {
		grid,
		selected = null,
		onselect,
		compact = false
	}: { grid: Grid; selected?: string | null; onselect?: (c: Cell) => void; compact?: boolean } = $props();

	const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
	const label = (f: string) => FEATURE_LABEL[f as BudgetFeature]?.title ?? (f === 'preview' ? '페르소나 미리보기' : f);

	let box = $state<HTMLDivElement>();
	let tip = $state<{ c: Cell; x: number; y: number; w: number } | null>(null);
	const summary = $derived(tip ? cellSummary(tip.c, app.settings?.budgets ?? {}, label) : null);

	function show(e: Event, c: Cell) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const b = box?.getBoundingClientRect();
		if (!b) return;
		tip = { c, x: r.left - b.left + r.width / 2, y: r.top - b.top, w: b.width };
	}
</script>

<div class="heat" class:compact bind:this={box} style:--weeks={grid.weeks.length}>
	{#if !compact}
		<div class="months" aria-hidden="true">
			{#each grid.months as m (m.col)}<span style:grid-column="{m.col + 2}">{m.label}</span>{/each}
		</div>
	{/if}
	<div class="grid" role="grid" aria-label="날짜별 요청 수">
		{#each WEEKDAYS as w, i (w)}<span class="wd" aria-hidden="true">{i % 2 === 1 ? w : ''}</span>{/each}
		{#each grid.weeks as week, wi (wi)}
			{#each week as c (c.date)}
				{#if c.future}
					<span class="cell future"></span>
				{:else}
					<button
						class="cell l{c.level}"
						class:sel={selected === c.date}
						aria-label={cellSummary(c, {}, label).title}
						onpointerenter={(e) => show(e, c)}
						onpointerleave={() => (tip = null)}
						onfocus={(e) => show(e, c)}
						onblur={() => (tip = null)}
						onclick={() => onselect?.(c)}
					></button>
				{/if}
			{/each}
		{/each}
	</div>
	{#if tip && summary}
		<!-- 가장자리에서는 상자 안쪽으로 붙인다 -->
		<div
			class="tip"
			role="tooltip"
			style:left="{tip.w < 180 ? tip.x : Math.min(Math.max(tip.x, 90), tip.w - 90)}px"
			style:top="{tip.y}px"
		>
			<strong>{summary.title}</strong>
			{#each summary.lines as line, i (i)}<span>{line}</span>{/each}
			{#if summary.lines.length === 0}<span class="muted">요청 없음</span>{/if}
		</div>
	{/if}
</div>

<style>
	.heat {
		--gap: 3px;
		--wd: 1.25rem;
		position: relative;
		display: grid;
		gap: 4px;
		width: 100%;
	}
	.heat.compact {
		--gap: 2px;
		--wd: 0.9rem;
	}
	.months,
	.grid {
		display: grid;
		grid-template-columns: var(--wd) repeat(var(--weeks), minmax(0, 1fr));
		column-gap: var(--gap);
	}
	.months {
		font-size: var(--t-xs);
		color: var(--c-text-3);
		height: 1rem;
	}
	.months span {
		white-space: nowrap;
	}
	.grid {
		grid-template-rows: repeat(7, auto);
		grid-auto-flow: column;
		row-gap: var(--gap);
	}
	.wd {
		font-size: 0.625rem;
		line-height: 1;
		color: var(--c-text-4);
		align-self: center;
	}
	.cell {
		display: block;
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border: none;
		border-radius: 2px;
		background: var(--c-surface-3);
	}
	button.cell:hover,
	button.cell:focus-visible,
	.cell.sel {
		outline: 1px solid var(--c-text-2);
		outline-offset: 1px;
	}
	.cell.future {
		background: none;
	}
	.l1 {
		background: color-mix(in srgb, var(--c-done) 25%, var(--c-surface-2));
	}
	.l2 {
		background: color-mix(in srgb, var(--c-done) 45%, var(--c-surface-2));
	}
	.l3 {
		background: color-mix(in srgb, var(--c-done) 70%, var(--c-surface-2));
	}
	.l4 {
		background: var(--c-done);
	}
	.tip {
		position: absolute;
		z-index: 5;
		transform: translate(-50%, calc(-100% - 6px));
		display: grid;
		gap: 2px;
		min-width: 10rem;
		max-width: 16rem;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-2);
		background: var(--c-surface-3);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
		font-size: var(--t-xs);
		color: var(--c-text-2);
		pointer-events: none;
		white-space: nowrap;
	}
	.tip strong {
		color: var(--c-text);
		font-size: var(--t-sm);
	}
	.muted {
		color: var(--c-text-4);
	}
</style>
