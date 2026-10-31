/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { filenameOf } from './download';

test('Content-Disposition 파일 이름: UTF-8 이름 우선, 없으면 일반 이름, 그것도 없으면 기본값', () => {
	expect(filenameOf(`attachment; filename="persona.json"; filename*=UTF-8''%EB%B9%84%EC%84%9C.json`, 'x')).toBe('비서.json');
	expect(filenameOf('attachment; filename="persona.md"', 'x')).toBe('persona.md');
	expect(filenameOf(null, 'fallback.json')).toBe('fallback.json');
	expect(filenameOf(`attachment; filename*=UTF-8''%E0%A4%A`, 'x')).toBe('x');
});
