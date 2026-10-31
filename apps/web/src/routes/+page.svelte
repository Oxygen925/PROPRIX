<script lang="ts">
	// 홈 '오늘': 위 인사 · 빠른 시작, 왼쪽 확인 필요 · 오늘 일정 · 최근 대화 몇 개, 오른쪽 에이전트 · 라운지 · 사용량 (최근 1달 히트맵 + 오늘).
	// 화면 전체는 스크롤하지 않고 긴 칸만 그 안에서 스크롤 (사용자 결정 2026-10-30)
	// 인사는 LLM 을 부르지 않는다 (시간대별 문구)
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import { openAgent } from '#lib/chat/room-actions.js';
	import { fullTime, timeLabel } from '#lib/chat/time.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import ToolCallCard from '#lib/components/ToolCallCard.svelte';
	import { laterReminders, todaySchedule } from '#lib/home/schedule.js';
	import Heatmap from '#lib/manage/Heatmap.svelte';
	import { buildGrid } from '#lib/manage/heatmap.js';
	import { FEATURE_LABEL, REPEAT_LABEL } from '#lib/labels.js';
	import { jobTitle, relativeTime, statusLine } from '#lib/shell/agent-line.js';
	import Button from '#lib/ui/Button.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { BudgetFeature, UsageHistory } from '@proprix/shared';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconBell from '@tabler/icons-svelte-runes/icons/bell';
	import IconCoffee from '@tabler/icons-svelte-runes/icons/coffee';
	import IconHandStop from '@tabler/icons-svelte-runes/icons/hand-stop';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { onMount, untrack } from 'svelte';

	let now = $state(Date.now());
	onMount(() => {
		void app.loadReminders().catch(() => {});
		void app.loadLounge().catch(() => {});
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const h = $derived(new Date(now).getHours());
	const greeting = $derived(
		h < 5 ? '늦은 밤이에요' : h < 11 ? '좋은 아침이에요' : h < 17 ? '좋은 오후예요' : '좋은 저녁이에요'
	);
	const date = $derived(new Date(now).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }));

	// ---- 빠른 시작: 에이전트를 고르고 보내면 새 대화 ----
	let pickedId = $state('');
	const picked = $derived(app.agent(pickedId) ?? app.orderedAgents[0]);
	let text = $state('');
	let sending = $state(false);
	const canStart = $derived(!!picked && text.trim() !== '' && !!app.account?.planUsage && !!app.model && !sending);

	async function start() {
		if (!canStart || !picked) return;
		sending = true;
		try {
			const room = await app.newRoom([picked.id]);
			await app.sendTo(room.id, text.trim());
			text = '';
			await goto(`/rooms/${room.id}`);
		} catch (e) {
			toastError(e);
		} finally {
			sending = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void start();
		}
	}

	// ---- 확인 필요 · 오늘 일정 · 최근 대화 · 라운지 · 사용량 ----
	const roomTitle = (id: string) => app.rooms.find((r) => r.id === id)?.title ?? '채팅';
	const schedule = $derived(todaySchedule(app.reminders, app.agents, now, app.tasks));
	const later = $derived(laterReminders(app.reminders, now));
	// 최근 대화 몇 개만 (사용자 결정 2026-10-30, 전체는 대화 목록에서)
	const RECENT_SHOWN = 4;
	const recent = $derived(
		app.rooms
			.filter((r) => r.kind === 'chat' && !r.archived && !r.parentRoomId)
			.toSorted((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, RECENT_SHOWN)
	);
	// 지금 도는 일: 응답 중인 그룹 대화·토론과 리서치 (에이전트 줄의 상태로 안 보이는 것)
	const activeRooms = $derived(app.groupRooms.filter((r) => r.running));
	const activeResearch = $derived(app.researches.filter((r) => app.researchRunning(r.id)));
	const session = $derived(app.lounge?.recent[0]);
	const usage = $derived(
		(app.usage?.features ?? []).filter((f): f is typeof f & { feature: BudgetFeature } => f.feature in FEATURE_LABEL && f.used > 0)
	);

	// 최근 1달 (5주) 히트맵: 처음 + 예산 알림이 올 때마다 다시 읽는다
	let month = $state<UsageHistory | null>(null);
	$effect(() => {
		void app.usageAlerts;
		untrack(() => {
			app
				.loadUsageHistory(35)
				.then((h) => (month = h))
				.catch(() => {});
		});
	});
	const monthGrid = $derived(month ? buildGrid(month.days, new Date(now), null, 5) : null);

	async function cancelReminder(id: string) {
		try {
			await app.cancelReminder(id);
			toast('리마인더를 취소했습니다', 'success');
		} catch (e) {
			toastError(e);
		}
	}
</script>

{#snippet roomRow(href: string, r: { title: string; agentIds: string[] }, ago: string, unread = false)}
	<a class="lounge" {href}>
		<span class="stack" aria-hidden="true">
			{#each r.agentIds.slice(0, 3) as id (id)}<Avatar agentId={id} size={1.1} />{/each}
		</span>
		<span class="title">{r.title}</span>
		{#if unread}<span class="unread" aria-label="새 메시지"></span>{/if}
		<span class="ago">{ago}</span>
	</a>
{/snippet}

<div class="home">
	<header>
		<p class="date">{date}</p>
		<h1>{greeting}</h1>
	</header>

	<!-- 빠른 시작 -->
	<form
		class="quick"
		onsubmit={(e) => {
			e.preventDefault();
			void start();
		}}
	>
		<div class="pick" role="radiogroup" aria-label="누구에게">
			{#each app.orderedAgents as a (a.id)}
				<button
					type="button"
					role="radio"
					aria-checked={picked?.id === a.id}
					class:on={picked?.id === a.id}
					onclick={() => (pickedId = a.id)}
				>
					<Avatar agentId={a.id} size={1.1} />
					{a.name}
				</button>
			{/each}
		</div>
		<div class="quick-box">
			<textarea
				data-gaze-input
				bind:value={text}
				onkeydown={onKey}
				rows="2"
				placeholder={app.account?.planUsage
					? `${picked?.name ?? '에이전트'}에게 새 채팅으로 전송 (Enter)`
					: '먼저 ChatGPT 로 로그인하세요'}
				disabled={!app.account?.planUsage}
				aria-label="새 채팅 첫 메시지"
			></textarea>
			<Button size="sm" variant="primary" icon={IconArrowUp} type="submit" disabled={!canStart}>시작</Button>
		</div>
	</form>

	<div class="cols">
		<div class="col">

	{#if app.pendingCalls.length}
		<section class="fill" aria-labelledby="h-pending">
			<h2 id="h-pending"><IconHandStop size="1rem" stroke={1.75} aria-hidden="true" /> 확인 필요 <span class="count">{app.pendingCalls.length}</span></h2>
			<div class="pending scroll">
				{#each app.pendingCalls as call (call.id)}
					<div class="pending-item">
						<a class="where" href="/rooms/{call.roomId}">{roomTitle(call.roomId)} →</a>
						<ToolCallCard {call} />
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<section class="fill" aria-labelledby="h-today">
		<h2 id="h-today"><IconBell size="1rem" stroke={1.75} aria-hidden="true" /> 오늘 일정</h2>
		{#if schedule.length}
			<ol class="timeline scroll">
				{#each schedule as item (item.key)}
					<li class:past={item.at < now}>
						<time datetime={new Date(item.at).toISOString()} title={fullTime(item.at)}>{timeLabel(item.at)}</time>
						<Avatar agentId={item.agentId} size={1.1} />
						<span class="what">
							{#if item.kind === 'checkin'}
								<span class="tag">체크인</span>{app.look(item.agentId).name} · 먼저 말을 걸어 와요
							{:else if item.kind === 'task'}
								<span class="tag">예약 작업</span><a href="/activity?tab=tasks">{item.text}</a>
							{:else}
								<span class="tag">{REPEAT_LABEL[item.reminder?.repeat ?? 'none']}</span>{item.text}
							{/if}
						</span>
						{#if item.reminder}
							{@const r = item.reminder}
							<IconButton icon={IconX} label="리마인더 취소" size="sm" onclick={() => cancelReminder(r.id)} />
						{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p class="empty">오늘 예정된 리마인더·체크인·예약 작업이 없어요.</p>
		{/if}
		{#if later}<p class="hint">이후 예약된 리마인더 {later}개 · <a href="/settings?s=proactive">설정에서 보기</a></p>{/if}
	</section>

	{#if recent.length}
		<section aria-labelledby="h-recent">
			<h2 id="h-recent">최근 채팅</h2>
			<div class="active">
				{#each recent as r (r.id)}
					{@render roomRow(`/rooms/${r.id}`, r, relativeTime(r.updatedAt, now), app.unread.includes(r.id))}
				{/each}
			</div>
		</section>
	{/if}

		</div>
		<div class="col">
	{#if activeRooms.length || activeResearch.length}
		<section aria-labelledby="h-active">
			<h2 id="h-active">진행 중</h2>
			<div class="active">
				{#each activeRooms as r (r.id)}
					{@render roomRow(`/rooms/${r.id}`, r, '진행 중')}
				{/each}
				{#each activeResearch as r (r.id)}
					{@render roomRow(`/research/${r.id}`, r, '리서치 중')}
				{/each}
			</div>
		</section>
	{/if}

	<section class="fill" aria-labelledby="h-agents">
		<h2 id="h-agents">에이전트</h2>
		<div class="grid scroll">
			{#each app.orderedAgents as a (a.id)}
				{@const line = statusLine(app.statuses[a.id], now)}
				<button class="agent" onclick={() => openAgent(a.id)}>
					<Avatar agentId={a.id} size={1.6} status={line.state} />
					<span class="text">
						<span class="name">{a.name}</span>
						<span class="job">{jobTitle(a, app.persona(a.personaId)) || '에이전트'}</span>
						<span class="line {line.state}">{line.text}</span>
					</span>
				</button>
			{/each}
		</div>
	</section>

	{#if session || app.settings.lounge.enabled}
		<section aria-labelledby="h-lounge">
			<h2 id="h-lounge"><IconCoffee size="1rem" stroke={1.75} aria-hidden="true" /> 라운지</h2>
			{#if session}
				<a class="lounge" href="/rooms/{session.roomId}">
					<span class="stack" aria-hidden="true">
						{#each session.agentIds.slice(0, 4) as id (id)}<Avatar agentId={id} size={1.1} />{/each}
					</span>
					<span class="title">
						{session.agentIds.map((id) => app.look(id).name).join(', ')}
						{session.status === 'running' ? '· 이야기하는 중' : `· ${session.spoken}마디`}
					</span>
					<span class="ago">{relativeTime(session.startedAt, now)}</span>
				</a>
			{:else}
				<p class="empty">아직 오늘의 라운지 채팅이 없어요.</p>
			{/if}
		</section>
	{/if}

	{#if usage.length || monthGrid?.total}
		<section aria-labelledby="h-usage">
			<h2 id="h-usage">
				사용량 <span class="hint">ChatGPT 플랜 요청 수</span>
				<a class="more" href="/activity?tab=usage">자세히</a>
			</h2>
			<div class="usage-row">
				{#if monthGrid}
					<div class="month" title="최근 1달">
						<Heatmap grid={monthGrid} compact onselect={() => goto('/activity?tab=usage')} />
					</div>
				{/if}
			<ul class="usage">
				{#each usage as u (u.feature)}
					<li title={FEATURE_LABEL[u.feature].hint}>
						<span class="u-name">{FEATURE_LABEL[u.feature].title}</span>
						{#if u.limit}
							<span class="meter" aria-hidden="true"><span style:width="{Math.min(100, (u.used / u.limit) * 100)}%"></span></span>
						{/if}
						<span class="u-num">{u.used}{u.limit ? ` / ${u.limit}` : ''}</span>
					</li>
				{:else}
					<li class="u-none">오늘은 아직 요청이 없어요.</li>
				{/each}
			</ul>
			</div>
		</section>
	{/if}
		</div>
	</div>
</div>

<style>
	.home {
		height: 100%;
		max-width: 72rem;
		margin: 0 auto;
		padding: 1.5rem var(--s-5) var(--s-4);
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		overflow: hidden;
	}
	.cols {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		gap: var(--s-6);
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		min-height: 0;
	}
	.col > section {
		flex: none;
	}
	/* 긴 칸: 남는 높이를 나눠 갖고, 넘치면 그 안에서 스크롤 */
	.col > section.fill {
		flex: 0 1 auto;
		min-height: 4.5rem;
		display: flex;
		flex-direction: column;
	}
	.scroll {
		min-height: 0;
		overflow-y: auto;
	}
	/* 좁은 화면: 한 줄로 쌓고 화면 전체를 스크롤 */
	@media (max-width: 960px) {
		.home {
			height: auto;
			max-width: 47.5rem;
			overflow: visible;
		}
		.cols {
			display: flex;
			flex-direction: column;
		}
		.scroll {
			overflow: visible;
		}
	}
	.date {
		color: var(--c-text-3);
		font-size: var(--t-sm);
		margin-bottom: 0.375rem;
	}
	h1 {
		font-size: 1.625rem;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-md);
		font-weight: var(--w-regular);
		color: var(--c-text-3);
		margin-bottom: var(--s-3);
	}
	.count {
		min-width: 1.25rem;
		padding: 0 0.35rem;
		border-radius: var(--r-pill);
		background: var(--c-waiting-bg);
		color: var(--c-waiting);
		font-size: var(--t-xs);
		text-align: center;
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.empty {
		color: var(--c-text-4);
		font-size: var(--t-sm);
	}

	/* 빠른 시작 */
	.quick {
		display: grid;
		gap: var(--s-2);
		margin-top: calc(var(--s-4) * -1);
	}
	.pick {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.pick button {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		padding: 0.15rem var(--s-2) 0.15rem 0.2rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--c-line-strong);
		background: transparent;
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.pick button.on {
		border-color: var(--c-text-3);
		color: var(--c-text);
		background: var(--c-surface-2);
	}
	.quick-box {
		display: flex;
		align-items: flex-end;
		gap: var(--s-2);
		padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-4);
		background: var(--c-surface-2);
	}
	.quick-box:focus-within {
		border-color: var(--c-line-stronger);
	}
	.quick-box textarea {
		flex: 1;
		border: none;
		background: transparent;
		resize: none;
		padding: var(--s-1) 0;
		field-sizing: content;
		max-height: 30vh;
	}
	.quick-box textarea:focus-visible {
		box-shadow: none;
	}

	/* 확인 필요 */
	.pending {
		display: grid;
		gap: var(--s-2);
	}
	.where {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}

	/* 오늘 일정 */
	.timeline {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.125rem;
	}
	.timeline li {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-1) var(--s-2);
		border-radius: var(--r-2);
	}
	.timeline li:hover {
		background: var(--c-hover);
	}
	.timeline li.past {
		opacity: 0.5;
	}
	.timeline time {
		width: 4.5rem;
		flex: none;
		color: var(--c-text-2);
		font-size: var(--t-sm);
		font-variant-numeric: tabular-nums;
	}
	.what {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		margin-right: var(--s-2);
		padding: 0 var(--s-1);
		border-radius: var(--r-1);
		border: 1px solid var(--c-line-strong);
		color: var(--c-text-3);
		font-size: var(--t-xs);
	}

	/* 에이전트 */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: 0.625rem;
	}
	.agent {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--r-3);
		border: 1px solid var(--c-line);
		background: var(--c-surface-1);
		text-align: left;
	}
	.agent:hover {
		border-color: var(--c-line-stronger);
		background: var(--c-surface-2);
	}
	.text {
		display: grid;
		min-width: 0;
		gap: 1px;
	}
	.name {
		font-weight: var(--w-bold);
		color: var(--c-text);
	}
	.job {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.line {
		font-size: var(--t-xs);
		color: var(--c-text-4);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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

	/* 최근 대화 · 라운지 */
	.active {
		display: grid;
		gap: 0.125rem;
	}
	.lounge {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2);
		border-radius: var(--r-2);
		color: var(--c-text-2);
		text-decoration: none;
	}
	.lounge:hover {
		background: var(--c-hover);
		text-decoration: none;
	}
	.stack {
		display: flex;
		flex: none;
	}
	.stack > :global(* + *) {
		margin-left: -0.35rem;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.unread {
		flex-shrink: 0;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--c-accent-hover);
	}
	.ago {
		color: var(--c-text-4);
		font-size: var(--t-xs);
		white-space: nowrap;
	}

	/* 사용량 */
	.more {
		margin-left: auto;
		font-size: var(--t-sm);
		font-weight: normal;
		color: var(--c-text-3);
	}
	.usage-row {
		display: flex;
		align-items: flex-start;
		gap: var(--s-5);
	}
	.month {
		flex: none;
		width: 6.25rem;
	}
	.u-none {
		color: var(--c-text-3);
	}
	.usage {
		flex: 1;
		min-width: 0;
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
	}
	.usage li {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		font-size: var(--t-sm);
	}
	.u-name {
		width: 6rem;
		color: var(--c-text-2);
	}
	.meter {
		flex: 1;
		height: 0.3rem;
		border-radius: var(--r-pill);
		background: var(--c-surface-3);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		background: var(--c-text-3);
	}
	.u-num {
		margin-left: auto;
		color: var(--c-text-3);
		font-variant-numeric: tabular-nums;
	}
</style>
