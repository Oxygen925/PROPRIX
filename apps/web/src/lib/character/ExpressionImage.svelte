<script lang="ts">
	// 표정 묶음 캐릭터 (M2): 상태에 맞는 이미지로 바꾼다. 이미지가 여럿이면 번갈아 보이고, blink 가 있으면 가끔 깜박인다
	import type { CharacterPack } from '@proprix/shared';
	import type { MascotMotion } from './Mascot.svelte';

	let {
		pack,
		mood = 'idle',
		talking = false,
		motion = 'blink'
	}: { pack: CharacterPack; mood?: string; talking?: boolean; motion?: MascotMotion } = $props();

	const FRAME_MS = 180;
	const BLINK_MS = 140;

	const frames = $derived.by(() => {
		const idle = pack.expressions.idle ?? [];
		if (motion === 'none') return pack.thumbnail ? [pack.thumbnail] : idle.slice(0, 1);
		return (talking && pack.expressions.talking) || pack.expressions[mood] || idle;
	});
	const blink = $derived(motion === 'none' || talking ? undefined : pack.expressions.blink?.[0]);

	let index = $state(0);
	$effect(() => {
		const n = frames.length;
		index = 0;
		if (n < 2) return;
		const t = setInterval(() => (index = (index + 1) % n), FRAME_MS);
		return () => clearInterval(t);
	});

	let blinking = $state(false);
	$effect(() => {
		if (!blink) return;
		let t: ReturnType<typeof setTimeout>;
		const next = () => {
			t = setTimeout(() => {
				blinking = true;
				t = setTimeout(() => {
					blinking = false;
					next();
				}, BLINK_MS);
			}, 4000 + Math.random() * 3000);
		};
		next();
		return () => {
			clearTimeout(t);
			blinking = false;
		};
	});
</script>

<img src={blinking && blink ? blink : frames[index]} alt="" />

<style>
	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
