// 테마 적용: 받은 CSS 를 <style> 로 넣고 <html data-theme> 를 바꾼다.
// 첫 화면부터 맞게 CSS 를 기기에 기억하고 app.html 이 먼저 적용한다 (글꼴 CSS 는 커서 기억하지 않고 받은 뒤 넣는다)
import type { ThemeBundle } from '@proprix/shared';

const KEY = 'proprix.theme';
const CSS_KEY = 'proprix.themeCss';
const CSS_ID = 'proprix-theme-css';
const FONT_ID = 'proprix-theme-fonts';
export const DEFAULT_THEME = 'studio';

function setStyle(id: string, css: string) {
	let el = document.getElementById(id);
	if (!css) {
		el?.remove();
		return;
	}
	if (!el) {
		el = document.createElement('style');
		el.id = id;
		document.head.append(el);
	}
	el.textContent = css;
}

export function savedTheme(): string {
	try {
		return localStorage.getItem(KEY) || DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

export function applyTheme(bundle: ThemeBundle | null) {
	document.documentElement.dataset.theme = bundle?.id ?? DEFAULT_THEME;
	setStyle(CSS_ID, bundle?.css ?? '');
	setStyle(FONT_ID, bundle?.fontCss ?? '');
	try {
		localStorage.setItem(KEY, bundle?.id ?? DEFAULT_THEME);
		if (bundle) localStorage.setItem(CSS_KEY, bundle.css);
		else localStorage.removeItem(CSS_KEY);
	} catch {
		// 기억하지 못해도 이번 실행에는 적용된다 (용량이 크면 다음 실행 첫 화면에 잠깐 기본 색이 보인다)
		try {
			localStorage.removeItem(CSS_KEY);
		} catch {}
	}
}
