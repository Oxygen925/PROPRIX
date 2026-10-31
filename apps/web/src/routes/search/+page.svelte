<script lang="ts">
	// 대화 검색: 메시지 원문에서 찾기 + 방·에이전트·기간 거르기. 결과를 누르면 그 방에서 그 메시지로
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import { fullTime } from '#lib/chat/time.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { errorText } from '#lib/ui/toast.svelte.js';
	import type { SearchResult } from '@proprix/shared';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';

	const PERIODS = [
		{ id: '', label: '전체 기간', days: 0 },
		{ id: 'today', label: '오늘', days: 0 },
		{ id: '7', label: '최근 7일', days: 7 },
		{ id: '30', label: '최근 30일', days: 30 },
		{ id: '365', label: '최근 1년', days: 365 }
	] as const;

	let q = $state(page.url.searchParams.get('q') ?? ''); // /search 검색어 로 바로 올 수 있다
	let room = $state('');
	let agent = $state('');
	let period = $state<(typeof PERIODS)[number]['id']>('');
	let limit = $state(50);
	let results = $state<SearchResult[]>([]);
	let more = $state(false);
	let searched = $state(''); // 결과가 나온 검색어 (강조용)
	let loading = $state(false);
	let error = $state('');

	const from = $derived.by(() => {
		if (period === '') return undefined;
		const d = new Date();
		const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		return period === 'today' ? start : start - (Number(period) - 1) * 24 * 60 * 60 * 1000;
	});
	const rooms = $derived([...app.rooms].sort((x, y) => y.updatedAt - x.updatedAt));

	// 입력이 멈추면 찾는다 (필터를 바꾸면 바로)
	let seq = 0;
	$effect(() => {
		const params = { q: q.trim(), room, agent, from, limit };
		if (!params.q) {
			results = [];
			more = false;
			searched = '';
			return;
		}
		const mine = ++seq;
		const t = setTimeout(async () => {
			loading = true;
			try {
				const r = await app.search(params);
				if (mine !== seq) return;
				results = r.results;
				more = r.more;
				searched = params.q;
				error = '';
			} catch (e) {
				if (mine === seq) error = errorText(e);
			} finally {
				if (mine === seq) loading = false;
			}
		}, 250);
		return () => clearTimeout(t);
	});

	// 찾은 글자를 <mark> 로 (HTML 을 만들지 않고 조각으로 나눈다)
	function parts(text: string, needle: string): { t: string; hit: boolean }[] {
		if (!needle) return [{ t: text, hit: false }];
		const out: { t: string; hit: boolean }[] = [];
		const lower = text.toLowerCase();
		const n = needle.toLowerCase();
		let i = 0;
		for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + n.length)) {
			if (at > i) out.push({ t: text.slice(i, at), hit: false });
			out.push({ t: text.slice(at, at + n.length), hit: true });
			i = at + n.length;
		}
		if (i < text.length) out.push({ t: text.slice(i), hit: false });
		return out;
	}

	const when = (t: number) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<div class="page">
	<h1>검색</h1>
	<label class="search">
		<IconSearch size="1.1rem" aria-hidden="true" />
		<!-- svelte-ignore a11y_autofocus -->
		<input bind:value={q} placeholder="채팅 내용에서 검색" aria-label="검색어" autofocus />
	</label>
	<div class="filters">
		<select bind:value={room} aria-label="채팅">
			<option value="">모든 방</option>
			{#each rooms as r (r.id)}
				<option value={r.id}>{r.kind === 'lounge' ? '라운지' : r.title}{r.archived ? ' (보관)' : ''}</option>
			{/each}
		</select>
		<select bind:value={agent} aria-label="에이전트">
			<option value="">모든 에이전트</option>
			{#each app.orderedAgents as a (a.id)}
				<option value={a.id}>{a.name}</option>
			{/each}
		</select>
		<select bind:value={period} aria-label="기간">
			{#each PERIODS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
		</select>
		{#if searched}<span class="count">{results.length}{more ? '+' : ''}건</span>{/if}
	</div>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{:else if !q.trim()}
		<EmptyState icon={IconSearch} title="채팅에서 검색" body="모든 채팅의 메시지를 글자 그대로 검색합니다. 보관한 채팅도 포함합니다." />
	{:else if searched && results.length === 0 && !loading}
		<EmptyState icon={IconSearch} title="찾는 내용이 없어요" body="다른 말로 찾거나 필터를 넓혀 보세요." />
	{:else}
		<ul class="results" aria-busy={loading}>
			{#each results as r (r.messageId)}
				<li>
					<button onclick={() => goto(`/rooms/${r.roomId}?m=${r.messageId}`)}>
						{#if r.role === 'user'}
							<span class="me" aria-hidden="true"><IconUser size="0.9rem" /></span>
						{:else}
							<Avatar agentId={r.agentId} size={1.1} />
						{/if}
						<span class="body">
							<span class="meta">
								<span class="who">{r.role === 'user' ? '나' : app.look(r.agentId).name}</span>
								<span>· {r.roomTitle}</span>
								<time datetime={new Date(r.createdAt).toISOString()} title={fullTime(r.createdAt)}>{when(r.createdAt)}</time>
							</span>
							<span class="snippet">
								{#each parts(r.snippet, searched) as p, i (i)}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}
							</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if more}
			<div class="more"><Button size="sm" onclick={() => (limit += 50)}>더 보기</Button></div>
		{/if}
	{/if}
</div>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5);
		display: grid;
		align-content: start;
		gap: var(--s-3);
	}
	h1 {
		font-size: var(--t-2xl);
	}
	.search {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: 0 var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		background: var(--c-surface-2);
		color: var(--c-text-3);
	}
	.search:focus-within {
		border-color: var(--c-line-stronger);
	}
	.search input {
		flex: 1;
		border: none;
		background: transparent;
		padding: var(--s-3) 0;
		font-size: var(--t-lg);
	}
	.search input:focus-visible {
		box-shadow: none;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.count {
		margin-left: auto;
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.results {
		list-style: none;
		margin: var(--s-2) 0 0;
		padding: 0;
		display: grid;
	}
	.results button {
		width: 100%;
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
		padding: var(--s-3);
		border: none;
		border-bottom: 1px solid var(--c-line);
		border-radius: 0;
		background: none;
		text-align: left;
	}
	.results button:hover {
		background: var(--c-hover);
	}
	.me {
		display: grid;
		place-items: center;
		flex: none;
		width: calc(1.1rem * 1.8 / 1.3);
		height: calc(1.1rem * 1.8 / 1.3);
		border-radius: 50%;
		background: var(--c-surface-3);
		color: var(--c-text-3);
	}
	.body {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.who {
		color: var(--c-text-2);
		font-weight: var(--w-bold);
	}
	.meta time {
		margin-left: var(--s-2);
		color: var(--c-text-4);
	}
	.snippet {
		color: var(--c-text-2);
		overflow-wrap: anywhere;
	}
	mark {
		background: rgb(245 165 36 / 0.25);
		color: var(--c-text);
		border-radius: 0.15rem;
		padding: 0 0.1rem;
	}
	.more {
		display: flex;
		justify-content: center;
		padding: var(--s-3);
	}
	.error {
		color: var(--c-danger);
	}
</style>
