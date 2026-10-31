// 토론·협업·라운지 무대의 계산 (순수 함수): 발언 목록, 다음 사람, 라운드 표시, 타임라인 막대
import type { Debate, Message } from '@proprix/shared';

/** 이 토론의 발언 (사회 메시지인 user 는 빼고) */
export const debateSpeeches = (messages: readonly Message[], debateId: string): Message[] =>
	messages.filter((m) => m.role === 'assistant' && m.debateId === debateId);

/** 이 시각 뒤의 발언 (라운지 세션) */
export const speechesSince = (messages: readonly Message[], since: number): Message[] =>
	messages.filter((m) => m.role === 'assistant' && m.createdAt >= since);

/** 지금 답을 쓰는 발언, 없으면 null */
export const liveSpeech = (speeches: readonly Message[]): Message | null =>
	speeches.findLast((m) => m.status === 'streaming') ?? null;

/** 다음 발언자: 진행 중이고 지금 말하는 사람이 있을 때만. 마지막 라운드의 끝이면 진행자 */
export function nextSpeaker(d: Pick<Debate, 'agentIds' | 'moderatorId' | 'round' | 'rounds' | 'status'>, currentAgentId: string): string {
	if (d.status !== 'running' || !currentAgentId) return '';
	const i = d.agentIds.indexOf(currentAgentId);
	if (i < 0) return d.agentIds[0] ?? ''; // 진행자의 여는 말 다음은 첫 참가자
	if (d.round > d.rounds) return '';
	if (i === d.agentIds.length - 1 && d.round >= d.rounds) return d.moderatorId;
	return d.agentIds[(i + 1) % d.agentIds.length] ?? '';
}

export function roundLabel(d: Pick<Debate, 'round' | 'rounds' | 'status' | 'mode'>): string {
	if (d.status !== 'running') return { done: d.mode === 'collab' ? '완성' : '끝남', stopped: '중지됨', failed: '중단됨' }[d.status];
	return d.round === 0 ? '여는 말' : d.round > d.rounds ? '맺는 말' : `라운드 ${d.round} / ${d.rounds}`;
}

/** 단계 칩: 여는 말, 라운드들, 맺는 말과 지금 위치 */
export function roundSteps(d: Pick<Debate, 'round' | 'rounds' | 'status'>): { label: string; state: 'done' | 'now' | 'todo' }[] {
	const finished = d.status === 'done';
	return Array.from({ length: d.rounds + 2 }, (_, n) => ({
		label: n === 0 ? '여는 말' : n > d.rounds ? '맺는 말' : `라운드 ${n}`,
		state: finished || n < d.round ? ('done' as const) : n === d.round ? ('now' as const) : ('todo' as const)
	}));
}

/** 맺는 말: 토론이 끝났거나 맺는 라운드의 진행자 발언 */
export const closingSpeech = (speeches: readonly Message[], d: Pick<Debate, 'rounds' | 'moderatorId'>): Message | null =>
	speeches.findLast((m) => m.debateRound > d.rounds && m.agentId === d.moderatorId) ?? null;

/** 초점 발언: 글이 있는 마지막 발언 (맺는 말은 아래에 따로 고정). 다음 사람은 글을 쓰기 시작해야 초점이 된다 */
export function focusSpeech(speeches: readonly Message[], closingId: string): Message | null {
	const spoken = speeches.filter((m) => m.id !== closingId);
	return spoken.findLast((m) => m.content.trim() !== '') ?? spoken.at(-1) ?? speeches.at(-1) ?? null;
}

export interface TimelineBar {
	id: string;
	left: number; // % (앞선 발언 분량의 합)
	width: number; // % (이 발언의 분량)
	live: boolean;
	preview: string; // 막대에 마우스를 올리면 보이는 첫머리
}
export interface TimelineRow {
	agentId: string;
	bars: TimelineBar[];
}

// 메시지에 시작·끝 시각이 따로 없어 글 길이로 정한다: 시간 눈금이 아니라 발언 순서와 분량 (짧은 발언도 눌리게 최소 길이)
const MIN_WEIGHT = 200;
const PREVIEW_CHARS = 80;

// 코드 묶음과 마크다운 기호를 빼고 한 줄로
export function speechPreview(content: string): string {
	const t = content
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/<\/?[a-z][^>]*>/gi, '')
		.replace(/[#*_`>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}…` : t;
}

export function timelineRows(speeches: readonly Message[], seats: readonly string[]): TimelineRow[] {
	const weight = (m: Message) => Math.max(MIN_WEIGHT, m.content.length);
	const total = speeches.reduce((n, m) => n + weight(m), 0) || 1;
	const rows = new Map<string, TimelineBar[]>(seats.map((id) => [id, []]));
	let at = 0;
	for (const m of speeches) {
		const w = weight(m);
		if (!rows.has(m.agentId)) rows.set(m.agentId, []);
		rows.get(m.agentId)?.push({ id: m.id, left: (at / total) * 100, width: (w / total) * 100, live: m.status === 'streaming', preview: speechPreview(m.content) });
		at += w;
	}
	return [...rows.entries()].map(([agentId, bars]) => ({ agentId, bars }));
}
