/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { convertMathDelimiters, renderMarkdown } from './markdown';

describe('convertMathDelimiters', () => {
	test('\\( \\) 는 줄 안 수식, \\[ \\] 는 블록 수식', () => {
		expect(convertMathDelimiters('값은 \\(a+b\\) 입니다')).toBe('값은 $$a+b$$ 입니다');
		expect(convertMathDelimiters('식:\\[x^2\\]끝')).toBe('식:\n$$\nx^2\n$$\n끝');
	});

	test('코드 블록과 인라인 코드 안은 건드리지 않는다', () => {
		const fenced = '```tex\n\\(a\\)\n```\n\\(b\\)';
		expect(convertMathDelimiters(fenced)).toBe('```tex\n\\(a\\)\n```\n$$b$$');
		expect(convertMathDelimiters('`\\(a\\)` 와 \\(b\\)')).toBe('`\\(a\\)` 와 $$b$$');
	});

	test('여러 줄 줄 안 수식은 한 줄로', () => {
		expect(convertMathDelimiters('\\(a +\n b\\)')).toBe('$$a + b$$');
	});
});

describe('renderMarkdown', () => {
	test('GFM: 목록·표·취소선', () => {
		const html = renderMarkdown('- a\n- b\n\n| x |\n|---|\n| 1 |\n\n~~no~~');
		expect(html).toContain('<li>a</li>');
		expect(html).toContain('<td>1</td>');
		expect(html).toContain('<del>no</del>');
	});

	test('수식은 KaTeX 로, 한 개짜리 $ 는 그대로', () => {
		expect(renderMarkdown('\\(x^2\\)')).toContain('class="katex"');
		expect(renderMarkdown('\\[x\\]')).toContain('katex-display');
		const money = renderMarkdown('가격 $5 와 $10');
		expect(money).not.toContain('katex');
		expect(money).toContain('$5 와 $10');
	});

	test('잘못된 수식도 던지지 않는다', () => {
		expect(() => renderMarkdown('\\(\\frac{\\)')).not.toThrow();
	});

	test('원본 HTML 은 글자로, 위험한 링크는 비운다', () => {
		expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
		expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href=""');
	});

	test('코드 블록에 언어 클래스', () => {
		expect(renderMarkdown('```ts\nconst a = 1;\n```')).toContain('class="language-ts"');
	});
});
