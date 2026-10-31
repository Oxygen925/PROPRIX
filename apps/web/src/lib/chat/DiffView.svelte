<script lang="ts">
	// 줄 단위 diff (승인 카드·이벤트 줄): 추가·삭제를 색으로. 길면 앞부분만 보이고 '전체 보기'로 펼친다
	let { text, lines = 40 }: { text: string; lines?: number } = $props();

	let all = $state(false);
	const rows = $derived(text.split('\n'));
	const shown = $derived(all ? rows : rows.slice(0, lines));
	const kind = (l: string) =>
		l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('+++') || l.startsWith('---') ? 'meta' : '';
	const counts = $derived({
		add: rows.filter((l) => kind(l) === 'add').length,
		del: rows.filter((l) => kind(l) === 'del').length
	});
</script>

<div class="diff">
	<div class="stat"><span class="a">+{counts.add}</span> <span class="d">−{counts.del}</span></div>
	<pre>{#each shown as l, i (i)}<span class="line {kind(l)}">{l || ' '}</span>{/each}</pre>
	{#if rows.length > lines}
		<button type="button" class="more" onclick={() => (all = !all)}>
			{all ? '접기' : `전체 보기 (${rows.length}줄)`}
		</button>
	{/if}
</div>

<style>
	.diff {
		margin-top: var(--s-2);
		border: 1px solid var(--c-line);
		border-radius: var(--r-2);
		background: var(--c-bg);
		overflow: hidden;
	}
	.stat {
		padding: 0.15rem var(--s-2);
		font-size: var(--t-xs);
		border-bottom: 1px solid var(--c-line);
		color: var(--c-text-3);
	}
	.a {
		color: var(--c-done);
	}
	.d {
		color: var(--c-danger);
	}
	pre {
		margin: 0;
		padding: var(--s-1) 0;
		max-height: 24rem;
		overflow: auto;
		font-size: var(--t-xs);
		line-height: 1.5;
	}
	.line {
		display: block;
		padding: 0 var(--s-2);
		white-space: pre;
	}
	.add {
		background: rgb(74 222 128 / 0.12);
		color: #b7f7cd;
	}
	.del {
		background: rgb(248 113 113 / 0.12);
		color: #ffc4c4;
	}
	.hunk {
		color: var(--c-info);
	}
	.meta {
		color: var(--c-text-4);
	}
	.more {
		width: 100%;
		padding: var(--s-1);
		border: none;
		border-top: 1px solid var(--c-line);
		border-radius: 0;
		background: var(--c-surface-1);
		color: var(--c-text-3);
		font-size: var(--t-xs);
	}
</style>
