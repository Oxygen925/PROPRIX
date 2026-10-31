import { expect, test } from 'bun:test';
import { slotPosition, zoneDensity, zoneOf } from './zones';

test('칸 정하기: 지금 하는 일로', () => {
	expect(zoneOf({ state: 'idle', text: '대기 중' })).toBe('rest');
	expect(zoneOf({ state: 'done', text: '답함' })).toBe('rest');
	expect(zoneOf({ state: 'blocked', text: '사용량 한도' })).toBe('rest');
	expect(zoneOf({ state: 'thinking', text: '생각 중' })).toBe('write');
	expect(zoneOf({ state: 'working', text: '답하는 중' })).toBe('write');
	expect(zoneOf({ state: 'working', text: '작업자 결과 정리 중' })).toBe('write');
	expect(zoneOf({ state: 'working', text: '기억 검색 실행 중' })).toBe('search');
	expect(zoneOf({ state: 'working', text: '파일 읽기 실행 중' })).toBe('search');
	expect(zoneOf({ state: 'working', text: '파일 편집 실행 중' })).toBe('tools');
	expect(zoneOf({ state: 'working', text: '비서에게 맡기는 중' })).toBe('tools');
	expect(zoneOf({ state: 'working', text: '작업자 2명 실행 중' })).toBe('tools');
	expect(zoneOf({ state: 'waiting', text: '확인 필요 · 메모 저장' })).toBe('tools');
});

test('칸 정하기: 토론·라운지·리서치', () => {
	expect(zoneOf({ state: 'thinking', text: '생각 중', debate: true })).toBe('debate');
	expect(zoneOf({ state: 'waiting', text: '확인 필요 · 메모 저장', debate: true })).toBe('debate');
	expect(zoneOf({ state: 'working', text: '답하는 중', lounge: true })).toBe('rest');
	expect(zoneOf({ state: 'idle', text: '대기 중', researching: true })).toBe('research');
	// 채팅에서 일하면 그쪽이 먼저. 토론 중에는 차례가 끝나도 토론 칸
	expect(zoneOf({ state: 'working', text: '답하는 중', researching: true })).toBe('write');
	expect(zoneOf({ state: 'done', text: '답함', debate: true })).toBe('debate');
});

test('자리: 칸 안에 들어오고 겹치지 않는다', () => {
	expect(slotPosition('search', 0, 1)).toEqual({ left: (0.5 / 3) * 100, top: ((0.2 + 0.5 * 0.8) / 2) * 100 });
	const rest = [0, 1, 2, 3].map((i) => slotPosition('rest', i, 4));
	for (const p of rest) {
		expect(p.left).toBeGreaterThan(100 * (2 / 3));
		expect(p.left).toBeLessThan(100);
		expect(p.top).toBeGreaterThan(50);
		expect(p.top).toBeLessThan(100);
	}
	expect(new Set(rest.map((p) => `${p.left},${p.top}`)).size).toBe(4);
});

test('자리: 많을수록 작게 그리고 줄을 늘려 칸 안에 둔다', () => {
	expect([6, 7, 12, 13].map(zoneDensity)).toEqual(['normal', 'compact', 'compact', 'tiny']);
	for (const count of [7, 12, 13, 24, 30]) {
		const spots = Array.from({ length: count }, (_, i) => slotPosition('rest', i, count));
		expect(new Set(spots.map((p) => `${p.left},${p.top}`)).size).toBe(count);
		for (const p of spots) {
			expect(p.left).toBeGreaterThan(100 * (2 / 3));
			expect(p.left).toBeLessThan(100);
			expect(p.top).toBeGreaterThan(50);
			expect(p.top).toBeLessThan(100);
		}
	}
	// 7명은 네 칸씩 두 줄
	expect(slotPosition('rest', 4, 7).top).toBeGreaterThan(slotPosition('rest', 3, 7).top);
});
