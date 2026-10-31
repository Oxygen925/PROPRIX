// 리서치 화면·패널 공용 표시
import type { ResearchRun } from '@proprix/shared';

export const STATUS: Record<ResearchRun['status'], { label: string; tone: 'neutral' | 'working' | 'done' | 'danger' | 'waiting' }> = {
	running: { label: '실행 중', tone: 'working' },
	done: { label: '완료', tone: 'done' },
	partial: { label: '일부만', tone: 'waiting' },
	failed: { label: '실패', tone: 'danger' },
	cancelled: { label: '중지', tone: 'neutral' },
	skipped: { label: '새 것 없음', tone: 'neutral' }
};
export const STAGE: Record<string, string> = {
	queries: '검색어 만드는 중',
	search: '검색 중',
	read: '페이지 읽는 중',
	write: '글 쓰는 중',
	save: '저장 중'
};
// 실패·건너뜀 까닭
export const REASON: Record<string, string> = {
	missed: '놓친 회차 (PC 꺼짐·잠자기 등)',
	running: '앞 실행이 아직 도는 중',
	budget: '리서치 예산 부족',
	paused: '사용량 한도로 멈춤',
	no_model: '모델이 정해지지 않음',
	no_browser: '브라우저가 설치되지 않음',
	no_agent: '글쓴이 에이전트가 없음',
	daemon_restarted: '앱 종료로 중단',
	cancelled: '중지함',
	internal: '내부 오류'
};
export const reasonText = (e: string) => REASON[e] ?? e;
// 예약 회차를 건너뛴 기록은 '건너뜀', 새 페이지가 없어 끝난 것은 '새 것 없음'
export const runLabel = (run: { status: ResearchRun['status']; error?: string }) =>
	run.status === 'skipped' && run.error ? '건너뜀' : STATUS[run.status].label;
export const PAGE_LABEL: Record<string, string> = {
	ok: '',
	blocked: '차단됨',
	robots: 'robots.txt',
	denied: '규칙상 제외',
	error: '오류',
	timeout: '시간 초과'
};
export const when = (t: number) =>
	new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const clock = (t: number) =>
	new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
