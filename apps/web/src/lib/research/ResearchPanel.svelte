<script lang="ts">
	// 리서치 화면의 오른쪽 에이전트 패널 (P12d): 맡은 에이전트 상태, 읽은 페이지, 저장 위치, 조사 내용·범위·예약
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { shortWhen } from '#lib/manage/ScheduleEditor.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { describeSchedule } from '@proprix/shared';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { fade } from 'svelte/transition';
	import { PAGE_LABEL, runLabel, STAGE, STATUS, when } from './labels.js';
	import { researchView as v } from './view.svelte.js';

	const r = $derived(v.research);
	const ok = $derived(v.pages.filter((p) => p.status === 'ok').length);
	const saved = $derived(v.batch.filter((x) => x.noteId || x.path));
	const MODE: Record<string, string> = { separate: '각자 조사·각자 글', merged: '각자 조사 후 합친 글', shared: '자료 공유·글만 각자' };
	const roleName = (role: string, agentId: string) =>
		role === 'collect' ? '자료 수집' : role === 'merge' ? '합친 글' : (app.agent(agentId)?.name ?? '(삭제한 에이전트)');
</script>

<aside class="panel" data-ui="panel" aria-label="리서치 정보" in:fade|global={{ duration: 180 }}>
	<header>
		<span class="title">에이전트</span>
		<IconButton icon={IconX} label="패널 닫기 (Ctrl+.)" size="sm" onclick={() => app.togglePanel(false)} />
	</header>

	{#if r}
		{#if v.batches.length > 1}
			<label class="pick">
				실행
				<select value={v.batch[0]?.batchId ?? ''} onchange={(e) => (v.batchId = e.currentTarget.value)}>
					{#each v.batches as b (b.key)}
						<option value={b.key}>{when(b.list[0]?.startedAt ?? 0)}</option>
					{/each}
				</select>
			</label>
		{/if}

		<section>
			<ul class="agents">
				{#each v.batch as x (x.id)}
					<li>
						<Avatar agentId={x.agentId} size={1.5} />
						<span class="text">
							<span class="name">{roleName(x.role, x.agentId)}</span>
							<span class="sub">페이지 {x.pages} · 요청 {x.requests}회</span>
						</span>
						<Badge tone={STATUS[x.status].tone}>{x.status === 'running' ? (STAGE[x.stage] ?? '대기 중') : runLabel(x)}</Badge>
					</li>
				{:else}
					{#each r.agentIds as a (a)}
						<li>
							<Avatar agentId={a} size={1.5} />
							<span class="text"><span class="name">{app.agent(a)?.name ?? '(삭제한 에이전트)'}</span></span>
						</li>
					{/each}
				{/each}
			</ul>
		</section>

		<section>
			<h3>읽은 페이지 {ok}{v.pages.length > ok ? ` / 시도 ${v.pages.length}` : ''}</h3>
			{#if v.pages.length}
				<ul class="pages">
					{#each v.pages as p (p.id)}
						<li class:dim={!p.relevant} title={p.summary}>
							<a href={p.url} target="_blank" rel="noreferrer noopener">{p.title}</a>
							<span class="tags">
								{#if PAGE_LABEL[p.status]}<span class="tag">{PAGE_LABEL[p.status]}</span>{/if}
								{#if p.status === 'ok' && !p.relevant}<span class="tag">관련 없음</span>{/if}
								{#if p.depth}<span class="tag">링크 {p.depth}단계</span>{/if}
								{#if r.agentIds.length > 1 && r.mode !== 'shared'}<span class="tag">{app.agent(p.agentId)?.name}</span>{/if}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted">아직 없습니다</p>
			{/if}
		</section>

		{#if saved.length}
			<section>
				<h3>저장 위치</h3>
				<ul class="list">
					{#each saved as x (x.id)}
						<li>
							{#if x.path}<code title={x.path}>{x.path}</code>{:else}<a href="/memories?tab=notes">메모 · {roleName(x.role, x.agentId)}</a>{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section>
			<h3>조사 내용</h3>
			<p>{r.goal}</p>
			{#if r.instruction}<p class="muted">{r.instruction}</p>{/if}
		</section>

		<section>
			<h3>범위</h3>
			<p class="muted">
				페이지 {r.scope.maxPages} · 링크 깊이 {r.scope.depth} · 검색어 {r.scope.queries}{r.agentIds.length > 1 ? ` · ${MODE[r.mode]}` : ''}
			</p>
			{#if r.scope.domains.length}<p class="muted">허용: {r.scope.domains.join(', ')}</p>{/if}
			{#each r.scope.startUrls as u (u)}<p class="muted url" title={u}>{u}</p>{/each}
		</section>

		{#if r.schedule}
			<section>
				<h3>반복 예약</h3>
				<p class="muted">
					{describeSchedule(r.schedule)} · {r.enabled && r.nextRunAt ? `다음 ${shortWhen(r.nextRunAt)}` : '꺼짐'}
				</p>
			</section>
		{/if}
	{/if}
</aside>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		min-height: 0;
		overflow-y: auto;
		background: var(--c-surface-1);
		border-left: 1px solid var(--c-line);
		padding: 0.625rem 1rem 1rem;
	}
	header {
		display: flex;
		align-items: center;
	}
	.title {
		flex: 1;
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	section {
		display: grid;
		gap: 0.375rem;
		min-width: 0;
	}
	h3 {
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
		color: var(--c-text-4);
	}
	section p {
		color: var(--c-text-2);
		font-size: var(--t-sm);
		overflow-wrap: anywhere;
	}
	section p.muted,
	.muted {
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.url {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.pick select {
		flex: 1;
		min-width: 0;
		font-size: var(--t-sm);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-2);
	}
	.agents li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.text {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.name {
		font-size: var(--t-sm);
		font-weight: var(--w-bold);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.pages li {
		display: grid;
		gap: 2px;
		min-width: 0;
		font-size: var(--t-sm);
	}
	.pages li.dim {
		opacity: 0.6;
	}
	.pages a {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.tag {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.tag + .tag::before {
		content: '· ';
	}
	.list {
		font-size: var(--t-sm);
		gap: var(--s-1);
	}
	.list code {
		font-size: var(--t-xs);
		overflow-wrap: anywhere;
	}
</style>
