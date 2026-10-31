<script lang="ts">
	// 에이전트 아바타: 표정 묶음(있으면) > 이미지(움직이지 않음) > 마스코트 + 이모지 표식 + 색. status 를 주면 상태 점과 애니메이션
	// motion: 큰 곳은 full, 시선만 보일 곳은 gaze, 나머지는 깜박임만 (사용자 결정 2026-10-31)
	// (생각 중·작업 중: 그라데이션 원이 작아졌다 커진다, 확인 필요: 깜박임 — 움직임 줄이기 설정이면 멈춤)
	import { app } from '#lib/app.svelte.js';
	import { avatarBackground } from '#lib/character/colors.js';
	import { gaze } from '#lib/character/gaze.js';
	import ExpressionImage from '#lib/character/ExpressionImage.svelte';
	import Mascot, { type MascotMotion } from '#lib/character/Mascot.svelte';
	import { characterPacks } from '#lib/character/pack.svelte.js';
	import type { AgentState } from '@proprix/shared';

	// 캐릭터는 다른 UI 보다 조금 크게 (studio 테마, 사용자 결정 2026-10-30: 글자와 균형을 맞춘다)
	const SCALE = 1.1;

	let {
		agentId = '',
		emoji = '',
		color = '',
		image = '',
		personaId = '',
		size = 2,
		status,
		dot = true,
		motion = 'blink'
	}: {
		agentId?: string;
		emoji?: string;
		color?: string;
		image?: string;
		personaId?: string; // 에이전트 없이 그릴 때(편집기 미리보기) 표정 묶음을 찾는다
		size?: number;
		status?: AgentState;
		dot?: boolean;
		motion?: MascotMotion;
	} = $props();

	const look = $derived(
		agentId
			? app.look(agentId)
			: { name: '', emoji, color, image, personaId, character: personaId ? (app.persona(personaId)?.character ?? null) : null }
	);
	const pack = $derived(characterPacks.get(look.personaId, look.character));
	const moving = $derived(status === 'thinking' || status === 'working' || status === 'waiting');

	const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const live = $derived(app.characterMotion && !reduced ? motion : 'none');
	const tracks = $derived(!pack && !look.image && (live === 'full' || live === 'gaze'));
	// 표정은 모션이 보이는 곳과 표정 묶음에서 지금 상태를 따른다
	const face = $derived(status ?? ((tracks || pack) && agentId ? app.statuses[agentId]?.state : undefined) ?? 'idle');
	const talking = $derived(!!pack && !!agentId && app.messages.some((m) => m.agentId === agentId && m.status === 'streaming' && !!m.content));

	let wrap = $state<HTMLElement | undefined>();
	$effect(() => {
		if (wrap && tracks) return gaze.attach(wrap, agentId);
	});
</script>

<span bind:this={wrap} class="wrap {status ?? ''}" style:--size="{size * SCALE}rem" style:--glow={avatarBackground(look.color)} data-agent-avatar={agentId || undefined} aria-hidden="true">
	{#if moving}<span class="ring"></span>{/if}
	<span class="avatar" style:background={avatarBackground(look.color)} title={look.name}>
		{#if pack}<ExpressionImage {pack} mood={face} {talking} motion={live} />{:else if look.image}<img src={look.image} alt="" />{:else}<Mascot color={look.color} mood={face} motion={live} />{/if}
	</span>
	{#if !pack && !look.image && look.emoji && size >= 1.5}<span class="badge">{look.emoji}</span>{/if}
	{#if status && dot && status !== 'idle'}<span class="dot"></span>{/if}
</span>

<style>
	.wrap {
		position: relative;
		isolation: isolate;
		display: inline-grid;
		place-items: center;
		width: var(--size);
		height: var(--size);
		flex-shrink: 0;
	}
	.avatar {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		border-radius: 50%;
		font-size: calc(var(--size) * 0.55);
		line-height: 1;
		overflow: hidden;
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.badge {
		position: absolute;
		z-index: 2;
		left: calc(var(--size) * -0.04);
		bottom: calc(var(--size) * -0.04);
		display: grid;
		place-items: center;
		width: calc(var(--size) * 0.4);
		height: calc(var(--size) * 0.4);
		border-radius: 50%;
		background: var(--c-surface-1);
		font-size: calc(var(--size) * 0.25);
		line-height: 1;
		pointer-events: none;
	}
	.dot {
		position: absolute;
		z-index: 2;
		right: -1px;
		bottom: -1px;
		width: max(0.5rem, calc(var(--size) * 0.3));
		height: max(0.5rem, calc(var(--size) * 0.3));
		border-radius: 50%;
		border: 2px solid var(--c-surface-1);
		background: var(--c-text-4);
	}
	.thinking .dot,
	.working .dot {
		background: var(--c-working);
	}
	.waiting .dot {
		background: var(--c-waiting);
		animation: blink 1.2s ease-in-out infinite;
	}
	.blocked .dot {
		background: var(--c-danger);
	}
	.done .dot {
		background: var(--c-done);
	}
	/* 캐릭터 뒤 (앞의 .avatar 가 z-index 로 위에 온다) */
	.ring {
		position: absolute;
		z-index: 0;
		inset: -0.1875rem;
		border-radius: 50%;
		pointer-events: none;
	}
	.thinking .ring,
	.working .ring {
		inset: -35%;
		background: radial-gradient(circle, color-mix(in srgb, var(--glow, var(--c-accent)) 75%, white) 45%, transparent 70%);
		animation: pulse 1.8s ease-in-out infinite;
	}
	.working .ring {
		animation-duration: 1.1s;
	}
	.waiting .ring {
		border: 2px solid var(--c-waiting);
		animation: blink 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(0.72);
		}
		50% {
			opacity: 1;
			transform: scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ring {
			animation: none !important;
		}
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
</style>
