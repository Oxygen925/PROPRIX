import { expect, test } from 'bun:test';
import { nextPersonaColor } from './persona-color';

test('새 페르소나 색: 처음은 첫 색, 쓴 색은 건너뛰고 (대소문자 무관), 다 쓰면 가장 덜 쓴 색', () => {
	expect(nextPersonaColor([])).toBe('#4f6bed');
	expect(nextPersonaColor(['#4F6BED', '#123456'])).toBe('#d9603b');
	const all = ['#4f6bed', '#d9603b', '#2f9e77', '#b45fc9', '#d19a1f', '#d64f7f', '#2b9fc4', '#7f8c3a'];
	expect(nextPersonaColor([...all, '#4f6bed'])).toBe('#d9603b');
});
