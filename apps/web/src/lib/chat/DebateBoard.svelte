<script lang="ts">
	// 토론 보드 (studio 테마, 사용자 결정 2026-10-30): 위에 지금 발언을 크게, 아래에 누가 언제 얼마나 말했는지 타임라인.
	// 막대를 누르면 채팅 보기에서 그 발언으로 이동한다. 맺는 말은 아래에 고정. 이미 오는 이벤트만 쓴다 (플랜 사용량 없음)
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { statusLine } from '#lib/shell/agent-line.js';
	import Button from '#lib/ui/Button.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
	import { onMount, tick, untrack } from 'svelte';
	import { closingSpeech, debateSpeeches, focusSpeech, liveSpeech, nextSpeaker, roundLabel, roundSteps, speechesSince, timelineRows } from './stage';

	let {
		debateId = '',
		onchat,
		onjump
	}: { debateId?: string; onchat: () => void; onjump: (messageId: string) => void } = $props();

	let now = $state(Date.now());
	onMount(() => {
		if (!app.lounge) void app.loadLounge().catch(() => {});
		const t = setInterval(() => (now = Date.now()), 5000);
		return () => clearInterval(t);
	});

	let box = $state<HTMLElement | undefined>();
	const lounge = $derived(app.room?.kind === 'lounge');
	const debate = $derived(app.debates.find((d) => d.id === debateId));
	const session = $derived(app.lounge?.recent.find((s) => s.roomId === app.room?.id));

	const speeches = $derived(
		debate ? debateSpeeches(app.messages, debate.id) : lounge ? speechesSince(app.messages, session?.startedAt ?? Number.MAX_SAFE_INTEGER) : []
	);
	const seats = $derived(debate ? [debate.moderatorId, ...debate.agentIds.filter((a) => a !== debate.moderatorId)] : (session?.agentIds ?? app.room?.agentIds ?? []));
	const live = $derived(liveSpeech(speeches));
	const closing = $derived(debate ? closingSpeech(speeches, debate) : null);
	// 초점: 다음 에이전트가 글을 쓰기 시작할 때 넘어간다 (사용자 결정 2026-10-31). 그 전까지 앞 발언을 읽을 수 있다
	const focus = $derived(focusSpeech(speeches, closing?.id ?? ''));
	$effect(() => {
		void focus?.id;
		if (box) box.scrollTop = 0;
	});

	// 다음 사람: 차례가 왔지만 아직 글이 없는 사람, 없으면 지금 말하는 사람의 다음 차례
	const next = $derived.by(() => {
		if (!debate) return '';
		if (live && live.id !== focus?.id) return live.agentId;
		return nextSpeaker(debate, live?.agentId ?? '');
	});
	const rows = $derived(timelineRows(speeches, seats));
	const running = $derived(lounge ? !!app.room?.running : debate?.status === 'running');

	const title = $derived(debate ? (debate.mode === 'collab' ? '협업' : app.label('debate', '토론')) : '라운지');
	const label = $derived(debate ? roundLabel(debate) : session ? `라운지 ${session.spoken} / ${session.turns}` : '라운지');
	const steps = $derived(debate ? roundSteps(debate) : []);
	const feature = $derived(debate ? 'debate' : 'lounge');
	const usage = $derived(app.usage?.features.find((f) => f.feature === feature));

	const calls = $derived(focus ? app.toolCalls.filter((c) => c.messageId === focus.id).slice(-3) : []);
	const CALL: Record<string, string> = { pending: '확인 기다리는 중', running: '사용 중', done: '완료', failed: '실패', denied: '거부됨' };

	// 사용량은 발언이 늘 때 다시 읽는다
	const spokenCount = $derived(speeches.length);
	$effect(() => {
		void spokenCount;
		untrack(() => void app.loadUsage().catch(() => {}));
	});

	// 초점은 답이 쓰이는 동안 아래를 따라간다 (위로 올려 읽는 중이면 그대로)
	$effect(() => {
		void live?.content;
		const el = box;
		if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
		void tick().then(() => (el.scrollTop = el.scrollHeight));
	});
</script>

<section class="board" data-ui="board" aria-label="{title} 보드">
	<header>
		<div class="heads">
			<div class="topic" title={debate?.topic}>{title}{debate ? ` · ${debate.topic.split('\n')[0]}` : ''}</div>
			<div class="meta">
				{label}{usage ? ` · 오늘 요청 ${usage.used}${usage.limit ? ` / ${usage.limit}` : ''}` : ''}
			</div>
		</div>
		<Button size="sm" icon={IconMessages} onclick={onchat}>채팅으로 보기</Button>
	</header>

	{#if steps.length}
		<ol class="steps" aria-label="진행 단계">
			{#each steps as s (s.label)}
				<li class={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>{s.label}</li>
			{/each}
		</ol>
	{/if}

	<div class="focus" bind:this={box} style:--agent={focus ? app.look(focus.agentId).color : undefined}>
		{#if focus}
			<div class="who">
				<Avatar agentId={focus.agentId} size={3} motion="full" />
				<span class="name">{app.look(focus.agentId).name}{debate?.moderatorId === focus.agentId ? ' · 진행' : ''}</span>
				<span class="state">{focus.status === 'streaming' ? '발언 중' : '마지막 발언'}</span>
				{#if next}<span class="state next">다음 {app.look(next).name}</span>{/if}
			</div>
			{#each calls as c (c.id)}
				<div class="tool">{app.toolTitle(c.name)} · {CALL[c.status] ?? c.status}</div>
			{/each}
			<div class="speech">
				{#if focus.content.trim()}<Markdown text={focus.content.trim()} />{:else}<span class="muted">답을 쓰는 중…</span>{/if}
			</div>
		{:else}
			<p class="muted empty">{running ? '첫 발언을 기다리는 중…' : '아직 발언이 없습니다.'}</p>
		{/if}
	</div>

	<div class="timeline" aria-label="발언 타임라인">
		{#each rows as row (row.agentId)}
			{@const look = app.look(row.agentId)}
			{@const line = statusLine(app.statuses[row.agentId], now)}
			<div class="row" style:--agent={look.color}>
				<span class="rname" title={line.text}><Avatar agentId={row.agentId} size={0.95} status={line.state} dot={false} />{look.name}</span>
				<div class="track">
					{#each row.bars as b (b.id)}
						{@const tip = b.preview ? `${look.name}: ${b.preview}` : `${look.name}의 발언`}
						<button
							class="bar"
							class:live={b.live}
							class:on={b.id === focus?.id}
							style:--l={b.left}
							style:--w={Math.max(b.width - 0.2, 0.2)}
							aria-label="{tip} (이 발언으로 이동)"
							title={tip}
							onclick={() => onjump(b.id)}
						></button>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{#if closing}
		<div class="closing" style:--agent={app.look(closing.agentId).color}>
			<span class="clabel">{debate?.mode === 'collab' ? '결과' : '결론'} · {app.look(closing.agentId).name}</span>
			<div class="ctext"><Markdown text={closing.content.trim()} /></div>
		</div>
	{/if}
</section>

<style>
	.board {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--c-line);
	}
	.heads {
		flex: 1;
		min-width: 0;
	}
	.topic {
		font-weight: var(--w-bold);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.steps {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
		margin: 0;
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--c-line);
	}
	.steps li {
		padding: 0 var(--s-2);
		border: 1px solid var(--c-line);
		border-radius: var(--r-1);
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.steps li.done {
		background: var(--c-surface-2);
		color: var(--c-text-2);
	}
	.steps li.now {
		border-color: var(--c-accent-hover);
		color: var(--c-text);
	}
	.focus {
		flex: 1;
		min-height: 6rem;
		overflow-y: auto;
		padding: var(--s-3) var(--s-4);
		border-left: 3px solid var(--agent, transparent);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
	}
	.name {
		font-weight: var(--w-bold);
		color: color-mix(in srgb, var(--agent) 65%, var(--c-text));
	}
	.state {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.state.next {
		margin-left: auto;
	}
	.tool {
		display: inline-block;
		margin: 0 var(--s-1) var(--s-2) 0;
		padding: 0 var(--s-2);
		border: 1px solid var(--c-line);
		border-radius: var(--r-1);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.speech {
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--c-text-3);
	}
	.empty {
		padding-top: var(--s-5);
		text-align: center;
	}
	.timeline {
		flex: none;
		display: grid;
		gap: 0.25rem;
		max-height: 11rem;
		overflow-y: auto;
		padding: var(--s-2) var(--s-4);
		border-top: 1px solid var(--c-line);
		background: var(--c-surface-1);
	}
	.row {
		display: grid;
		grid-template-columns: 6rem minmax(0, 1fr);
		align-items: center;
		gap: var(--s-2);
	}
	.rname {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		min-width: 0;
		overflow: hidden;
		font-size: var(--t-xs);
		color: var(--c-text-2);
		white-space: nowrap;
	}
	.track {
		position: relative;
		height: 0.875rem;
		border-radius: var(--r-1);
		background: var(--c-surface-2);
		overflow: hidden;
	}
	.bar {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 100%;
		padding: 0;
		border: none;
		border-radius: 0;
		background: var(--agent);
		opacity: 0.55;
		/* left·width 를 바꾸면 매번 다시 그리므로 transform 으로 (메인 스레드가 바빠도 부드럽게) */
		transform-origin: left;
		transform: translateX(calc(var(--l) * 1%)) scaleX(calc(var(--w) / 100));
		transition:
			opacity var(--dur-fast) var(--ease),
			transform 0.28s linear;
		will-change: transform;
	}
	.bar:hover:not(:disabled),
	.bar.on {
		background: var(--agent);
		opacity: 1;
	}
	.bar.live {
		animation: pulse 1.2s ease-in-out infinite;
	}
	.closing {
		flex: none;
		max-height: 30%;
		overflow-y: auto;
		padding: var(--s-2) var(--s-4);
		border-top: 1px solid var(--c-line-strong);
		background: var(--c-surface-2);
	}
	.clabel {
		display: block;
		margin-bottom: var(--s-1);
		font-size: var(--t-xs);
		font-weight: var(--w-bold);
		color: color-mix(in srgb, var(--agent) 65%, var(--c-text));
	}
	.ctext {
		font-size: var(--t-sm);
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	@keyframes pulse {
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			transition: none;
		}
		.bar.live {
			animation: none;
			opacity: 1;
		}
	}
</style>
