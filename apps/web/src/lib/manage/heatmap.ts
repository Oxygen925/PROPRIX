// 사용량 히트맵 (P10c): 날짜·기능별 요청 수 → 주(열) × 요일(행, 일~토) 격자. GitHub 방식으로 최근 1년
import type { UsageHistory } from '@proprix/shared';

export type UsageGroupKey = 'all' | 'chat' | 'delegate' | 'debate' | 'lounge' | 'tasks' | 'research' | 'other';
export const USAGE_GROUPS: { key: UsageGroupKey; label: string; features: readonly string[] | null }[] = [
	{ key: 'all', label: '전체', features: null },
	{ key: 'chat', label: '채팅', features: ['chat'] },
	{ key: 'delegate', label: '위임·작업자', features: ['delegate'] },
	{ key: 'debate', label: '토론·협업', features: ['debate'] },
	{ key: 'lounge', label: '라운지', features: ['lounge'] },
	{ key: 'tasks', label: '예약', features: ['tasks'] },
	{ key: 'research', label: '리서치', features: ['research'] },
	{ key: 'other', label: '기타', features: ['router', 'memory', 'summary', 'proactive', 'preview'] }
];

export interface Cell {
	date: string; // YYYY-MM-DD (로컬)
	count: number;
	level: 0 | 1 | 2 | 3 | 4;
	future: boolean;
	byFeature: Record<string, number>;
}

export interface Grid {
	weeks: Cell[][];
	months: { col: number; label: string }[];
	total: number;
	max: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function buildGrid(
	days: UsageHistory['days'],
	today: Date,
	features: readonly string[] | null,
	weeks = 53
): Grid {
	const byDate = new Map<string, Record<string, number>>();
	for (const d of days) {
		const f = byDate.get(d.date) ?? {};
		f[d.feature] = (f[d.feature] ?? 0) + d.count;
		byDate.set(d.date, f);
	}
	const countOf = (f: Record<string, number>) =>
		Object.entries(f).reduce((n, [k, v]) => n + (features === null || features.includes(k) ? v : 0), 0);

	const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const start = new Date(end);
	start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7); // 첫 열의 일요일
	const cols: Cell[][] = [];
	const months: Grid['months'] = [];
	let total = 0;
	let max = 0;
	const cur = new Date(start);
	for (let w = 0; w < weeks; w++) {
		const col: Cell[] = [];
		for (let d = 0; d < 7; d++) {
			const date = localDate(cur);
			const byFeature = byDate.get(date) ?? {};
			const future = cur > end;
			const count = future ? 0 : countOf(byFeature);
			total += count;
			max = Math.max(max, count);
			if (cur.getDate() === 1 && !future) months.push({ col: w, label: `${cur.getMonth() + 1}월` });
			col.push({ date, count, level: 0, future, byFeature });
			cur.setDate(cur.getDate() + 1);
		}
		cols.push(col);
	}
	for (const c of cols.flat())
		c.level = c.count === 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((4 * c.count) / max))) as Cell['level']);
	return { weeks: cols, months, total, max };
}

// 칸에 커서를 올리면 보이는 요약: 범주별 요청 수, 예산이 있으면 지금 예산 기준 사용 비율 (예산 변경 이력은 없다 — 사용자 결정 2026-10-30)
export function cellSummary(
	c: Cell,
	limits: Partial<Record<string, number | null>>,
	label: (feature: string) => string,
	max = 5
): { title: string; lines: string[] } {
	const title = `${new Date(`${c.date}T00:00`).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} · ${c.count}회`;
	const rows = Object.entries(c.byFeature)
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1]);
	const lines = rows.slice(0, max).map(([f, n]) => {
		const limit = limits[f];
		return limit ? `${label(f)} ${n}/${limit} (${Math.round((n / limit) * 100)}%)` : `${label(f)} ${n}회`;
	});
	if (rows.length > max) lines.push(`외 ${rows.length - max}개`);
	return { title, lines };
}
