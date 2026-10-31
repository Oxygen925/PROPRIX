// 작업실 (사용자 결정 2026-10-31): 에이전트가 지금 하는 일로 칸을 정한다. 이미 오는 상태 이벤트만 쓴다 (플랜 사용량 없음)
import type { AgentState } from '@proprix/shared';

export const ZONES = [
	{ id: 'search', label: '검색' },
	{ id: 'tools', label: '도구' },
	{ id: 'write', label: '글쓰기' },
	{ id: 'debate', label: '토론' },
	{ id: 'research', label: '리서치' },
	{ id: 'rest', label: '쉬는 곳' }
] as const;

export type ZoneId = (typeof ZONES)[number]['id'];

const COLUMNS = 3;
const ROWS = 2;
const LABEL = 0.2; // 칸 위쪽의 이름 자리

export function zoneOf(s: { state: AgentState; text: string; debate?: boolean; lounge?: boolean; researching?: boolean }): ZoneId {
	// 토론 중에는 자기 차례가 아니어도 토론 칸에 머문다 (차례마다 오가지 않게)
	if (s.debate) return 'debate';
	const active = s.state === 'thinking' || s.state === 'working' || s.state === 'waiting';
	// 채팅에서 일하면 그쪽을 먼저 보여 준다. 끝난 뒤에도 리서치가 돌면 리서치
	if (!active) return s.researching ? 'research' : 'rest';
	if (s.lounge) return 'rest';
	if (s.state === 'waiting') return 'tools';
	if (s.state === 'thinking') return 'write';
	if (/ 실행 중$/.test(s.text)) return /검색|읽기|목록/.test(s.text) ? 'search' : 'tools';
	if (/맡기는 중|작업자 \d+명/.test(s.text)) return 'tools';
	return 'write';
}

// 한 칸에 사람이 많으면 작게 그린다: 보통(캐릭터·이름·상태) → 작게(이름까지) → 아주 작게(캐릭터만, 이름은 툴팁)
export type ZoneDensity = 'normal' | 'compact' | 'tiny';
export const zoneDensity = (count: number): ZoneDensity => (count <= 6 ? 'normal' : count <= 12 ? 'compact' : 'tiny');
const perRowOf = (count: number): number => {
	const density = zoneDensity(count);
	return density === 'normal' ? 3 : density === 'compact' ? 4 : Math.max(6, Math.ceil(count / 4));
};

// 칸 안의 자리 (화면 비율 %, 캐릭터 가운데 기준)
export function slotPosition(zone: ZoneId, index: number, count: number): { left: number; top: number } {
	const z = ZONES.findIndex((x) => x.id === zone);
	const col = z % COLUMNS;
	const row = Math.floor(z / COLUMNS);
	const limit = perRowOf(count);
	const perRow = Math.max(1, Math.min(count, limit));
	const lines = Math.max(1, Math.ceil(count / limit));
	const x = (index % limit) + 0.5;
	const y = Math.floor(index / limit) + 0.5;
	return {
		left: ((col + x / perRow) / COLUMNS) * 100,
		top: ((row + LABEL + (y / lines) * (1 - LABEL)) / ROWS) * 100
	};
}
