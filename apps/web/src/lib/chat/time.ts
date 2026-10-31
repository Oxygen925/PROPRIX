// 대화 타임라인의 날짜·시각 표시 (로컬 시간대)

const dayKeyOf = (t: number) => new Date(t).toDateString();

/** 두 시각이 다른 날인가 (날짜 구분 줄을 넣을 자리) */
export function newDay(prev: number | undefined, t: number): boolean {
	return prev === undefined || dayKeyOf(prev) !== dayKeyOf(t);
}

/** 날짜 구분 줄: 오늘 · 어제 · 10월 27일 화요일 (올해가 아니면 연도까지) */
export function dayLabel(t: number, now = Date.now()): string {
	const d = new Date(t);
	const today = new Date(now);
	if (dayKeyOf(t) === dayKeyOf(now)) return '오늘';
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	if (dayKeyOf(t) === yesterday.toDateString()) return '어제';
	return d.toLocaleDateString('ko-KR', {
		year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
		month: 'long',
		day: 'numeric',
		weekday: 'long'
	});
}

/** 메시지 옆 짧은 시각: 오후 2:31 */
export const timeLabel = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });

/** 가리키면 보이는 정확한 시각 */
export const fullTime = (t: number) =>
	new Date(t).toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'medium' });
