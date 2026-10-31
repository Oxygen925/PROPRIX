import { expect, test } from 'bun:test';
import type { Debate, Message } from '@proprix/shared';
import { artifactBody, artifactFileName } from './artifact';

test('파일 이름: 쓸 수 없는 글자·공백은 -, 끝의 점은 뗀다, 비면 결과', () => {
	expect(artifactFileName('주말 여행: 계획/초안?')).toBe('주말-여행-계획-초안.md');
	expect(artifactFileName('끝에 점...')).toBe('끝에-점.md');
	expect(artifactFileName('  <>  ')).toBe('결과.md');
	expect(artifactFileName('가'.repeat(80))).toBe(`${'가'.repeat(60)}.md`);
});

test('본문: 주제·참가자·진행자·날짜 한 줄 뒤에 맺는 말', () => {
	const d = { mode: 'collab', topic: '여행\n계획', agentIds: ['a', 'b'], moderatorId: 'c' } as Debate;
	const m = { content: '최종본\n', createdAt: new Date(2026, 9, 29).getTime() } as Message;
	const body = artifactBody(d, m, (id) => id.toUpperCase());
	expect(body).toBe('> 협업 · 여행 계획 · 참여자: A, B · 진행: C · 2026-10-29\n\n최종본\n');
});
