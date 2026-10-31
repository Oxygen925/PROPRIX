<script lang="ts">
	// 입력창의 모델·추론 강도 칩. 누르면 위로 팝오버:
	// - 1인 방: 추론 강도 슬라이더 + 모델 이름(> 로 목록). 고른 값은 그 에이전트 설정에 저장 (사용자 결정 2026-10-29)
	//   목록 맨 위 '기본' = 전역 기본 모델 따름
	// - 그룹방·라운지: 모델 목록만 (전역 기본 모델을 바꾼다. 추론 강도는 에이전트마다 각자 설정대로)
	import { app } from '#lib/app.svelte.js';
	import { toastError } from '#lib/ui/toast.svelte.js';
	import { AGENT_EFFORTS } from '@proprix/shared';
	import { EFFORT_LABEL } from './slash.js';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconChevronLeft from '@tabler/icons-svelte-runes/icons/chevron-left';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';

	// below: 작업대 패널처럼 위에 자리가 없는 곳에서는 아래로 편다
	let { below = false }: { below?: boolean } = $props();

	const group = $derived(app.roomAgents.length > 1);
	const lounge = $derived(app.room?.kind === 'lounge');
	const solo = $derived(!group && !lounge ? app.roomAgents[0] : undefined);

	const nameOf = (slug: string) => app.models.find((m) => m.slug === slug)?.displayName ?? slug;
	const globalName = $derived(app.model ? nameOf(app.model) : '모델 없음');
	// 실제로 쓰는 모델: 1인 방은 에이전트 지정 모델, 없으면 전역 기본
	const usedSlug = $derived(solo?.model || app.model);
	const usedName = $derived(usedSlug ? nameOf(usedSlug) : '모델 없음');

	// 모델 목록이 지원 단계를 알려 주면 그것만 (자동은 늘)
	const efforts = $derived.by(() => {
		const supported = app.models.find((m) => m.slug === usedSlug)?.efforts ?? [];
		return AGENT_EFFORTS.filter((e) => e === '' || supported.length === 0 || supported.includes(e));
	});
	let draft = $state<number | null>(null); // 끄는 동안의 위치 (놓으면 저장)
	const index = $derived(draft ?? Math.max(0, efforts.indexOf(solo?.reasoningEffort ?? '')));
	const current = $derived(efforts[index] ?? '');
	const frac = (i: number) => (efforts.length > 1 ? i / (efforts.length - 1) : 0);

	let open = $state(false);
	let view = $state<'effort' | 'models'>('effort');
	let root: HTMLDivElement | undefined = $state();

	function toggle() {
		open = !open;
		view = solo ? 'effort' : 'models';
	}

	// /model · /effort 가 연다
	export function show() {
		open = true;
		view = solo ? 'effort' : 'models';
	}

	$effect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			if (view === 'models' && solo) view = 'effort';
			else open = false;
		};
		document.addEventListener('pointerdown', onDown);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onDown);
			document.removeEventListener('keydown', onKey, true);
		};
	});

	async function save(task: () => Promise<void>) {
		try {
			await task();
		} catch (e) {
			toastError(e);
		}
	}

	// 저장이 끝날 때까지 놓은 자리를 유지한다 (먼저 비우면 옛 값으로 튀었다가 돌아온다)
	async function saveEffort(i: number) {
		const e = efforts[i] ?? '';
		if (!solo || e === solo.reasoningEffort) {
			draft = null;
			return;
		}
		draft = i;
		await save(() => app.setEffort(solo.id, e));
		if (draft === i) draft = null;
	}

	function pickModel(slug: string) {
		if (solo) {
			if (slug !== solo.model) void save(() => app.setAgentModel(solo.id, slug));
			view = 'effort';
		} else {
			app.setModel(slug);
			open = false;
		}
	}
</script>

<div class="picker" bind:this={root}>
	<button
		type="button"
		class="chip"
		aria-haspopup="dialog"
		aria-expanded={open}
		disabled={app.models.length === 0}
		onclick={toggle}
	>
		<span class="m">{usedName}</span>
		{#if solo && current}<span class="e">{EFFORT_LABEL[current]}</span>{/if}
		<IconChevronDown size="0.65rem" aria-hidden="true" />
	</button>

	{#if open}
		<div class="pop" class:below role="dialog" aria-label={view === 'effort' ? '추론 강도' : '모델 선택'}>
			{#if view === 'effort' && solo}
				<div class="effort">
					<div class="title">{EFFORT_LABEL[current]}</div>
					<button type="button" class="model-link" onclick={() => (view = 'models')}>
						{usedName}{#if !solo.model}<span class="sub"> · 기본</span>{/if}
						<IconChevronRight size="0.65rem" aria-hidden="true" />
					</button>
					<div class="track" style:--p={frac(index)}>
						<div class="fill"></div>
						<div class="dots">
							{#each efforts as e, i (e)}
								<span class="dot" class:hidden={i === index} style:left="{frac(i) * 100}%"></span>
							{/each}
						</div>
						<input
							type="range"
							min="0"
							max={efforts.length - 1}
							step="1"
							value={index}
							aria-label="{solo.name}의 추론 강도"
							aria-valuetext={EFFORT_LABEL[current]}
							oninput={(e) => (draft = Number(e.currentTarget.value))}
							onchange={(e) => saveEffort(Number(e.currentTarget.value))}
						/>
					</div>
					<p class="hint">{solo.name}의 모든 요청에 적용 · 높을수록 느리고 사용량을 더 씀</p>
				</div>
			{:else}
				<div class="models">
					<div class="head">
						{#if solo}
							<button type="button" class="back" aria-label="추론 강도로 돌아가기" onclick={() => (view = 'effort')}>
								<IconChevronLeft size="0.7rem" aria-hidden="true" />
							</button>
						{/if}
						<span>모델 선택</span>
					</div>
					<ul role="listbox" aria-label="모델">
						{#if solo}
							<li role="option" aria-selected={!solo.model}>
								<button type="button" onclick={() => pickModel('')}>
									<span class="opt">
										<span>기본</span>
										<span class="sub">전역 기본 모델 따름 · {globalName}</span>
									</span>
									{#if !solo.model}<IconCheck size="0.75rem" aria-hidden="true" />{/if}
								</button>
							</li>
						{/if}
						{#each app.models as m (m.slug)}
							{@const on = solo ? solo.model === m.slug : app.model === m.slug}
							<li role="option" aria-selected={on}>
								<button type="button" onclick={() => pickModel(m.slug)}>
									<span class="opt">{m.displayName}</span>
									{#if on}<IconCheck size="0.75rem" aria-hidden="true" />{/if}
								</button>
							</li>
						{/each}
					</ul>
					{#if !solo}<p class="hint">{group ? '이 채팅 참여자 중 지정 모델이 없는 에이전트가 씁니다.' : '전역 기본 모델'}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* 크기는 처음 설계의 70% (사용자 결정 2026-10-29) */
	.picker {
		position: relative;
		display: inline-flex;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 12.6rem;
		padding: 0.15rem 0.35rem 0.15rem 0.55rem;
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-pill);
		background: var(--c-surface-3);
		color: var(--c-text);
		font-size: var(--t-xs);
		white-space: nowrap;
	}
	.chip .m {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chip .e {
		color: var(--c-text-3);
	}
	.pop {
		position: absolute;
		right: 0;
		bottom: calc(100% + var(--s-2));
		z-index: 40;
		width: 12.6rem;
		padding: 0.55rem;
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		background: var(--c-surface-3);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.5);
		animation: rise var(--dur-fast) var(--ease);
	}
	.pop.below {
		right: auto;
		left: 0;
		bottom: auto;
		top: calc(100% + var(--s-2));
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(0.2rem);
		}
	}

	/* 추론 강도 */
	.effort {
		display: grid;
		justify-items: center;
		gap: 0.15rem;
	}
	.title {
		color: var(--c-working);
		font-size: var(--t-md);
		font-weight: var(--w-bold);
	}
	.model-link {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0.05rem 0.2rem;
		border: none;
		background: none;
		color: var(--c-text);
		font-size: var(--t-xs);
	}
	.model-link:hover {
		background: var(--c-hover);
	}
	.sub {
		color: var(--c-text-3);
	}
	/* 바보다 손잡이를 조금 크게: 손잡이 중심은 양 끝에서 반지름만큼 안쪽까지 움직인다 */
	.track {
		--h: 1.2rem;
		--knob: 1.45rem;
		position: relative;
		width: 100%;
		height: var(--h);
		margin: 0.45rem 0 0.15rem;
		border-radius: var(--r-pill);
		background: var(--c-surface-1);
		box-shadow: inset 0 0 0 1px var(--c-line);
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--knob) / 2 + (100% - var(--knob)) * var(--p));
		border-radius: var(--r-pill);
		background: var(--c-working);
		opacity: 0.85;
	}
	.dots {
		position: absolute;
		inset: 0 calc(var(--knob) / 2);
		pointer-events: none;
	}
	.dot {
		position: absolute;
		top: 50%;
		width: 0.22rem;
		height: 0.22rem;
		margin: -0.11rem 0 0 -0.11rem;
		border-radius: 50%;
		background: var(--c-text-3);
	}
	.dot.hidden {
		visibility: hidden;
	}
	.track input {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		width: 100%;
		height: var(--knob);
		margin: 0;
		padding: 0;
		transform: translateY(-50%);
		background: transparent;
		border: none;
		appearance: none;
		cursor: pointer;
	}
	.track input:focus-visible {
		box-shadow: none;
	}
	.track input:focus-visible::-webkit-slider-thumb {
		box-shadow: var(--focus-ring);
	}
	.track input::-webkit-slider-runnable-track {
		height: var(--knob);
		background: transparent;
	}
	.track input::-webkit-slider-thumb {
		appearance: none;
		width: var(--knob);
		height: var(--knob);
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.45);
	}
	.track input::-moz-range-thumb {
		width: var(--knob);
		height: var(--knob);
		border: none;
		border-radius: 50%;
		background: #fff;
	}
	.hint {
		margin-top: 0.15rem;
		color: var(--c-text-4);
		font-size: 0.6rem;
		text-align: center;
	}

	/* 모델 목록 */
	.head {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0 0.2rem 0.35rem;
		color: var(--c-text-3);
		font-size: var(--t-xs);
	}
	.back {
		display: inline-grid;
		place-items: center;
		padding: 0.1rem;
		border: none;
		background: none;
		color: var(--c-text-3);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 12.6rem;
		overflow-y: auto;
	}
	ul button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.35rem;
		width: 100%;
		padding: 0.3rem 0.4rem;
		border: none;
		border-radius: var(--r-1);
		background: none;
		color: var(--c-text);
		font-size: var(--t-sm);
		text-align: left;
	}
	ul button:hover,
	ul button:focus-visible {
		background: var(--c-hover);
		box-shadow: none;
	}
	.opt {
		display: grid;
		min-width: 0;
	}
	.opt .sub {
		font-size: 0.6rem;
	}
</style>
