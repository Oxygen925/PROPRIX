// 메시지 마크다운 → HTML (micromark + GFM + KaTeX 수식)
// - 원본 HTML 은 허용 목록만 그린다 (sanitize.ts). javascript: 같은 위험한 링크는 비운다 (micromark 기본값)
// - 수식: \( … \) · $$ … $$ 는 줄 안, \[ … \] · 줄 단독 $$ 는 블록. 한 개짜리 $ 는 금액과 헷갈려 쓰지 않는다
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { math, mathHtml } from 'micromark-extension-math';
import { canSanitize, sanitizeHtml } from './sanitize';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?[^`]\1(?!`)/g;

export function renderMarkdown(text: string): string {
	const sanitize = canSanitize();
	const html = micromark(convertMathDelimiters(text), {
		allowDangerousHtml: sanitize,
		extensions: [gfm(), math({ singleDollarTextMath: false })],
		htmlExtensions: [gfmHtml(), mathHtml({ throwOnError: false, strict: false })]
	});
	// 문단 안 줄바꿈은 CSS(pre-line)로 보이므로, 강제 줄바꿈 뒤의 줄바꿈은 지워 두 줄이 되지 않게
	const lines = html.replace(/<br \/>\n/g, '<br />');
	return sanitize ? sanitizeHtml(lines) : lines;
}

/** \( \) 와 \[ \] 를 micromark 가 아는 $$ 로 바꾼다. 코드 블록·인라인 코드 안은 그대로 */
export function convertMathDelimiters(text: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence = '';
	const flush = () => {
		if (prose.length) out.push(outsideInlineCode(prose.join('\n')));
		prose = [];
	};
	for (const line of text.split('\n')) {
		const m = FENCE.exec(line);
		if (fence) {
			out.push(line);
			const mark = m?.[1] ?? '';
			if (mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = '';
		} else if (m) {
			flush();
			fence = m[1] ?? '';
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join('\n');
}

function outsideInlineCode(s: string): string {
	let result = '';
	let last = 0;
	for (const m of s.matchAll(INLINE_CODE)) {
		result += toDollars(s.slice(last, m.index)) + m[0];
		last = m.index + m[0].length;
	}
	return result + toDollars(s.slice(last));
}

function toDollars(s: string): string {
	return s
		.replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
		.replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$$${body.trim().replace(/\s*\n\s*/g, ' ')}$$`);
}
