import { expect, test } from 'bun:test';
import { gazeSource, gazeVector, nearest } from './gaze';

test('시선 방향: 가까우면 약하게, 멀면 끝까지, 목표가 없으면 정면', () => {
	expect(gazeVector({ x: 0, y: 0 }, null)).toEqual({ x: 0, y: 0 });
	expect(gazeVector({ x: 10, y: 10 }, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
	expect(gazeVector({ x: 0, y: 0 }, { x: 160, y: 0 })).toEqual({ x: 0.5, y: 0 });
	expect(gazeVector({ x: 0, y: 0 }, { x: 0, y: -1000 })).toEqual({ x: 0, y: -1 });
	// 최소 세기: 바로 옆 대상도 확실히 돌아본다
	expect(gazeVector({ x: 0, y: 0 }, { x: 20, y: 0 }, 0.8)).toEqual({ x: 0.8, y: 0 });
});

test('화자 아바타가 여럿이면 가장 가까운 것을 본다', () => {
	expect(nearest({ x: 1000, y: 100 }, [{ x: 40, y: 100 }, { x: 1000, y: 160 }, { x: 500, y: 40 }])).toEqual({ x: 1000, y: 160 });
	expect(nearest({ x: 0, y: 0 }, [])).toBeNull();
});

test('시선 우선순위: 말하는 다른 에이전트 > 입력 중 > 커서 > 둘러보기', () => {
	expect(gazeSource({ otherSpeaking: true, typing: true, pointerActive: true })).toBe('speaker');
	expect(gazeSource({ otherSpeaking: false, typing: true, pointerActive: true })).toBe('input');
	expect(gazeSource({ otherSpeaking: false, typing: false, pointerActive: true })).toBe('pointer');
	expect(gazeSource({ otherSpeaking: false, typing: false, pointerActive: false })).toBe('wander');
});
