<script lang="ts">
	// 사용량 (P10c): 최근 1년 날짜별 요청 수 히트맵 (범주로 거르기) + 오늘 일일 예산. 80%·100% 알림은 app 이 띄운다
	import { app } from '#lib/app.svelte.js';
	import { FEATURE_LABEL } from '#lib/labels.js';
	import { toastError } from '#lib/ui/toast.svelte.js';
	import type { BudgetFeature, UsageHistory } from '@proprix/shared';
	import { untrack } from 'svelte';
	import Heatmap from './Heatmap.svelte';
	import { buildGrid, type Cell, cellSummary, USAGE_GROUPS, type UsageGroupKey } from './heatmap.js';

	let history = $state<UsageHistory | null>(null);
	let group = $state<UsageGroupKey>('all');
	let selected = $state<Cell | null>(null);

	async function load() {
		try {
			[history] = await Promise.all([app.loadUsageHistory(371), app.loadUsage()]);
		} catch (e) {
			toastError(e);
		}
	}
	// 처음 + 예산 알림이 올 때마다 다시 읽는다
	$effect(() => {
		void app.usageAlerts;
		untrack(() => void load());
	});

	const features = $derived(USAGE_GROUPS.find((g) => g.key === group)?.features ?? null);
	const grid = $derived(history ? buildGrid(history.days, new Date(), features) : null);

	const label = (f: string) => FEATURE_LABEL[f as BudgetFeature]?.title ?? (f === 'preview' ? '페르소나 미리보기' : f);
	const share = (used: number, limit: number | null) => (limit ? Math.min(1, used / limit) : 0);
	const detail = $derived(selected ? cellSummary(selected, app.settings?.budgets ?? {}, label, 20) : null);
</script>

<div class="chips" role="radiogroup" aria-label="범주">
	{#each USAGE_GROUPS as g (g.key)}
		<button role="radio" aria-checked={group === g.key} class:on={group === g.key} onclick={() => (group = g.key)}>
			{g.label}
		</button>
	{/each}
</div>

{#if grid}
	<section class="heat">
		<p class="sum">최근 1년 <strong>{grid.total.toLocaleString()}</strong>회 요청 · 칸에 커서를 올리면 그날 예산 사용이 보입니다</p>
		<Heatmap {grid} selected={selected?.date ?? null} onselect={(c) => (selected = selected?.date === c.date ? null : c)} />
		<div class="legend" aria-hidden="true">
			적음 {#each [0, 1, 2, 3, 4] as l (l)}<span class="sw l{l}"></span>{/each} 많음
		</div>
		{#if detail}
			<div class="detail">
				<strong>{detail.title}</strong>
				{#if detail.lines.length === 0}
					<p class="muted">요청이 없었습니다.</p>
				{:else}
					<ul>
						{#each detail.lines as line, i (i)}<li>{line}</li>{/each}
					</ul>
				{/if}
				<p class="muted">예산 비율은 지금 설정한 일일 예산 기준입니다.</p>
			</div>
		{/if}
	</section>
{/if}

{#if app.usage}
	<section class="budget">
		<h2>오늘 예산</h2>
		<p class="hint">로컬 자정에 초기화됩니다. 80%·100% 에 닿으면 알림을 보냅니다. 상한은 설정에서 바꿉니다.</p>
		<ul>
			{#each app.usage.features as f (f.feature)}
				{@const s = share(f.used, f.limit)}
				<li class:warn={f.limit !== null && s >= 0.8 && s < 1} class:full={f.limit !== null && s >= 1}>
					<span class="name">{label(f.feature)}</span>
					<span class="bar"><span style:width="{s * 100}%"></span></span>
					<span class="n">{f.used}{f.limit === null ? '' : ` / ${f.limit}`}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.chips button {
		padding: 0.25rem 0.625rem;
		border: 1px solid var(--c-line);
		border-radius: 999px;
		background: none;
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.chips button.on {
		color: var(--c-text);
		border-color: var(--c-line-stronger);
		background: var(--c-surface-2);
	}
	.heat {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
	}
	.sum {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.legend {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 3px;
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.sw {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 2px;
		background: var(--c-surface-3);
	}
	.sw.l1 {
		background: color-mix(in srgb, var(--c-done) 25%, var(--c-surface-2));
	}
	.sw.l2 {
		background: color-mix(in srgb, var(--c-done) 45%, var(--c-surface-2));
	}
	.sw.l3 {
		background: color-mix(in srgb, var(--c-done) 70%, var(--c-surface-2));
	}
	.sw.l4 {
		background: var(--c-done);
	}
	.detail {
		display: grid;
		gap: var(--s-1);
		padding-top: var(--s-2);
		border-top: 1px solid var(--c-line);
		font-size: var(--t-sm);
	}
	.detail ul,
	.budget ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
	}
	.detail li {
		color: var(--c-text-2);
		font-variant-numeric: tabular-nums;
	}
	.muted,
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.detail .muted {
		font-size: var(--t-xs);
	}
	.n {
		color: var(--c-text-2);
		font-variant-numeric: tabular-nums;
	}
	.budget {
		display: grid;
		gap: var(--s-2);
	}
	h2 {
		font-size: var(--t-md);
	}
	.budget li {
		display: grid;
		grid-template-columns: 8rem 1fr 5.5rem;
		align-items: center;
		gap: var(--s-3);
		font-size: var(--t-sm);
	}
	.budget .n {
		text-align: right;
	}
	.bar {
		height: 6px;
		border-radius: 999px;
		background: var(--c-surface-3);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--c-text-3);
	}
	.warn .bar span {
		background: var(--c-waiting);
	}
	.warn .n {
		color: var(--c-waiting);
	}
	.full .bar span {
		background: var(--c-danger);
	}
	.full .n {
		color: var(--c-danger);
	}
</style>
