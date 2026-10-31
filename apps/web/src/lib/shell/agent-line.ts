// 사이드바·패널이 같이 쓰는 에이전트 표시 규칙
import type { Agent, AgentState, AgentStatus, Persona } from '@proprix/shared';

const DONE_FRESH_MS = 2 * 60_000; // 이 시간 동안만 '방금 끝냄'(초록)으로 보인다

export function relativeTime(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return '방금';
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86_400)}일 전`;
}

// 점 색·애니메이션에 쓰는 상태와 한 줄 문구
export function statusLine(s: AgentStatus | undefined, now: number): { state: AgentState; text: string } {
	if (!s) return { state: 'idle', text: '대기 중' };
	if (s.state === 'done' || s.state === 'idle')
		return {
			state: s.state === 'done' && now - s.at < DONE_FRESH_MS ? 'done' : 'idle',
			text: `${s.text} · ${relativeTime(s.at, now)}`
		};
	return { state: s.state, text: s.text };
}

// 이름 옆 직무: 역할 첫 줄(짧을 때) → 페르소나 소개
export function jobTitle(agent: Agent, persona: Persona | undefined): string {
	const first = agent.role.trim().split('\n')[0]?.replace(/^[-#*\s]+/, '').trim() ?? '';
	if (first && first.length <= 18) return first;
	return persona?.description.trim().slice(0, 18) ?? '';
}
