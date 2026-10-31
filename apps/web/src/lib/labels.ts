// 화면 곳곳에서 쓰는 이름표
import type { BudgetFeature } from '@proprix/shared';

// 기능별 일일 예산·사용량
export const FEATURE_LABEL: Record<BudgetFeature, { title: string; hint: string }> = {
	chat: { title: '채팅', hint: '직접 보낸 메시지의 응답 (도구 단계 포함)' },
	router: { title: '라우터', hint: '그룹챗에서 답할 에이전트 고르기' },
	delegate: { title: '위임·작업자', hint: '위임 받은 에이전트·임시 작업자 실행' },
	debate: { title: '토론·협업', hint: '토론 발언' },
	lounge: { title: '라운지', hint: '라운지 잡담' },
	proactive: { title: '알림·선제 메시지', hint: '리마인더·체크인·안부 (리마인더는 예산이 없으면 고정 문구로)' },
	memory: { title: '기억 추출', hint: '추출·영어 정규화' },
	summary: { title: '롤링 요약', hint: '오래된 채팅 요약, 새 채팅의 자동 제목' },
	tasks: { title: '예약 작업', hint: '반복 예약 작업 실행 (도구 단계마다 1회, 넘으면 그날 남은 작업은 건너뜀)' },
	research: { title: '리서치', hint: '자율 웹 리서치 (검색어·검색·페이지 요약·글쓰기마다 1회, 넘으면 모은 것까지로 글을 씀)' }
};

export const MEMORY_KIND_LABEL: Record<string, string> = {
	fact: '사실',
	preference: '선호',
	event: '일정·사건',
	relationship: '관계'
};

export const REPEAT_LABEL = { none: '한 번', daily: '매일', weekdays: '평일', weekly: '매주' } as const;
