// 대화 중 시각화 (show_visual): sandbox iframe 에 넣을 문서를 만든다.
// iframe 은 sandbox="allow-scripts" 만 (opaque origin — 앱 데이터·쿠키에 닿지 못함), 문서 CSP 로 모든 네트워크를 막는다.
// 앱 창에서는 앱 CSP 를 물려받지 않게 문서를 daemon 주소에서 연다 (api/visual-frames.ts).
// 앱과는 postMessage 두 가지만: 높이 맞추기, proprix.send(텍스트) → 사용자가 확인한 뒤 대화로 보냄
import { VISUAL_CSP } from '@proprix/shared';

export { VISUAL_CSP };

export const SEND_MAX = 2000;

// iframe 안에서 먼저 도는 스크립트: proprix.send 와 내용 높이 알리기.
// 화면 밖·숨은 창에서 처음 열리면 폭이 0 이라 높이가 0 으로 재진다 → 폭이 생길 때(resize)와 몇 번 더 다시 잰다
const PRELUDE = `(function(){
var post=function(m){parent.postMessage(Object.assign({proprix:true},m),'*')};
window.proprix={send:function(t){post({type:'send',text:String(t).slice(0,${SEND_MAX})})}};
var size=function(){post({type:'height',h:Math.ceil(document.body.getBoundingClientRect().height)})};
document.addEventListener('DOMContentLoaded',function(){size();new ResizeObserver(size).observe(document.body)});
addEventListener('load',size);
addEventListener('resize',size);
[100,400,1200,3000].forEach(function(ms){setTimeout(size,ms)});
})();`;

// 앱 테마 → 시각화 CSS 변수 (에이전트가 쓰도록 도구 설명에 같은 이름을 적어 두었다)
export function readTheme(): Record<string, string> {
	const root = getComputedStyle(document.documentElement);
	const v = (name: string) => root.getPropertyValue(name).trim();
	return {
		'--pv-bg': v('--c-surface-1'),
		'--pv-surface': v('--c-surface-2'),
		'--pv-text': v('--c-text'),
		'--pv-text-2': v('--c-text-2'),
		'--pv-muted': v('--c-text-3'),
		'--pv-line': v('--c-line-strong'),
		'--pv-accent': v('--c-info'),
		'--pv-c1': v('--c-info'),
		'--pv-c2': v('--c-done'),
		'--pv-c3': v('--c-waiting'),
		'--pv-c4': v('--c-working'),
		'--pv-c5': v('--c-danger'),
		'--pv-c6': v('--c-text-2'),
		'--pv-font': getComputedStyle(document.body).fontFamily
	};
}

// CSS 변수 값에 블록을 닫는 글자가 들어가지 않게
const cssValue = (s: string) => s.replace(/[{};<>]/g, '');

export function buildVisualDoc(format: 'svg' | 'html', content: string, theme: Record<string, string>): string {
	const vars = Object.entries(theme)
		.filter(([k]) => /^--pv-[a-z0-9-]+$/.test(k))
		.map(([k, val]) => `${k}:${cssValue(val)}`)
		.join(';');
	const base =
		`:root{${vars};color-scheme:dark}html,body{margin:0;padding:0;background:transparent}` +
		`body{padding:8px 12px;color:var(--pv-text);font:14px/1.5 var(--pv-font,system-ui,sans-serif);overflow-wrap:anywhere}` +
		`${format === 'svg' ? 'body>svg{display:block;max-width:100%;height:auto}' : 'svg{max-width:100%}'}`;
	return (
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">` +
		`<style>${base}</style><script>${PRELUDE}</script></head><body>${content}</body></html>`
	);
}

export type VisualMessage = { type: 'height'; h: number } | { type: 'send'; text: string };

// iframe 이 보낸 메시지 (형식이 맞을 때만)
export function visualMessage(data: unknown): VisualMessage | null {
	if (!data || typeof data !== 'object' || (data as { proprix?: unknown }).proprix !== true) return null;
	const d = data as { type?: unknown; h?: unknown; text?: unknown };
	if (d.type === 'height' && typeof d.h === 'number' && Number.isFinite(d.h)) return { type: 'height', h: d.h };
	if (d.type === 'send' && typeof d.text === 'string' && d.text.trim()) return { type: 'send', text: d.text.slice(0, SEND_MAX) };
	return null;
}
