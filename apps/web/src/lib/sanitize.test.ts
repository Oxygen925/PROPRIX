import { expect, test } from 'bun:test';
import { imageLink, safeStyle } from './sanitize';

test('외부 이미지: http(s) 만 링크로 둔다', () => {
	expect(imageLink('https://example.test/a.png')).toBe('https://example.test/a.png');
	expect(imageLink('javascript:alert(1)')).toBe('');
	expect(imageLink('file:///c:/a.png')).toBe('');
	expect(imageLink('')).toBe('');
});

test('style: 글자색 등 안전한 속성만 남긴다', () => {
	expect(safeStyle('color: red; font-weight: bold')).toBe('color:red;font-weight:bold');
	expect(safeStyle('background-color:#222;text-align:center')).toBe('background-color:#222;text-align:center');
	expect(safeStyle('position:fixed;inset:0;z-index:99;color:red')).toBe('color:red');
	expect(safeStyle('display:none')).toBe('');
});

test('style: 위험한 값은 지운다', () => {
	expect(safeStyle('color:url(https://evil.test/x)')).toBe('');
	expect(safeStyle('background-color:var(--x)')).toBe('');
	expect(safeStyle('color:red !important')).toBe('');
	expect(safeStyle('color:expression(alert(1))')).toBe('');
	expect(safeStyle('color:\\72 ed')).toBe('');
});

test('style: 너무 큰 길이는 지운다 (말풍선 밖을 가리지 못하게)', () => {
	expect(safeStyle('font-size:999px')).toBe('');
	expect(safeStyle('margin-top:-9999px')).toBe('');
	expect(safeStyle('height:100vh')).toBe('');
	expect(safeStyle('font-size:1.5em;margin-right:-0.2em')).toBe('font-size:1.5em;margin-right:-0.2em');
});
