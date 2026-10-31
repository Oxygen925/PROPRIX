import { expect, test } from 'bun:test';
import { buildGrid, cellSummary } from './heatmap';

const today = new Date(2026, 9, 29); // 목요일

test('격자: 53주 × 7일, 첫 칸은 일요일, 오늘 뒤는 미래, 범주로 거른 합계와 단계', () => {
	const days = [
		{ date: '2026-10-29', feature: 'chat', count: 8 },
		{ date: '2026-10-29', feature: 'router', count: 2 },
		{ date: '2026-10-28', feature: 'tasks', count: 1 },
		{ date: '2025-01-01', feature: 'chat', count: 99 } // 범위 밖
	];
	const all = buildGrid(days, today, null);
	expect(all.weeks).toHaveLength(53);
	expect(all.weeks.every((w) => w.length === 7)).toBe(true);
	expect(new Date(`${all.weeks[0]?.[0]?.date}T00:00`).getDay()).toBe(0);
	const last = all.weeks.at(-1) ?? [];
	expect(last[4]).toMatchObject({ date: '2026-10-29', count: 10, level: 4, future: false });
	expect(last[3]).toMatchObject({ date: '2026-10-28', count: 1, level: 1 });
	expect(last[5]?.future).toBe(true);
	expect(all.total).toBe(11);

	const chat = buildGrid(days, today, ['chat']);
	expect(chat.total).toBe(8);
	expect((chat.weeks.at(-1) ?? [])[3]?.level).toBe(0);
	expect(chat.months.at(-1)).toEqual({ col: expect.any(Number), label: '10월' });
});

test('칸 요약: 많은 순, 예산이 있으면 비율, 많으면 외 n개', () => {
	const grid = buildGrid(
		[
			{ date: '2026-10-29', feature: 'chat', count: 43 },
			{ date: '2026-10-29', feature: 'memory', count: 20 },
			{ date: '2026-10-29', feature: 'router', count: 1 }
		],
		today,
		null
	);
	const cell = (grid.weeks.at(-1) ?? [])[4];
	if (!cell) throw new Error('no cell');
	const s = cellSummary(cell, { chat: null, memory: 50, router: 200 }, (f) => f.toUpperCase(), 2);
	expect(s.title).toContain('64회');
	expect(s.lines).toEqual(['CHAT 43회', 'MEMORY 20/50 (40%)', '외 1개']);
});
