<script lang="ts">
	// 대화 화면: 헤더 · 타임라인(날짜 구분 · 토론 머리 · 메시지) · 입력창
	import { app } from '#lib/app.svelte.js';
	import ChatHeader from '#lib/chat/ChatHeader.svelte';
	import Composer from '#lib/chat/Composer.svelte';
	import MessageItem from '#lib/chat/MessageItem.svelte';
	import CourtStage from '#lib/chat/CourtStage.svelte';
	import DebateBoard from '#lib/chat/DebateBoard.svelte';
	import { gaze } from '#lib/character/gaze.js';
	import { dayLabel, newDay } from '#lib/chat/time.js';
	import { flashTo } from '#lib/flash.js';
	import Button from '#lib/ui/Button.svelte';
	import type { Debate } from '@proprix/shared';
	import { page } from '$app/state';
	import { tick } from 'svelte';

	let list: HTMLElement | undefined = $state();

	// 말하는 에이전트: 다른 캐릭터들이 그쪽을 본다
	$effect(() => {
		gaze.setSpeaker(app.messages.findLast((m) => m.status === 'streaming')?.agentId ?? '');
		return () => gaze.setSpeaker('');
	});

	// 토론 보드: 토론·협업·라운지가 도는 동안 기본 (사용자 결정 2026-10-30). 채팅으로 바꾸면 그 진행 동안은 채팅에 머문다.
	// 끝나도 읽는 중에 화면이 바뀌지 않게 닫을 때까지 둔다. 지난 토론은 머리의 버튼으로 다시 연다
	const running = $derived(app.room?.kind === 'lounge' ? !!app.room?.running : app.debates.some((d) => d.status === 'running'));
	const runningDebate = $derived(app.debates.find((d) => d.status === 'running')?.id ?? '');
	const court = $derived(app.themes.find((t) => t.id === app.theme)?.stage === 'court'); // 테마가 고르는 토론 화면
	let boardFor = $state<string | null>(null); // 보드로 보는 토론 id ('' = 라운지, null = 채팅)
	let dismissed = $state(''); // 채팅으로 돌아간 진행 (runningKey)
	const runningKey = $derived(running ? `${app.roomId}:${runningDebate}` : '');

	$effect(() => {
		const key = runningKey;
		if (key && key !== dismissed) boardFor = runningDebate;
	});
	// 방을 옮기면 채팅으로
	$effect(() => {
		void app.roomId;
		boardFor = null;
		dismissed = '';
	});

	function toChat() {
		dismissed = runningKey;
		boardFor = null;
		void tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
	}

	// 타임라인 막대: 채팅에서 그 발언으로
	function jumpTo(id: string) {
		dismissed = runningKey;
		boardFor = null;
		void tick().then(() => {
			const el = document.getElementById(`msg-${id}`);
			if (el) flashTo(el);
		});
	}

	const group = $derived(app.roomAgents.length > 1);

	function debateStatus(d: Debate): string {
		if (d.status === 'running')
			return d.round === 0 ? '여는 말' : d.round > d.rounds ? '맺는 말' : `라운드 ${d.round} / ${d.rounds}`;
		return { done: '끝남', stopped: '중지됨', failed: '중단됨' }[d.status];
	}

	function describeDebateStop(d: Debate): string {
		if (d.errorCode === 'daemon_restarted') return 'daemon 재시작으로 멈췄습니다.';
		if (d.errorCode === 'cancelled') return '';
		return `끝까지 진행하지 못했습니다 (${d.errorCode}).`;
	}

	// 방을 열면 맨 아래부터. 그 뒤 새 메시지·델타가 오면 아래로 (사용자가 위로 올려 읽는 중이면 그대로)
	let shownRoom = ''; // 맨 아래로 맞춰 둔 방 (반응형 아님)
	$effect(() => {
		const last = app.messages.at(-1);
		void last?.content;
		if (!list) return;
		const opened = app.loadedRoomId === app.roomId && shownRoom !== app.roomId;
		if (opened) shownRoom = app.roomId;
		// 검색에서 왔으면 (?m=메시지) 그 메시지로 가서 잠깐 강조
		const focus = opened ? page.url.searchParams.get('m') : null;
		if (focus) {
			void tick().then(() => {
				const el = document.getElementById(`msg-${focus}`);
				if (!el) return list?.scrollTo({ top: list.scrollHeight });
				flashTo(el);
			});
			return;
		}
		const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
		if (opened || nearBottom) tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
	});
</script>

<section class="chat">
	<ChatHeader />
	{#if boardFor !== null}
		{#if court}
			<CourtStage debateId={boardFor} onchat={toChat} onjump={jumpTo} />
		{:else}
			<DebateBoard debateId={boardFor} onchat={toChat} onjump={jumpTo} />
		{/if}
	{:else if runningKey}
		<button class="to-board" onclick={() => (boardFor = runningDebate)}>진행 중 · 보드로 보기</button>
	{/if}
	<div class="messages" class:hidden={boardFor !== null} bind:this={list} aria-live="polite" aria-relevant="additions">
		{#if app.messages.length === 0}
			<p class="empty">무엇이든 물어보세요.</p>
		{/if}
		{#each app.messages as m, i (m.id)}
			{@const prev = app.messages[i - 1]}
			{@const d = m.debateId ? app.debate(m.debateId) : undefined}
			{#if newDay(prev?.createdAt, m.createdAt)}
				<div class="day" role="separator"><span>{dayLabel(m.createdAt)}</span></div>
			{/if}
			{#if d && m.role === 'user'}
				<div class="debate-head">
					<div class="debate-title">
						<strong>{d.mode === 'debate' ? app.label('debate', '토론') : '협업'}</strong>
						<span class="badge">{debateStatus(d)}</span>
					</div>
					<div class="topic">{d.topic}</div>
					{#if d.status !== 'running'}
						<div><Button size="sm" onclick={() => (boardFor = d.id)}>보드로 다시 보기</Button></div>
					{/if}
					<div class="hint">
						{app.label('participant', '참여자')} {d.agentIds.map((id) => app.look(id).name).join(' → ')} · {app.label('moderator', '진행자')} {app.look(d.moderatorId).name} · {d.rounds}라운드
					</div>
					{#if d.status === 'stopped' || d.status === 'failed'}
						{@const why = describeDebateStop(d)}
						{#if why}<div class="hint">{why}</div>{/if}
					{/if}
				</div>
			{:else}
				{#if d && (prev?.role === 'user' || m.debateRound !== prev?.debateRound)}
					<div class="divider">
						{m.debateRound === 0 ? '여는 말' : m.debateRound > d.rounds ? app.label('closing', '맺는 말') : `라운드 ${m.debateRound} / ${d.rounds}`}
					</div>
				{/if}
				<MessageItem {m} />
			{/if}
		{/each}
		{#if app.room?.running && !app.messages.some((m) => m.status === 'streaming')}
			<p class="hint pending">
				{app.debates.some((d) => d.status === 'running') ? '다음 발언 준비 중…' : group ? '답할 에이전트를 고르는 중…' : '생각 중…'}
			</p>
		{/if}
	</div>
	<Composer />
</section>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--s-4) var(--s-5);
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.messages.hidden {
		display: none;
	}
	.to-board {
		padding: var(--s-1) var(--s-4);
		border: none;
		border-bottom: 1px solid var(--c-line);
		border-radius: 0;
		background: var(--c-accent-bg);
		color: var(--c-text-2);
		font-size: var(--t-xs);
		text-align: left;
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
	.debate-head {
		align-self: stretch;
		padding: var(--s-3);
		border-radius: var(--r-3);
		border: 1px solid var(--c-line-strong);
		background: var(--c-surface-1);
		display: grid;
		gap: var(--s-1);
	}
	.debate-title {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.topic {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.badge {
		font-size: var(--t-xs);
		color: var(--c-working);
	}
	.divider {
		align-self: center;
		font-size: var(--t-xs);
		color: var(--c-text-3);
		padding: 0.1rem var(--s-2);
		border-radius: var(--r-pill);
		border: 1px solid var(--c-line-strong);
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.pending {
		align-self: flex-start;
	}
</style>
