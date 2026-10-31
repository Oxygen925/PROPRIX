// 궤도 호 회전 (사용자 결정 2026-10-31): 속도를 바꿀 때 CSS animation-duration 은 위치가 튀므로
// Web Animations 의 playbackRate 를 조금씩 바꾼다 (재생률을 바꿔도 지금 각도는 유지된다)
const ORBIT_MS = 12_000; // 평소 한 바퀴
const RAMP_MS = 500; // 목표 속도에 다가가는 시간 상수 (이 시간에 남은 차이의 약 63%)
const CLOSE = 0.01;

export function orbitRate(state: string): number {
	if (state === 'working') return ORBIT_MS / 2200;
	if (state === 'thinking') return ORBIT_MS / 4000;
	return 1;
}

// 지금 재생률에서 dt(ms) 뒤의 재생률. 충분히 가까우면 목표에 맞춘다
export function rampRate(current: number, target: number, dt: number): number {
	const next = current + (target - current) * (1 - Math.exp(-dt / RAMP_MS));
	return Math.abs(target - next) < CLOSE ? target : next;
}

// el 을 계속 돌리고, 돌려준 setRate 로 속도를 점진적으로 바꾼다. stop 으로 멈춘다
export function spinOrbit(el: Element): { setRate: (rate: number) => void; stop: () => void } {
	const spin = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: ORBIT_MS, iterations: Infinity });
	let target = 1;
	let frame = 0;
	let last = 0;
	const step = (now: number) => {
		frame = 0;
		spin.playbackRate = rampRate(spin.playbackRate, target, Math.min(now - last, 100));
		last = now;
		if (spin.playbackRate !== target) frame = requestAnimationFrame(step);
	};
	return {
		setRate(rate) {
			target = rate;
			if (frame || spin.playbackRate === target) return;
			last = performance.now();
			frame = requestAnimationFrame(step);
		},
		stop() {
			cancelAnimationFrame(frame);
			spin.cancel();
		}
	};
}
