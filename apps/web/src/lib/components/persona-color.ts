// 새 페르소나의 기본 색: 가장 덜 쓴 색 (같은 색이면 대화에서 구분되지 않는다)
const PALETTE = ['#4f6bed', '#d9603b', '#2f9e77', '#b45fc9', '#d19a1f', '#d64f7f', '#2b9fc4', '#7f8c3a'];

export function nextPersonaColor(used: readonly string[]): string {
	const count = (c: string) => used.filter((u) => u.toLowerCase() === c).length;
	return PALETTE.reduce((best, c) => (count(c) < count(best) ? c : best));
}
