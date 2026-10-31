// 메시지 HTML 정리 (사용자 결정 2026-10-31: 서식 태그 + 글자색). 모델 출력은 웹 검색 내용의 영향을 받으므로
// 허용 목록만 남긴다: script·iframe·form·이벤트 속성은 지우고, 외부 이미지는 링크로 바꾸고, style 은 안전한 속성과 값만 둔다.
// KaTeX 결과(span·math·svg 와 class·style)도 이 단계를 지나므로 함께 허용한다
import DOMPurify from 'dompurify';

const SAFE_STYLE = new Set([
	'color',
	'background-color',
	'font-size',
	'font-weight',
	'font-style',
	'text-decoration',
	'text-align',
	'letter-spacing',
	'line-height',
	'opacity',
	// KaTeX 가 쓰는 치수
	'height',
	'width',
	'min-width',
	'max-width',
	'vertical-align',
	'top',
	'margin',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'padding',
	'padding-left',
	'border-bottom-width',
	'border-right-width',
	'border-top-width',
	'border-left-width'
]);

const BAD_VALUE = /url\s*\(|expression|javascript:|var\s*\(|@|\\|<|>|!important/i;
const MAX_PX = 400;
const MAX_EM = 30;

// 값 안의 길이가 너무 크면 말풍선 밖을 가릴 수 있어 뺀다
function lengthsOk(value: string): boolean {
	for (const m of value.matchAll(/(-?\d*\.?\d+)\s*(px|r?em|ex|vw|vh|vmin|vmax|pt|cm|mm|in|pc|%)/gi)) {
		const n = Math.abs(Number(m[1]));
		const unit = (m[2] ?? '').toLowerCase();
		if (unit === 'px' ? n > MAX_PX : unit === 'em' || unit === 'rem' || unit === 'ex' ? n > MAX_EM : unit === '%' ? n > 100 : true) return false;
	}
	return true;
}

/** style 속성에서 안전한 선언만 남긴다 */
export function safeStyle(css: string): string {
	const kept: string[] = [];
	for (const decl of css.split(';')) {
		const i = decl.indexOf(':');
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const value = decl.slice(i + 1).trim();
		if (!value || !SAFE_STYLE.has(prop) || BAD_VALUE.test(value) || !lengthsOk(value)) continue;
		kept.push(`${prop}:${value}`);
	}
	return kept.join(';');
}

const TAGS = [
	// 마크다운 결과
	'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'a', 'hr', 'br', 'img', 'input',
	'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'section',
	// 서식 태그
	'b', 'i', 'u', 's', 'mark', 'kbd', 'sub', 'sup', 'small', 'details', 'summary', 'ruby', 'rt', 'rp', 'span', 'div', 'abbr', 'cite', 'q', 'dl', 'dt', 'dd', 'center',
	// KaTeX
	'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'menclose', 'svg', 'path', 'line'
];
const ATTRS = [
	'href', 'title', 'alt', 'src', 'class', 'style', 'id', 'align', 'colspan', 'rowspan', 'scope', 'open', 'checked', 'disabled', 'type', 'dir', 'lang',
	'aria-hidden', 'xmlns', 'mathvariant', 'encoding', 'display', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'lspace', 'rspace', 'scriptlevel', 'columnalign', 'rowspacing', 'columnspacing',
	'd', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x1', 'x2', 'y1', 'y2', 'stroke-width'
];

const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);/i;
/** 불러오지 않을 이미지의 링크 주소. 열 수 없는 주소면 "" */
export const imageLink = (src: string): string => (/^https?:\/\//i.test(src) ? src : '');

let hooked = false;
function installHooks() {
	if (hooked) return;
	hooked = true;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		const el = node as Element;
		if (!el.getAttribute) return;
		const style = el.getAttribute('style');
		if (style !== null) {
			const clean = safeStyle(style);
			if (clean) el.setAttribute('style', clean);
			else el.removeAttribute('style');
		}
		// 외부 이미지는 저절로 부르지 않는다 (주소로 내용이 새어 나갈 수 있다). 눌러서 열 수 있게 링크로 둔다
		if (el.tagName === 'IMG' && !INLINE_IMAGE.test(el.getAttribute('src') ?? '')) {
			const href = imageLink(el.getAttribute('src') ?? '');
			if (href) {
				const a = el.ownerDocument.createElement('a');
				a.setAttribute('href', href);
				a.setAttribute('title', href);
				a.textContent = `이미지: ${el.getAttribute('alt') || '링크 열기'}`;
				el.replaceWith(a);
			} else el.remove();
		}
		// 입력칸은 마크다운 할 일 목록의 체크 표시만
		if (el.tagName === 'INPUT') {
			if (el.getAttribute('type') !== 'checkbox') el.remove();
			else el.setAttribute('disabled', '');
		}
	});
}

/** 브라우저가 아니면(테스트) false: 그때는 원본 HTML 을 글자로 둔다 */
export const canSanitize = (): boolean => typeof window !== 'undefined' && DOMPurify.isSupported;

export function sanitizeHtml(html: string): string {
	installHooks();
	return DOMPurify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, ADD_ATTR: ['aria-hidden'] });
}
