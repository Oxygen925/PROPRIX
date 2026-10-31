import { expect, test } from 'bun:test';
import type { Message } from '@proprix/shared';
import { closingSpeech, debateSpeeches, liveSpeech, nextSpeaker, roundLabel, roundSteps, speechesSince, focusSpeech, speechPreview, timelineRows } from './stage';

const msg = (over: Partial<Message>): Message =>
	({ id: 'm', role: 'assistant', agentId: 'a', content: '', status: 'done', debateId: 'd', debateRound: 1, createdAt: 10, ...over }) as Message;

test('발언 목록: 이 토론의 assistant 만, 라운지는 시각으로', () => {
	const ms = [msg({ id: '1' }), msg({ id: '2', role: 'user' }), msg({ id: '3', debateId: 'x' }), msg({ id: '4', createdAt: 5 })];
	expect(debateSpeeches(ms, 'd').map((m) => m.id)).toEqual(['1', '4']);
	expect(speechesSince(ms, 10).map((m) => m.id)).toEqual(['1', '3']);
	expect(liveSpeech([msg({ id: '1' }), msg({ id: '2', status: 'streaming' })])?.id).toBe('2');
	expect(liveSpeech([msg({})])).toBeNull();
});

test('다음 발언자: 차례대로, 진행자의 여는 말 뒤는 첫 참가자, 마지막 라운드 끝은 진행자, 맺는 말이나 끝나면 없음', () => {
	const d = { agentIds: ['a', 'b'], moderatorId: 'm', round: 1, rounds: 2, status: 'running' as const };
	expect(nextSpeaker(d, 'm')).toBe('a');
	expect(nextSpeaker(d, 'a')).toBe('b');
	expect(nextSpeaker(d, 'b')).toBe('a');
	expect(nextSpeaker({ ...d, round: 2 }, 'b')).toBe('m');
	expect(nextSpeaker({ ...d, round: 3 }, 'a')).toBe('');
	expect(nextSpeaker({ ...d, status: 'done' }, 'a')).toBe('');
	expect(nextSpeaker(d, '')).toBe('');
});

test('라운드 표시와 단계', () => {
	const d = { round: 1, rounds: 2, status: 'running' as const, mode: 'debate' as const };
	expect(roundLabel(d)).toBe('라운드 1 / 2');
	expect(roundLabel({ ...d, round: 0 })).toBe('여는 말');
	expect(roundLabel({ ...d, round: 3 })).toBe('맺는 말');
	expect(roundLabel({ ...d, status: 'done' })).toBe('끝남');
	expect(roundLabel({ ...d, status: 'done', mode: 'collab' })).toBe('완성');
	expect(roundSteps(d).map((s) => s.state)).toEqual(['done', 'now', 'todo', 'todo']);
	expect(roundSteps({ ...d, status: 'done' }).every((s) => s.state === 'done')).toBe(true);
	expect(roundSteps(d).map((s) => s.label)).toEqual(['여는 말', '라운드 1', '라운드 2', '맺는 말']);
});

test('맺는 말: 마지막 라운드 뒤의 진행자 발언', () => {
	const d = { rounds: 2, moderatorId: 'm' };
	expect(closingSpeech([msg({ agentId: 'm', debateRound: 1 })], d)).toBeNull();
	expect(closingSpeech([msg({ id: 'x', agentId: 'm', debateRound: 3 })], d)?.id).toBe('x');
	expect(closingSpeech([msg({ agentId: 'a', debateRound: 3 })], d)).toBeNull();
});

test('초점: 다음 사람이 글을 쓰기 시작해야 넘어가고, 맺는 말은 초점이 되지 않는다', () => {
	const done = msg({ id: '1', content: '앞 발언' });
	const waiting = msg({ id: '2', content: '', status: 'streaming' });
	expect(focusSpeech([done, waiting], '')?.id).toBe('1');
	expect(focusSpeech([done, { ...waiting, content: ' \n' }], '')?.id).toBe('1');
	expect(focusSpeech([done, { ...waiting, content: '첫 글자' }], '')?.id).toBe('2');
	expect(focusSpeech([done, msg({ id: 'end', content: '결론' })], 'end')?.id).toBe('1');
	// 아직 글이 없으면 첫 발언자, 맺는 말뿐이면 그것
	expect(focusSpeech([waiting], '')?.id).toBe('2');
	expect(focusSpeech([msg({ id: 'end', content: '결론' })], 'end')?.id).toBe('end');
	expect(focusSpeech([], '')).toBeNull();
});

test('타임라인: 좌석마다 한 줄, 분량 비율로 이어 붙이고 짧은 발언도 최소 길이, 발언 없는 좌석도 줄이 있다', () => {
	const rows = timelineRows(
		[msg({ id: '1', agentId: 'a', content: 'x'.repeat(600) }), msg({ id: '2', agentId: 'b', content: 'x', status: 'streaming' })],
		['a', 'b', 'c']
	);
	expect(rows.map((r) => r.agentId)).toEqual(['a', 'b', 'c']);
	expect(rows[0]?.bars[0]).toMatchObject({ id: '1', left: 0, width: 75, live: false });
	expect(rows[1]?.bars[0]).toEqual({ id: '2', left: 75, width: 25, live: true, preview: 'x' });
	expect(rows[2]?.bars).toEqual([]);
	expect(timelineRows([], ['a'])).toEqual([{ agentId: 'a', bars: [] }]);
	// 좌석에 없는 화자도 잃지 않는다
	expect(timelineRows([msg({ id: '1', agentId: 'z' })], ['a']).map((r) => r.agentId)).toEqual(['a', 'z']);
});

test('막대 미리보기: 마크다운 기호·코드 묶음을 빼고 한 줄로, 길면 자른다', () => {
	expect(speechPreview('## 제목\n\n**굵게** 말한다\n```ts\nconst a = 1;\n```\n끝')).toBe('제목 굵게 말한다 끝');
	expect(speechPreview('가'.repeat(81))).toBe(`${'가'.repeat(80)}…`);
	expect(speechPreview('```\n코드만')).toBe('');
	expect(speechPreview('<span style="color:red">빨강</span> 글')).toBe('빨강 글');
});
