<script lang="ts">
	// 기본 캐릭터 (벡터 마스코트, 사용자 지정 그림 2026-10-31). 시선은 부모가 넣는 CSS 변수 --gx, --gy 를 따른다.
	// 원은 고정, 눈은 시선을 따르고 궤도 호는 돈다 (사용자 결정 2026-10-31). 입은 없다. 배경은 아바타의 원.
	// motion: full·gaze = 시선·깜박임·궤도, blink = 깜박임만, none = 정지
	import type { AgentState } from '@proprix/shared';
	import { mascotColors } from './colors';
	import { orbitRate, spinOrbit } from './orbit';

	export type MascotMotion = 'full' | 'gaze' | 'blink' | 'none';

	let {
		color = '',
		mood = 'idle',
		motion = 'blink'
	}: { color?: string; mood?: AgentState; motion?: MascotMotion } = $props();

	const colors = $derived(mascotColors(color));
	// 여러 캐릭터가 한꺼번에 깜박이지 않게 (한 번 정한 값 유지)
	const blinkFor = `${(4 + Math.random() * 3).toFixed(2)}s`;
	const blinkDelay = `${(-Math.random() * 7).toFixed(2)}s`;

	// 궤도 회전: 생각 중·출력 중에는 점진적으로 빨라진다
	const spinning = $derived(motion === 'full' || motion === 'gaze');
	let orbit = $state<SVGGElement | undefined>();
	let spin = $state<ReturnType<typeof spinOrbit> | undefined>();
	$effect(() => {
		if (!orbit || !spinning || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const s = spinOrbit(orbit);
		spin = s;
		return () => {
			s.stop();
			spin = undefined;
		};
	});
	$effect(() => {
		spin?.setRate(orbitRate(mood));
	});
</script>

<svg
	class="mascot {motion} {mood}"
	viewBox="12 12 488 488"
	style:--core={colors.core}
	style:--orbit={colors.orbit}
	style:--blink-for={blinkFor}
	style:--blink-delay={blinkDelay}
	aria-hidden="true"
>
	<g class="orbit" bind:this={orbit}>
		<path d="M 128.68 133.05 A 177 177 0 0 1 246.74 79.24" />
		<path d="M 362.52 114.64 A 177 177 0 0 1 237.50 432.03" />
		<path d="M 142.23 391.59 A 177 177 0 0 1 80.32 234.43" />
	</g>
	<circle class="core" cx="256" cy="256" r="125" />
	<g class="look">
		<g class="eyes">
			<path class="eye" d="M224 204 L224 246" />
			<path class="eye" d="M288 204 L288 246" />
		</g>
	</g>
</svg>

<style>
	.mascot {
		display: block;
		width: 100%;
		height: 100%;
		--ink: var(--mascot-ink, #202b52);
	}
	.orbit {
		fill: none;
		stroke: var(--orbit);
		stroke-width: 32;
		stroke-linecap: round;
	}
	.core {
		fill: var(--core);
	}
	.eye {
		fill: none;
		stroke: var(--ink);
		stroke-width: 19;
		stroke-linecap: round;
	}
	/* 512 칸 기준 */
	.look,
	.eyes,
	.eye {
		transform-box: fill-box;
		transform-origin: center;
	}
	.orbit {
		transform-box: view-box;
		transform-origin: 256px 256px;
	}
	/* 시선: 눈만 */
	.gaze .look,
	.full .look {
		transform: translate(calc(var(--gx, 0) * 30px), calc(var(--gy, 0) * 22px));
	}
	/* 표정 */
	.thinking .eyes {
		transform: translate(8px, -14px);
	}
	.working .eyes {
		transform: scaleY(0.72);
	}
	.waiting .eyes {
		transform: scale(1.16);
	}
	.done .eyes {
		transform: scaleY(0.8);
	}
	/* 움직임 */
	.blink .eye,
	.gaze .eye,
	.full .eye {
		animation: blink var(--blink-for) linear var(--blink-delay) infinite;
	}
	@keyframes blink {
		0%,
		95%,
		100% {
			transform: scaleY(1);
		}
		97.5% {
			transform: scaleY(0.08);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.eye {
			animation: none !important;
		}
	}
</style>
