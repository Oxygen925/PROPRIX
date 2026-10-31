import { expect, test } from 'bun:test';
import { avatarBackground, mascotColors } from './colors';

test('아바타 배경: 기본 페르소나 색만 테마 변수를 거친다', () => {
	expect(avatarBackground('#4F6BED')).toBe('var(--mascot-default-bg, #4F6BED)');
	expect(avatarBackground('#d9603b')).toBe('#d9603b');
});

test('마스코트 색: 어두운 색은 더 밝게, 아주 밝은 색은 어둡게 눌러 배경에 묻히지 않게', () => {
	expect(mascotColors('#111')).toEqual({ core: 'color-mix(in srgb, #111 35%, white)', orbit: 'color-mix(in srgb, #111 15%, white)' });
	expect(mascotColors('#1b2a4a').core).toBe('color-mix(in srgb, #1b2a4a 35%, white)');
	expect(mascotColors('#ffffff')).toEqual({ core: 'color-mix(in srgb, #ffffff 80%, black)', orbit: 'color-mix(in srgb, #ffffff 55%, black)' });
	expect(mascotColors('#FFE600').core).toBe('color-mix(in srgb, #FFE600 80%, black)');
	expect(mascotColors('rebeccapurple').core).toBe('color-mix(in srgb, rebeccapurple 65%, white)');
});

test('마스코트 색: 기본 페르소나 색은 원본, 나머지는 페르소나 색을 밝게 (배경 원과 구분되게)', () => {
	const original = { core: 'var(--mascot-default-core, #62a4f6)', orbit: 'var(--mascot-default-orbit, #c1dbfa)' };
	expect(mascotColors('#4F6BED')).toEqual(original);
	expect(mascotColors('')).toEqual(original);
	expect(mascotColors('#d9603b')).toEqual({ core: 'color-mix(in srgb, #d9603b 65%, white)', orbit: 'color-mix(in srgb, #d9603b 30%, white)' });
});
