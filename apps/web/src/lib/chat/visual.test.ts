import { expect, test } from 'bun:test';
import { buildVisualDoc, SEND_MAX, VISUAL_CSP, visualMessage } from './visual';

test('문서: 네트워크를 막는 CSP, 테마 변수(형식이 맞는 것만), 내용은 body 에', () => {
	const doc = buildVisualDoc('svg', '<svg><rect/></svg>', {
		'--pv-text': '#eee',
		'--pv-accent': 'red;}</style><script>x</script>',
		'--evil': 'x'
	});
	expect(doc).toContain(`content="${VISUAL_CSP}"`);
	expect(VISUAL_CSP).toContain("default-src 'none'");
	expect(VISUAL_CSP).not.toContain('connect-src');
	expect(doc).toContain('--pv-text:#eee');
	expect(doc).not.toContain('--evil');
	expect(doc).not.toContain('</style><script>x');
	expect(doc).toContain('<body><svg><rect/></svg></body>');
	expect(doc).toContain('window.proprix=');
});

test('메시지: 형식이 맞는 높이·보내기만, 보내기는 길이 제한', () => {
	expect(visualMessage({ proprix: true, type: 'height', h: 120 })).toEqual({ type: 'height', h: 120 });
	expect(visualMessage({ proprix: true, type: 'send', text: 'A 로 할게' })).toEqual({ type: 'send', text: 'A 로 할게' });
	expect(visualMessage({ proprix: true, type: 'send', text: 'x'.repeat(5000) })?.type).toBe('send');
	expect((visualMessage({ proprix: true, type: 'send', text: 'x'.repeat(5000) }) as { text: string }).text).toHaveLength(SEND_MAX);
	expect(visualMessage({ proprix: true, type: 'send', text: '   ' })).toBeNull();
	expect(visualMessage({ type: 'height', h: 1 })).toBeNull();
	expect(visualMessage('hi')).toBeNull();
	expect(visualMessage({ proprix: true, type: 'height', h: Number.NaN })).toBeNull();
});
