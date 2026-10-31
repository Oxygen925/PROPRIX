<script lang="ts">
	// 오른쪽 에이전트 패널
	// - 1인 방 (작업대, 사용자 결정 2026-10-30): 프로필(작게) · 모델 · 도구 · 기억 상위 5 · 오늘 사용량 · 작업 폴더 · 루틴 · 항상 허용 규칙 · 편집
	// - 그룹방: 참여자(상태) · 참여자·연쇄 상한 편집 · 진행 중 토론 · 이전 대화 요약
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import { fade } from 'svelte/transition';
	import ModelPicker from '#lib/chat/ModelPicker.svelte';
	import { fullTime, timeLabel } from '#lib/chat/time.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import RoomMembers from '#lib/components/RoomMembers.svelte';
	import { REPEAT_LABEL } from '#lib/labels.js';
	import Button from '#lib/ui/Button.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { SHARED_SCOPE } from '@proprix/shared';
	import IconAdjustments from '@tabler/icons-svelte-runes/icons/adjustments';
	import IconPlayerStop from '@tabler/icons-svelte-runes/icons/player-stop';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { onMount } from 'svelte';
	import { jobTitle, statusLine } from './agent-line.js';

	let now = $state(Date.now());
	onMount(() => {
		if (!app.remindersLoaded) void app.loadReminders().catch(() => {});
		if (!app.memoriesLoaded) void app.loadMemories().catch(() => {});
		void app.loadUsage().catch(() => {});
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const room = $derived(app.room);
	const members = $derived(app.roomAgents);
	const solo = $derived(members.length === 1 ? members[0] : undefined);
	const TOOLS_SHOWN = 6;
	let allTools = $state(false); // 도구 칩 모두 보기
	let editMembers = $state(false); // 그룹방 참여자·연쇄 상한 편집

	const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
	const dayText = (days: number[]) =>
		days.length === 7
			? '매일'
			: days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
				? '평일'
				: [...days].sort().map((d) => DAYS[d]).join('·');

	const roomReminders = $derived(
		app.reminders.filter((r) => r.roomId === room?.id && r.status === 'scheduled').toSorted((x, y) => x.dueAt - y.dueAt)
	);
	// 이 에이전트가 쓸 수 있는 기억 중 중요한 것 (전용 + 공용, 대체·만료된 것 제외)
	const topMemories = $derived(
		solo
			? app.memories
					.filter(
						(m) =>
							(m.scope === solo.id || m.scope === SHARED_SCOPE) &&
							!m.supersededBy &&
							(m.validUntil === null || m.validUntil > now)
					)
					.toSorted((x, y) => y.importance - x.importance || (y.lastUsedAt ?? 0) - (x.lastUsedAt ?? 0))
					.slice(0, 5)
			: []
	);
	const debate = $derived(app.debates.find((d) => d.status === 'running'));
	const chatUsage = $derived(app.usage?.features.find((f) => f.feature === 'chat'));

	async function run(task: () => Promise<unknown>, ok = '') {
		try {
			await task();
			if (ok) toast(ok, 'success');
		} catch (e) {
			toastError(e);
		}
	}
</script>

<aside class="panel" data-ui="panel" aria-label="에이전트 정보" in:fade|global={{ duration: 180 }}>
	<header>
		<span class="title">{solo ? '작업대' : app.label('participant', '참여자')}</span>
		<IconButton icon={IconX} label="패널 닫기 (Ctrl+.)" size="sm" onclick={() => app.togglePanel(false)} />
	</header>
	{#if solo}
		{@const line = statusLine(app.statuses[solo.id], now)}
		{@const persona = app.persona(solo.personaId)}
		<div class="profile">
			<Avatar agentId={solo.id} size={5} status={line.state} motion="full" />
			<div class="who">
				<div class="name">{solo.name}</div>
				{#if jobTitle(solo, persona)}<div class="job">{jobTitle(solo, persona)}</div>{/if}
				<div class="line {line.state}" aria-live="polite">{line.text}</div>
			</div>
		</div>
		{#if persona?.description && persona.description !== jobTitle(solo, persona)}
			<p class="intro">{persona.description}</p>
		{/if}

		<section>
			<h3>모델</h3>
			<div><ModelPicker below /></div>
		</section>

		<section>
			<h3>{app.label('tools', '도구')}</h3>
			<div class="chips">
				{#each allTools ? solo.tools : solo.tools.slice(0, TOOLS_SHOWN) as t (t)}<span class="chip">{app.toolTitle(t)}</span>{/each}
				{#if solo.webSearch}<span class="chip">웹 검색</span>{/if}
				{#if solo.tools.length > TOOLS_SHOWN}
					<button class="chip more" onclick={() => (allTools = !allTools)}>{allTools ? '접기' : `+${solo.tools.length - TOOLS_SHOWN} 더 보기`}</button>
				{/if}
				{#if solo.tools.length === 0 && !solo.webSearch}<span class="muted">없음</span>{/if}
			</div>
		</section>

		{#if topMemories.length}
			<section>
				<h3>기억 <a href="/memories">모두 보기</a></h3>
				<ul class="memories">
					{#each topMemories as m (m.id)}
						<li title="중요도 {m.importance} · {app.scopeLabel(m.scope)}">{m.content}</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if chatUsage}
			<section>
				<h3>오늘 사용량 <a href="/activity?tab=usage">자세히</a></h3>
				<p class="muted">채팅 {chatUsage.used}회{chatUsage.limit ? ' / ' + chatUsage.limit : ''}</p>
				{#if chatUsage.limit}
					<div class="meter" aria-hidden="true"><i style:width="{Math.min(100, (chatUsage.used / chatUsage.limit) * 100)}%"></i></div>
				{/if}
			</section>
		{/if}

		<section>
			<h3>작업 폴더</h3>
			{#if room?.workspace}
				<p class="path" title={room.workspace}>{room.workspace}</p>
				<p class="hint">{room.shellEnabled ? "명령 실행 허용" : "명령 실행 꺼짐"} · 채팅 ⋯ 메뉴에서 바꿈</p>
			{:else}
				<p class="muted">연결 안 됨 · 채팅 ⋯ 메뉴에서 지정</p>
			{/if}
		</section>

		<section>
			<h3>리마인더</h3>
			<ul class="list">
				<li>
					<span class="k">체크인</span>
					{#if solo.checkin.enabled}
						<span class="v">{dayText(solo.checkin.days)} {solo.checkin.time}</span>
					{:else}
						<span class="muted">꺼짐</span>
					{/if}
				</li>
				{#each roomReminders as r (r.id)}
					<li>
						<span class="k" title={fullTime(r.dueAt)}>{timeLabel(r.dueAt)}</span>
						<span class="v" title={r.text}>{REPEAT_LABEL[r.repeat]} · {r.text}</span>
						<IconButton
							icon={IconX}
							label="리마인더 취소"
							size="sm"
							onclick={() => run(() => app.cancelReminder(r.id), '리마인더를 취소했습니다')}
						/>
					</li>
				{/each}
			</ul>
		</section>

		{#if solo.autoApproveTools.length || solo.autoApproveWrites}
			<section>
				<h3>확인 없이 실행</h3>
				<ul class="list">
					{#if solo.autoApproveWrites}<li><span class="v">모든 쓰기 도구 (편집기에서 설정)</span></li>{/if}
					{#each solo.autoApproveTools as tool (tool)}
						<li>
							<span class="v">{app.toolTitle(tool)}</span>
							<IconButton
								icon={IconX}
								label="{app.toolTitle(tool)} 항상 허용 해제"
								size="sm"
								onclick={() => run(() => app.revokeTool(solo.id, tool), '항상 허용을 해제했습니다')}
							/>
						</li>
					{/each}
				</ul>
				<p class="hint">웹 검색·토론·명령 출력이 섞인 답에서는 여전히 확인합니다. 파일을 읽은 답에서는 폴더 밖 쓰기만 확인합니다.</p>
			</section>
		{/if}

		{#if solo.role.trim()}
			<section>
				<h3>역할</h3>
				<p class="role">{solo.role}</p>
			</section>
		{/if}
		<div class="actions">
			<Button icon={IconAdjustments} size="sm" onclick={() => goto(`/agents?edit=${solo.id}`)}>에이전트 편집</Button>
		</div>
	{:else if room}
		<ul class="members">
			{#each members as a (a.id)}
				{@const line = statusLine(app.statuses[a.id], now)}
				<li>
					<Avatar agentId={a.id} size={1.5} status={line.state} motion="gaze" />
					<span class="m-text">
						<span class="name">{a.name}</span>
						<span class="line {line.state}">{line.text}</span>
					</span>
				</li>
			{/each}
		</ul>
		{#if room.kind === 'chat'}
			{#if editMembers}
				{#key room.id}
					<RoomMembers onclose={() => (editMembers = false)} />
				{/key}
			{:else}
				<p class="hint">연쇄 응답 상한 {room.chainLimit} · 메시지 하나에 이어서 답하는 최대 횟수</p>
				<div class="actions">
					<Button size="sm" onclick={() => (editMembers = true)}>참여자·연쇄 상한 바꾸기</Button>
				</div>
			{/if}
		{/if}

		{#if debate}
			<section class="debate">
				<h3>진행 중인 {debate.mode === 'debate' ? app.label('debate', '토론') : '협업'}</h3>
				<p>{debate.topic}</p>
				<p class="hint">
					{debate.round === 0 ? '여는 말' : debate.round > debate.rounds ? app.label('closing', '맺는 말') : `라운드 ${debate.round} / ${debate.rounds}`}
					· {app.label('moderator', '진행자')} {app.look(debate.moderatorId).name}
				</p>
				<div class="actions">
					<Button size="sm" icon={IconPlayerStop} onclick={() => app.cancel()}>중지</Button>
				</div>
			</section>
		{/if}

		{#if app.summary}
			<details class="summary">
				<summary>이전 채팅 요약</summary>
				<p>{app.summary.summary}</p>
			</details>
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
	.profile {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.who {
		min-width: 0;
		display: grid;
	}
	.profile .name {
		font-weight: var(--w-bold);
	}
	.intro {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.meter {
		height: 3px;
		border-radius: 2px;
		background: var(--c-line-strong);
		overflow: hidden;
	}
	.meter i {
		display: block;
		height: 100%;
		background: var(--c-accent);
	}
	.job {
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.line {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.line.thinking,
	.line.working {
		color: var(--c-working);
	}
	.line.waiting {
		color: var(--c-waiting);
	}
	.line.blocked {
		color: var(--c-danger);
	}
	.line.done {
		color: var(--c-done);
	}
	section {
		display: grid;
		gap: 0.375rem;
	}
	h3 {
		display: flex;
		justify-content: space-between;
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
		color: var(--c-text-4);
	}
	h3 a {
		color: var(--c-text-3);
	}
	section p,
	.summary p {
		color: var(--c-text-2);
		font-size: var(--t-sm);
		white-space: pre-wrap;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.125rem;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 1.75rem;
		color: var(--c-text-2);
		font-size: var(--t-sm);
	}
	.k {
		flex: none;
		color: var(--c-text-3);
		min-width: 3.5rem;
	}
	.v {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.muted {
		color: var(--c-text-4);
		font-size: var(--t-sm);
	}
	.memories {
		margin: 0;
		padding-left: 1.1em;
		display: grid;
		gap: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.chip {
		padding: 0.05rem var(--s-2);
		border-radius: var(--r-pill);
		border: 1px solid var(--c-line-strong);
		color: var(--c-text-3);
		font-size: var(--t-xs);
	}
	.chip.more {
		background: transparent;
		border-style: dashed;
		cursor: pointer;
	}
	.chip.more:hover {
		color: var(--c-text);
	}
	.role {
		max-height: 11.25rem;
		overflow-y: auto;
	}
	.members {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.625rem;
	}
	.members li {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}
	.m-text {
		display: grid;
		min-width: 0;
	}
	.m-text .name {
		font-weight: var(--w-bold);
	}
	.m-text .line {
		font-size: var(--t-xs);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.path {
		font-family: var(--font-mono);
		font-size: var(--t-xs) !important;
		overflow-wrap: anywhere;
	}
	.debate {
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
	}
	.summary summary {
		cursor: pointer;
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.summary p {
		margin-top: var(--s-2);
		max-height: 20rem;
		overflow-y: auto;
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
</style>
