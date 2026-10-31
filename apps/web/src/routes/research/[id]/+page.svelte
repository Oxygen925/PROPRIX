<script lang="ts">
	// 리서치 화면 (P12d, 사용자 결정 2026-10-30): 채팅과 같은 구조. 행동 로그·결과 글·대화가 시간순 한 흐름에 나오고,
	// 작은 정보(읽은 페이지 등)는 오른쪽 에이전트 패널에 둔다. 입력창은 ResearchComposer
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import ResearchDialog from '#lib/manage/ResearchDialog.svelte';
	import { clock, reasonText, runLabel, STAGE, when } from '#lib/research/labels.js';
	import ResearchComposer from '#lib/research/ResearchComposer.svelte';
	import { researchView as v } from '#lib/research/view.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { Research, ResearchRun } from '@proprix/shared';
	import IconCalendarOff from '@tabler/icons-svelte-runes/icons/calendar-off';
	import IconCalendarRepeat from '@tabler/icons-svelte-runes/icons/calendar-repeat';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconLayoutSidebarRight from '@tabler/icons-svelte-runes/icons/layout-sidebar-right';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconWorldSearch from '@tabler/icons-svelte-runes/icons/world-search';
	import { tick, untrack } from 'svelte';

	const id = $derived(page.params.id ?? '');
	const r = $derived(v.research);

	let list = $state<HTMLElement | undefined>();
	let editing = $state(false);
	let removing = $state(false);

	const name = (agentId: string) => app.agent(agentId)?.name ?? '(삭제한 에이전트)';
	const whoLabel = (run: ResearchRun) => (run.role === 'merge' ? `${name(run.agentId)} · 합친 글` : run.role === 'collect' ? `${name(run.agentId)} · 자료 수집` : name(run.agentId));

	// 다른 리서치로 옮겼을 때
	$effect(() => {
		const rid = id;
		untrack(() => {
			v.batchId = '';
			v.runs = [];
			v.events = [];
			v.messages = [];
			v.pages = [];
			void v.load(rid).then(() => tick().then(() => list?.scrollTo({ top: list.scrollHeight }))).catch(toastError);
		});
	});

	// 새 실행이 시작되면 목록을 다시 읽는다
	$effect(() => {
		const live = app.researchLive[id];
		if (!live?.length) return;
		untrack(() => {
			if (live.some((x) => !v.runs.some((y) => y.id === x.id))) {
				v.batchId = '';
				void v.load(id).catch(toastError);
			}
		});
	});

	// 패널의 읽은 페이지: 페이지 수가 바뀌면 다시 읽는다
	const pageKey = $derived(v.batch.map((x) => `${x.id}:${x.pages}:${x.status}`).join());
	$effect(() => {
		void pageKey;
		untrack(() => void v.loadPages().catch(() => {}));
	});

	// 채팅처럼 아래를 따라간다 (위로 올려 보는 중이면 그대로)
	$effect(() => {
		void v.items.length;
		void v.allMessages.at(-1)?.text;
		void v.current.map((x) => x.stage).join();
		const box = list;
		if (!box) return;
		if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) void tick().then(() => box.scrollTo({ top: box.scrollHeight }));
	});

	async function toggleSchedule(x: Research) {
		try {
			const { title, goal, instruction, agentIds, mode: m, scope, output, schedule } = x;
			await app.saveResearch(x.id, { title, goal, instruction, agentIds, mode: m, scope, output, schedule, enabled: !x.enabled });
			toast(x.enabled ? '반복 예약을 껐습니다' : '반복 예약을 켰습니다', 'success');
		} catch (e) {
			toastError(e);
		}
	}

	const items = (x: Research): MenuItem[] => [
		{ label: '편집', icon: IconPencil, disabled: v.running, onSelect: () => (editing = true) },
		...(x.schedule
			? [{ label: x.enabled ? '예약 끄기' : '예약 켜기', icon: x.enabled ? IconCalendarOff : IconCalendarRepeat, onSelect: () => toggleSchedule(x) }]
			: []),
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = true) }
	];

	async function remove() {
		removing = false;
		try {
			await app.deleteResearch(id);
			toast('리서치를 삭제했습니다', 'success');
			await goto('/');
		} catch (e) {
			toastError(e);
		}
	}

	async function revertFile(x: ResearchRun) {
		try {
			await app.restoreChange(x.changeId);
			toast(`${x.path} 을(를) 되돌렸습니다`, 'success');
		} catch (e) {
			toastError(e);
		}
	}
</script>

{#if !r}
	{#if app.researches.length}
		<EmptyState icon={IconWorldSearch} title="리서치를 찾을 수 없어요" body="삭제됐거나 잘못된 주소입니다." />
	{/if}
{:else}
	<section class="chat">
		<header>
			<span class="stack" aria-hidden="true">
				{#each r.agentIds.slice(0, 3) as a (a)}<Avatar agentId={a} size={r.agentIds.length > 1 ? 1.5 : 1.75} />{/each}
			</span>
			<div class="titles">
				<div class="name">{r.title}</div>
				<div class="sub">{r.agentIds.map(name).join(', ')}</div>
			</div>
			<Menu items={items(r)}>
				{#snippet trigger({ toggle, props })}
					<IconButton icon={IconDots} label="리서치 메뉴" onclick={toggle} {...props} />
				{/snippet}
			</Menu>
			<IconButton icon={IconLayoutSidebarRight} label="패널 (Ctrl+.)" active={app.panelOpen} onclick={() => app.togglePanel()} />
		</header>

		{#if app.browser && !app.browser.installed}
			<div class="notice">
				<span>리서치는 전용 브라우저로 웹 페이지를 읽습니다. 설정에서 먼저 설치하세요 (약 {Math.round(app.browser.downloadSize / 1_048_576)}MB).</span>
				<Button size="sm" onclick={() => goto('/settings?s=research')}>설정으로</Button>
			</div>
		{/if}

		<div class="messages" bind:this={list} aria-live="polite" aria-relevant="additions">
			{#if v.items.length === 0 && !v.loading}
				<p class="empty">아래에서 조사를 시작하세요.</p>
			{/if}
			{#each v.items as it (it.key)}
				{#if it.k === 'start'}
					<div class="day">{when(it.at)} 조사 시작{it.agents > 1 ? ` · ${it.agents}개 실행` : ''}</div>
				{:else if it.k === 'log'}
					<div class="log">
						<div class="who">
							<Avatar agentId={it.run.agentId} size={1.25} />
							<span class="who-name">{whoLabel(it.run)}</span>
							<time>{clock(it.at)}</time>
						</div>
						<ol>
							{#each it.lines as e (e.id)}
								<li class={e.kind}>{e.text}</li>
							{/each}
						</ol>
					</div>
				{:else if it.k === 'result'}
					<div class="msg" class:dim={it.run.status === 'skipped'} style:--agent={app.look(it.run.agentId).color}>
						<div class="who">
							<Avatar agentId={it.run.agentId} size={1.25} />
							<span class="who-name">{whoLabel(it.run)}</span>
							<time>{clock(it.at)}</time>
							{#if it.run.status !== 'done'}<span class="tag">{runLabel(it.run)}</span>{/if}
						</div>
						<Markdown text={it.run.result} />
						{#if it.run.noteId || it.run.path}
							<div class="saved">
								{#if it.run.noteId}메모로 저장했습니다 · <a href="/memories?tab=notes">메모 보기</a>{/if}
								{#if it.run.path}<code>{it.run.path}</code> 로 저장했습니다
									<Button size="sm" onclick={() => revertFile(it.run)}>되돌리기</Button>{/if}
							</div>
						{/if}
					</div>
				{:else if it.k === 'note'}
					<div class="day">
						{whoLabel(it.run)} · {runLabel(it.run)}{it.run.error ? ` · ${reasonText(it.run.error)}` : ''}
					</div>
				{:else}
					{@const m = it.m}
					{#if m.role === 'user'}
						<div class="msg user">{#if m.kind === 'instruction'}<div class="tag">조사 지시</div>{/if}{m.text}</div>
					{:else}
						<div class="msg" class:failed={m.status === 'failed'} style:--agent={app.look(m.agentId).color}>
							<div class="who">
								<Avatar agentId={m.agentId} size={1.25} />
								<span class="who-name">{name(m.agentId)}</span>
								<time>{clock(m.at)}</time>
							</div>
							{#if m.text}<Markdown text={m.text} />{:else}<div class="typing" aria-label="답을 쓰는 중"><span></span><span></span><span></span></div>{/if}
						</div>
					{/if}
				{/if}
			{/each}
			{#each v.current.filter((x) => x.status === 'running') as x (x.id)}
				<div class="working">
					<Avatar agentId={x.agentId} size={1.1} />
					{whoLabel(x)} · {STAGE[x.stage] ?? '대기 중'}
					<span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>
				</div>
			{/each}
		</div>

		<ResearchComposer onedit={() => (editing = true)} />

		<ResearchDialog open={editing} research={r} onclose={() => (editing = false)} />
		<ConfirmDialog open={removing} title="리서치 삭제" onconfirm={remove} onclose={() => (removing = false)}>
			<p>'{r.title}' 과(와) 실행 기록·채팅을 삭제할까요? 이미 저장한 메모·파일은 남습니다.</p>
		</ConfirmDialog>
	</section>
{/if}

<style>
	.chat {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--c-line);
	}
	.stack {
		display: flex;
	}
	.stack > :global(*:not(:first-child)) {
		margin-left: -0.5rem;
	}
	.titles {
		flex: 1;
		min-width: 0;
	}
	.name,
	.sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		font-weight: var(--w-bold);
	}
	.sub {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.notice {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-4);
		background: var(--c-waiting-bg);
		font-size: var(--t-sm);
	}
	.notice span {
		flex: 1;
	}
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--s-4) var(--s-5);
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.empty {
		color: var(--c-text-3);
		margin: auto;
	}
	.day {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		color: var(--c-text-4);
		font-size: var(--t-xs);
		margin: var(--s-2) 0;
	}
	.day::before,
	.day::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--c-line);
	}
	.msg {
		position: relative;
		align-self: flex-start;
		max-width: min(46rem, 85%);
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-4);
		background: var(--c-surface-2);
		border: 1px solid var(--c-line);
		overflow-wrap: anywhere;
		line-height: 1.55;
	}
	.msg:not(.user) {
		border-left: 3px solid var(--agent);
		border-radius: 0 var(--r-4) var(--r-4) 0;
	}
	.msg.user {
		align-self: flex-end;
		background: var(--c-surface-3);
		border-color: transparent;
		white-space: pre-wrap;
	}
	.msg.failed {
		border-color: var(--c-danger-line);
	}
	.msg.dim {
		opacity: 0.75;
	}
	.who {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-bottom: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.who-name {
		color: var(--c-text);
		font-weight: var(--w-bold);
	}
	.who time {
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.tag {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.log {
		align-self: flex-start;
		max-width: min(46rem, 85%);
		min-width: 0;
	}
	.log ol {
		list-style: none;
		margin: 0;
		padding: 0 0 0 calc(1.25rem + var(--s-2));
		display: grid;
		gap: 2px;
		font-size: var(--t-sm);
		color: var(--c-text-3);
		overflow-wrap: anywhere;
	}
	.log li.error {
		color: var(--c-danger);
	}
	.log li.login {
		color: var(--c-working);
	}
	.saved {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-2);
		padding-top: var(--s-2);
		border-top: 1px solid var(--c-line);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.working {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
		color: var(--c-working);
	}
	.typing {
		display: inline-flex;
		gap: 0.25rem;
		padding: 0.4rem 0;
	}
	.typing span {
		width: 0.35rem;
		height: 0.35rem;
		border-radius: 50%;
		background: var(--c-text-3);
		animation: blink 1.2s infinite ease-in-out;
	}
	.typing span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.typing span:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.3;
		}
		40% {
			opacity: 1;
		}
	}
</style>
