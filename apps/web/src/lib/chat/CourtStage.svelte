<script lang="ts">
	// 법정 무대: 토론 보드 대신 쓰는 비주얼 노벨식 화면 (테마가 theme.json 의 "stage": "court" 로 고른다).
	// 위에 참가자·진행, 가운데 큰 화자, 아래 대사창(답이 실시간으로 올라옴), 도구를 쓰면 증거 카드, 끝나면 판결.
	// 다음 사람이 글을 쓰기 시작해야 넘어간다 (토론 보드와 같은 규칙). 이미 오는 이벤트만 쓴다 (플랜 사용량 없음).
	// 발언 막대 한 줄: 누가 얼마나 말했는지 화자 색으로 잇고, 누르면 채팅 보기에서 그 발언으로 간다.
	// 색은 --stage-* 변수로 테마가 바꿀 수 있다. 라운지는 재판 연출 없이 밝게
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { statusLine } from '#lib/shell/agent-line.js';
	import Button from '#lib/ui/Button.svelte';
	import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
	import { onMount, tick } from 'svelte';
	import { closingSpeech, debateSpeeches, focusSpeech, liveSpeech, nextSpeaker, speechesSince, timelineRows } from './stage';

	let { debateId = '', onchat, onjump }: { debateId?: string; onchat: () => void; onjump: (messageId: string) => void } = $props();

	let now = $state(Date.now());
	onMount(() => {
		if (!app.lounge) void app.loadLounge().catch(() => {});
		const t = setInterval(() => (now = Date.now()), 5000);
		return () => clearInterval(t);
	});

	const room = $derived(app.room);
	const lounge = $derived(room?.kind === 'lounge');
	const debate = $derived(app.debates.find((d) => d.id === debateId));
	const session = $derived(app.lounge?.recent.find((s) => s.roomId === room?.id));
	const running = $derived(lounge ? !!room?.running : debate?.status === 'running');

	const seats = $derived(debate ? [debate.moderatorId, ...debate.agentIds.filter((a) => a !== debate.moderatorId)] : (session?.agentIds ?? room?.agentIds ?? []));
	const spoken = $derived(
		debate ? debateSpeeches(app.messages, debate.id) : lounge ? speechesSince(app.messages, session?.startedAt ?? Number.MAX_SAFE_INTEGER) : []
	);
	const trail = $derived(timelineRows(spoken, seats).flatMap((r) => r.bars.map((b) => ({ ...b, agentId: r.agentId }))));
	const current = $derived(liveSpeech(spoken));
	const shown = $derived(focusSpeech(spoken, ''));
	const speakerId = $derived(shown?.agentId ?? '');
	const speaker = $derived(speakerId ? app.look(speakerId) : null);
	const moderator = $derived(debate?.moderatorId ?? '');
	const speakerLabel = $derived(speaker ? `${speaker.name}${speakerId === moderator ? (debate?.mode === 'collab' ? ' · 진행' : ` · ${app.label('moderator', '재판장')}`) : ''}` : '');
	const nextId = $derived.by(() => {
		if (!debate || !running) return '';
		if (current && current.id !== shown?.id) return current.agentId;
		return nextSpeaker(debate, current?.agentId ?? '');
	});

	const round = $derived.by(() => {
		if (lounge) return session ? `휴식 시간 ${session.spoken} / ${session.turns}` : '휴식 시간';
		if (!debate) return '';
		if (debate.status !== 'running') return { done: debate.mode === 'collab' ? '완성' : app.label('closing', '판결'), stopped: '중지', failed: '중단' }[debate.status];
		return debate.round === 0 ? '여는 말' : debate.round > debate.rounds ? app.label('closing', '맺는 말') : app.label('round', '제{n} 라운드').replace('{n}', String(debate.round));
	});
	const progress = $derived.by(() => {
		if (lounge) return session?.turns ? Math.min(100, (session.spoken / session.turns) * 100) : 0;
		if (!debate) return 0;
		return debate.status !== 'running' ? 100 : Math.min(100, (debate.round / (debate.rounds + 1)) * 100);
	});
	// 판결: 맺는 말이 나오기 시작하면 화면이 어두워지고 도장이 찍힌다 (협업은 재판 연출 없이)
	const closing = $derived(debate ? closingSpeech(spoken, debate) : null);
	const verdict = $derived(debate?.mode === 'debate' && !!closing?.content.trim());
	const verdictText = $derived(app.label('closing', '판결'));

	// 라운드가 바뀌면 제목을 잠깐 크게 찍는다
	let banner = $state('');
	let lastRound = '';
	$effect(() => {
		const r = round;
		if (r === lastRound) return;
		const first = lastRound === '';
		lastRound = r;
		if (lounge || !running) return;
		// 처음에는 개정 선언
		banner = first ? app.label('court.open', '개정') : r;
		const t = setTimeout(() => (banner = ''), first ? 2000 : 1400);
		return () => clearTimeout(t);
	});

	// 화자 컷인: 다음 사람이 말하기 시작하면 이름과 캐릭터가 화면을 가로지른다
	let cutin = $state('');
	$effect(() => {
		const id = speakerId;
		if (!id || lounge) return;
		cutin = id;
		const t = setTimeout(() => (cutin = ''), 1200);
		return () => clearTimeout(t);
	});

	// 대사: 굵은 글과 숫자를 강조한다 ({@html} 없이 조각으로)
	const clean = (t: string) => t.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/<\/?[a-z][^>]*>/gi, '').replace(/^[#>\s-]+/gm, '').replace(/[`|]/g, '').replace(/[ \t]+/g, ' ').trim();
	const segments = $derived.by(() => {
		if (!shown) return [];
		const t = clean(shown.content);
		const out: { text: string; em: boolean }[] = [];
		const re = /\*\*(.+?)\*\*|\d[\d.,]*(?:%|시간|분|초|개|원|배|점|년|월|일|명)?/g;
		let at = 0;
		for (const m of t.matchAll(re)) {
			if (m.index > at) out.push({ text: t.slice(at, m.index).replace(/\*\*?/g, ''), em: false });
			out.push({ text: m[1] ?? m[0], em: true });
			at = m.index + m[0].length;
		}
		if (at < t.length) out.push({ text: t.slice(at).replace(/\*\*?/g, ''), em: false });
		return out;
	});

	// 증거 카드: 지금 화자의 가장 최근 도구 호출, 또는 웹 검색 출처
	const evidence = $derived.by(() => {
		if (!shown) return null;
		const call = app.toolCalls.findLast((c) => c.messageId === shown.id);
		if (call) return { title: app.toolTitle(call.name), detail: call.status === 'running' ? '사용 중' : call.status === 'pending' ? '확인 기다리는 중' : '' };
		const src = shown.sources.at(-1);
		return src ? { title: '웹 검색', detail: src.title || src.url } : null;
	});

	// 대사창은 답이 쓰이는 동안 아래를 따라간다 (위로 올려 읽는 중이면 그대로)
	let box = $state<HTMLElement | undefined>();
	$effect(() => {
		void shown?.id;
		if (box) box.scrollTop = 0;
	});
	$effect(() => {
		void current?.content;
		const el = box;
		if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
		void tick().then(() => (el.scrollTop = el.scrollHeight));
	});
</script>

<section class="court" class:rest={lounge} data-ui="court" aria-label="토론 무대">
	<div class="top">
		<div class="seats">
			{#each seats as id (id)}
				{@const line = statusLine(app.statuses[id], now)}
				<span class="seat" class:on={id === speakerId} class:judge={id === moderator} title="{app.look(id).name} · {line.text}">
					<Avatar agentId={id} size={1.7} status={line.state} motion="gaze" />
				</span>
			{/each}
		</div>
		<div class="progress" aria-hidden="true"><i style:width="{progress}%"></i></div>
		<span class="round">{round}</span>
		{#if nextId}<span class="next">다음 {app.look(nextId).name}</span>{/if}
		<Button size="sm" icon={IconMessages} onclick={onchat}>채팅으로 보기</Button>
	</div>

	<div class="floor">
		{#if speakerId}
			{#key speakerId}
				<div class="portrait"><Avatar agentId={speakerId} size={7} motion="full" /></div>
			{/key}
		{/if}
		{#if evidence}
			{#key evidence.title}
				<div class="evidence" data-part="evidence">
					<b>{app.label('evidence', '증거')}</b>
					<span>{evidence.title}</span>
					{#if evidence.detail}<span class="sub">{evidence.detail}</span>{/if}
				</div>
			{/key}
		{/if}
		{#if verdict}
			<div class="gloom" data-part="gloom" aria-hidden="true"></div>
			<div class="stamp" data-part="stamp" aria-hidden="true">{verdictText}</div>
		{/if}
		{#if cutin}
			{#key cutin}
				<div class="cutin" data-part="cutin" aria-hidden="true">
					<Avatar agentId={cutin} size={4} />
					<b>{app.look(cutin).name}</b>
				</div>
			{/key}
		{/if}
		{#if banner}<div class="banner" data-part="banner" aria-hidden="true">{banner}</div>{/if}
	</div>

	{#if trail.length}
		<div class="trail" data-part="timeline" aria-label="발언 타임라인">
			{#each trail as b (b.id)}
				{@const look = app.look(b.agentId)}
				{@const tip = b.preview ? `${look.name}: ${b.preview}` : `${look.name}의 발언`}
				<button
					class="bar"
					class:live={b.live}
					class:on={b.id === shown?.id}
					style:--agent={look.color}
					style:--l={b.left}
					style:--w={Math.max(b.width - 0.2, 0.2)}
					aria-label="{tip} (이 발언으로 이동)"
					title={tip}
					onclick={() => onjump(b.id)}
				></button>
			{/each}
		</div>
	{/if}

	<div class="dialog" bind:this={box}>
		{#if speakerLabel}<span class="name">{speakerLabel}</span>{/if}
		<p>
			{#each segments as s, i (i)}{#if s.em}<em>{s.text}</em>{:else}{s.text}{/if}{/each}{#if current && current.id === shown?.id}<i class="caret" aria-hidden="true"></i>{/if}
			{#if !segments.length}<span class="muted">{running ? '다음 발언을 기다리는 중…' : '아직 발언이 없습니다.'}</span>{/if}
		</p>
	</div>
</section>

<style>
	.court {
		--bg: var(--stage-bg, #120b14);
		--line: var(--stage-line, #3b2233);
		--accent: var(--stage-accent, #b3123c);
		--gold: var(--stage-gold, #c9a24a);
		--tx: var(--stage-text, #efe6df);
		--mut: var(--stage-muted, #9a8a88);
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		color: var(--tx);
	}
	.court.rest {
		--bg: var(--stage-rest-bg, #1d1520);
		--accent: var(--stage-rest-accent, #8d5a97);
	}
	.top {
		position: relative;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--line);
	}
	.seats {
		display: flex;
		gap: var(--s-1);
	}
	.seat {
		display: inline-grid;
		border-radius: 50%;
		outline: 1px solid transparent;
		outline-offset: 2px;
		transition: outline-color var(--dur) var(--ease);
	}
	.seat.judge {
		outline-color: var(--gold);
	}
	.seat.on {
		outline: 2px solid var(--accent);
	}
	.progress {
		flex: 1;
		min-width: 3rem;
		height: 2px;
		background: var(--line);
	}
	.progress i {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.5s var(--ease);
	}
	.round {
		font-size: var(--t-sm);
		color: var(--gold);
		white-space: nowrap;
	}
	.next {
		font-size: var(--t-xs);
		color: var(--mut);
		white-space: nowrap;
	}
	.floor {
		position: relative;
		flex: 1;
		min-height: 8rem;
		display: grid;
		place-items: center;
		overflow: hidden;
		container-type: size;
	}
	.portrait {
		animation: enter 0.4s var(--ease) both;
	}
	.evidence {
		position: absolute;
		top: var(--s-4);
		right: var(--s-4);
		display: grid;
		gap: 0.125rem;
		max-width: 16rem;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--gold);
		background: color-mix(in srgb, var(--bg) 88%, black);
		font-size: var(--t-sm);
		z-index: 3;
		animation: present 2s var(--ease) both;
	}
	.evidence b {
		font-size: var(--t-xs);
		color: var(--gold);
	}
	.evidence .sub {
		overflow: hidden;
		font-size: var(--t-xs);
		color: var(--mut);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.banner {
		position: absolute;
		inset: auto 0;
		padding: var(--s-2);
		border-block: 1px solid var(--gold);
		background: color-mix(in srgb, var(--bg) 80%, transparent);
		color: var(--gold);
		font-size: var(--t-2xl);
		font-weight: var(--w-bold);
		letter-spacing: 0.2em;
		text-align: center;
		z-index: 4;
		animation: declare 0.45s var(--ease) both;
	}
	.cutin {
		position: absolute;
		inset: auto 0;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-4);
		padding: var(--s-3);
		background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 55%, var(--bg)) 25%, color-mix(in srgb, var(--accent) 55%, var(--bg)) 75%, transparent);
		font-size: var(--t-2xl);
		animation: cross 1.2s cubic-bezier(0.2, 0.8, 0.8, 0.2) both;
	}
	.cutin b {
		font-weight: var(--w-bold);
		letter-spacing: 0.1em;
	}
	.gloom {
		position: absolute;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		animation: gloom 1.2s ease both;
	}
	.stamp {
		position: absolute;
		top: 12%;
		left: 8%;
		padding: var(--s-1) var(--s-3);
		border: 2px solid var(--accent);
		color: var(--accent);
		z-index: 2;
		font-size: var(--t-2xl);
		font-weight: var(--w-bold);
		letter-spacing: 0.3em;
		transform: rotate(-8deg);
		animation: stamp 0.5s 0.7s cubic-bezier(0.3, 1.6, 0.6, 1) both;
	}
	.trail {
		position: relative;
		flex: none;
		height: 0.625rem;
		overflow: hidden;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--bg) 85%, black);
	}
	.bar {
		position: absolute;
		inset: 0;
		padding: 0;
		border: none;
		border-radius: 0;
		background: var(--agent);
		opacity: 0.5;
		transform-origin: left;
		transform: translateX(calc(var(--l) * 1%)) scaleX(calc(var(--w) / 100));
		transition:
			opacity var(--dur-fast) var(--ease),
			transform 0.28s linear;
		will-change: transform;
		cursor: pointer;
	}
	.bar:hover,
	.bar.on {
		opacity: 1;
	}
	.bar.live {
		animation: bar-live 1.2s ease-in-out infinite;
	}
	.dialog {
		position: relative;
		flex: none;
		height: 38%;
		min-height: 9rem;
		overflow-y: auto;
		padding: var(--s-3) var(--s-5);
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--bg) 85%, black);
	}
	.name {
		display: inline-block;
		margin-bottom: var(--s-1);
		padding-bottom: 0.125rem;
		border-bottom: 1px solid var(--accent);
		font-weight: var(--w-bold);
	}
	p {
		margin: 0;
		font-size: var(--t-lg);
		line-height: 1.7;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	em {
		font-style: normal;
		font-weight: var(--w-bold);
		color: var(--gold);
	}
	.muted {
		color: var(--mut);
	}
	.caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		margin-left: 0.125em;
		vertical-align: -0.125em;
		background: var(--accent);
		animation: caret 1s steps(2) infinite;
	}
	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(0.5rem);
		}
	}
	@keyframes present {
		0% {
			opacity: 0;
			transform: translate(calc(-50cqw + 8rem), 30cqh) scale(0.8);
		}
		15%,
		70% {
			opacity: 1;
			transform: translate(calc(-50cqw + 8rem), 30cqh) scale(1.5);
		}
		100% {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes declare {
		from {
			opacity: 0;
			transform: scaleY(0.2);
			letter-spacing: 0.6em;
		}
	}
	@keyframes cross {
		0% {
			opacity: 0;
			transform: translateX(-30%);
		}
		20%,
		80% {
			opacity: 1;
			transform: none;
		}
		100% {
			opacity: 0;
			transform: translateX(30%);
		}
	}
	@keyframes gloom {
		from {
			opacity: 0;
		}
	}
	@keyframes stamp {
		from {
			opacity: 0;
			transform: rotate(-8deg) scale(2.4);
		}
	}
	@keyframes bar-live {
		50% {
			opacity: 1;
		}
	}
	@keyframes caret {
		50% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.portrait,
		.evidence,
		.banner,
		.cutin,
		.gloom,
		.stamp,
		.bar.live,
		.caret {
			animation: none;
		}
		.bar {
			transition: none;
		}
		.cutin {
			display: none;
		}
	}
</style>
