// 캐릭터 시선 (사용자 결정 2026-10-31): 다른 에이전트가 말하면 그쪽 → 입력 중이면 입력창 → 마우스 커서 → 가끔 둘러보기.
// 값은 Svelte 상태를 거치지 않고 요소의 CSS 변수(--gx, --gy: -1~1)로 바로 넣는다. 움직일 것이 없으면 프레임 루프를 멈춘다
export interface Point {
	x: number;
	y: number;
}

const RANGE = 320; // 이 거리(px) 이상이면 끝까지 돌린다
const SPEAKER_POWER = 0.8; // 말하는 에이전트는 바로 옆에 있어도 돌아본다
const SMOOTH = 0.14;
const SETTLED = 0.002;
const INPUT_MS = 3000; // 마지막 입력 뒤 이만큼 입력창을 본다
const IDLE_MS = 6000; // 커서가 멈추고 이만큼 지나면 둘러본다
const WANDER_MS = 2500;
const SEEK = '[data-gaze-input]';

// 내 위치에서 목표까지의 방향·세기 (-1~1). 목표가 없으면 정면. atLeast: 가까워도 확실히 돌아보게 하는 최소 세기
export function gazeVector(from: Point, to: Point | null, atLeast = 0): Point {
	if (!to) return { x: 0, y: 0 };
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	if (dist < 1) return { x: 0, y: 0 };
	const power = Math.max(Math.min(dist / RANGE, 1), atLeast);
	return { x: (dx / dist) * power, y: (dy / dist) * power };
}

// 같은 에이전트의 아바타가 여럿이면 나와 가장 가까운 것 (같은 패널·머리 안의 화자를 보게)
export function nearest(from: Point, points: readonly Point[]): Point | null {
	let best: Point | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const p of points) {
		const dist = Math.hypot(p.x - from.x, p.y - from.y);
		if (dist < bestDist) {
			best = p;
			bestDist = dist;
		}
	}
	return best;
}

export type GazeSource ='speaker' | 'input' | 'pointer' | 'wander';

// 무엇을 볼지: 말하는 다른 에이전트 > 입력 중 > 움직이는 커서 > 둘러보기
export function gazeSource(s: { otherSpeaking: boolean; typing: boolean; pointerActive: boolean }): GazeSource {
	if (s.otherSpeaking) return 'speaker';
	if (s.typing) return 'input';
	return s.pointerActive ? 'pointer' : 'wander';
}

interface Entry {
	agentId: string;
	x: number;
	y: number;
}

const center = (el: Element): Point | null => {
	const r = el.getBoundingClientRect();
	return r.width === 0 ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

class GazeTracker {
	private readonly entries = new Map<HTMLElement, Entry>();
	private pointer: Point | null = null;
	private pointerAt = 0;
	private inputEl: Element | null = null;
	private inputAt = 0;
	private speaker = '';
	private wander: Point = { x: 0, y: 0 };
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	private readonly onPointer = (e: PointerEvent) => {
		this.pointer = { x: e.clientX, y: e.clientY };
		this.pointerAt = Date.now();
		this.wake();
	};

	private readonly onInput = (e: Event) => {
		if (!(e.target instanceof Element) || !e.target.matches(SEEK)) return;
		this.inputEl = e.target;
		this.inputAt = Date.now();
		this.wake();
	};

	// 입력·커서가 끝난 것은 이벤트가 없으므로 주기적으로 다시 본다
	private readonly tick = () => {
		if (document.hidden) return;
		const now = Date.now();
		if (now - this.pointerAt > IDLE_MS) {
			this.wander = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 0.6 };
		}
		this.wake();
	};

	// 움직일 요소를 등록한다. 돌려준 함수로 해제
	attach(el: HTMLElement, agentId: string): () => void {
		if (this.entries.size === 0) {
			addEventListener('pointermove', this.onPointer, { passive: true });
			document.addEventListener('input', this.onInput);
			this.timer = setInterval(this.tick, WANDER_MS);
		}
		this.entries.set(el, { agentId, x: 0, y: 0 });
		this.wake();
		return () => {
			this.entries.delete(el);
			if (this.entries.size > 0) return;
			removeEventListener('pointermove', this.onPointer);
			document.removeEventListener('input', this.onInput);
			clearInterval(this.timer);
			cancelAnimationFrame(this.frame);
			this.frame = 0;
		};
	}

	setSpeaker(agentId: string) {
		if (this.speaker === agentId) return;
		this.speaker = agentId;
		this.wake();
	}

	private wake() {
		if (!this.frame && this.entries.size > 0) this.frame = requestAnimationFrame(this.step);
	}

	// 말하는 에이전트의 아바타들 (목록·머리·패널에 여러 개 있을 수 있다)
	private speakerPoints(): Point[] {
		if (!this.speaker) return [];
		const els = document.querySelectorAll(`[data-agent-avatar="${CSS.escape(this.speaker)}"]`);
		return [...els].flatMap((el) => center(el) ?? []);
	}

	private readonly step = () => {
		this.frame = 0;
		const now = Date.now();
		const typing = !!this.inputEl && document.activeElement === this.inputEl && now - this.inputAt < INPUT_MS;
		const inputPoint = typing && this.inputEl ? center(this.inputEl) : null;
		const speakerPoints = this.speakerPoints();
		const pointerActive = !!this.pointer && now - this.pointerAt <= IDLE_MS;
		let moving = false;
		for (const [el, e] of this.entries) {
			const me = center(el);
			if (!me) continue;
			const speakerPoint = nearest(me, speakerPoints);
			const otherSpeaking = !!speakerPoint && this.speaker !== e.agentId;
			const source = gazeSource({ otherSpeaking, typing: !!inputPoint, pointerActive });
			const want =
				source === 'speaker'
					? gazeVector(me, speakerPoint, SPEAKER_POWER)
					: source === 'input'
						? gazeVector(me, inputPoint)
						: source === 'pointer'
							? gazeVector(me, this.pointer)
							: this.wander;
			const dx = want.x - e.x;
			const dy = want.y - e.y;
			if (Math.abs(dx) < SETTLED && Math.abs(dy) < SETTLED) continue;
			e.x += dx * SMOOTH;
			e.y += dy * SMOOTH;
			el.style.setProperty('--gx', e.x.toFixed(3));
			el.style.setProperty('--gy', e.y.toFixed(3));
			moving = true;
		}
		if (moving) this.wake();
	};
}

export const gaze = new GazeTracker();
