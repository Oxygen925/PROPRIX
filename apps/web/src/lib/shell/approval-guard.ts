// 설치한 테마가 있을 때 쓰는 승인 창. 테마 CSS 는 문서 전체에 닿아 승인 카드를 가리거나 바꿔치기할 수 있다.
// - <html> 바로 아래의 popover 를 top layer 로 띄워 어떤 요소도 위를 덮지 못하게 하고, 뒤 화면은 inert 로 막는다
//   (<dialog> 는 shadow DOM 을 붙일 수 없어 쓰지 않는다)
// - 내용은 shadow DOM: 바깥 CSS 가 들어오지 못한다
// - 창 자체(:host)는 shadow 쪽 !important 가 바깥 !important 를 이긴다 (CSS cascade 의 encapsulation context)
// - <html> 은 숨기는 속성만 인라인 !important 로 풀고, 닫을 때 되돌린다
export interface GuardCall {
	title: string;
	who: string;
	name: string;
	detail: string;
	note: string;
	alwaysLabel: string; // 비어 있으면 '항상 허용'을 보이지 않는다
	allowLabel: string;
	waiting: number;
}

export type GuardDecision = { approve: boolean; always: boolean };

const HOST_CSS = `
:host, :host::before, :host::after, :host::backdrop {
	animation: none !important; transition: none !important; filter: none !important; backdrop-filter: none !important;
	transform: none !important; clip-path: none !important; mask: none !important; opacity: 1 !important;
	visibility: visible !important; zoom: 1 !important; mix-blend-mode: normal !important;
}
:host::before, :host::after { content: none !important; display: none !important; }
:host {
	all: initial !important; display: block !important; position: fixed !important; inset: 0 !important;
	margin: auto !important; width: min(40rem, calc(100vw - 2rem)) !important; height: fit-content !important;
	max-height: calc(100vh - 2rem) !important; overflow: auto !important; box-sizing: border-box !important;
	padding: 1rem !important; border: 2px solid #f5a524 !important; border-radius: 8px !important;
	background: #16171b !important; color: #f2f3f5 !important; pointer-events: auto !important;
	font: 14px/1.5 system-ui, sans-serif !important; content-visibility: visible !important; contain: none !important;
}
:host::backdrop { background: rgb(0 0 0 / 0.75) !important; display: block !important; }
.head { font-weight: 600; font-size: 15px; }
.who { color: #a6a8ad; font-size: 13px; margin: 0.125rem 0 0.75rem; }
code { font: 12px ui-monospace, monospace; color: #a6a8ad; }
pre {
	margin: 0; padding: 0.5rem; max-height: 45vh; overflow: auto; border-radius: 4px; background: #0c0d0f;
	font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
.note { margin: 0.5rem 0 0; color: #f5a524; font-size: 13px; }
.safe { margin: 0.5rem 0 0; color: #a6a8ad; font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem; }
button {
	padding: 0.375rem 0.75rem; border: 1px solid #55585f; border-radius: 4px; background: transparent; color: #f2f3f5;
	font: inherit; cursor: pointer;
}
button:hover:not(:disabled) { background: #2a2c31; }
button:focus-visible { outline: 2px solid #f5a524; outline-offset: 1px; }
button:disabled { opacity: 0.5; cursor: default; }
button.allow { background: #f2f3f5; border-color: #f2f3f5; color: #16171b; }
button.allow:hover:not(:disabled) { background: #d5d7da; }
.error { margin: 0.5rem 0 0; color: #ff7b72; font-size: 13px; }
`;

const ROOT_FIXES: Record<string, string> = {
	display: 'block',
	visibility: 'visible',
	opacity: '1',
	filter: 'none',
	transform: 'none',
	'clip-path': 'none',
	mask: 'none',
	zoom: '1',
	'content-visibility': 'visible',
	'pointer-events': 'auto'
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
	const e = document.createElement(tag);
	if (className) e.className = className;
	e.textContent = text;
	return e;
}

/** 승인 창을 띄운다. 돌려받은 함수로 닫는다. decide 가 실패하면 창에 오류를 보이고 다시 누를 수 있게 한다 */
export function openApprovalGuard(call: GuardCall, decide: (d: GuardDecision) => Promise<void>): () => void {
	const root = document.documentElement;
	const saved = Object.keys(ROOT_FIXES).map((p) => [p, root.style.getPropertyValue(p), root.style.getPropertyPriority(p)]);
	for (const [p, v] of Object.entries(ROOT_FIXES)) root.style.setProperty(p, v, 'important');

	const host = document.createElement('div');
	host.popover = 'manual';
	host.setAttribute('role', 'alertdialog');
	host.setAttribute('aria-modal', 'true');
	host.setAttribute('aria-label', `확인 필요: ${call.title}`);
	const shadow = host.attachShadow({ mode: 'closed' });
	const style = el('style', '', HOST_CSS);
	const head = el('div', 'head', `확인 필요: ${call.title}`);
	const who = el('div', 'who', `${call.who}의 요청 · `);
	who.append(el('code', '', call.name));
	const detail = el('pre', '', call.detail);
	shadow.append(style, head, who, detail);
	if (call.note) shadow.append(el('p', 'note', call.note));
	const safe = el('p', 'safe', '설치한 테마의 영향을 받지 않는 앱 확인 창입니다.');
	if (call.waiting > 1) safe.textContent += ` 대기 중인 확인 ${call.waiting}건.`;
	shadow.append(safe);

	const error = el('p', 'error');
	error.hidden = true;
	const actions = el('div', 'actions');
	const buttons: HTMLButtonElement[] = [];
	const add = (label: string, cls: string, d: GuardDecision) => {
		const b = el('button', cls, label);
		b.type = 'button';
		b.addEventListener('click', async () => {
			for (const x of buttons) x.disabled = true;
			error.hidden = true;
			try {
				await decide(d);
			} catch (e) {
				error.textContent = e instanceof Error ? e.message : '처리하지 못했습니다';
				error.hidden = false;
				for (const x of buttons) x.disabled = false;
			}
		});
		buttons.push(b);
		actions.append(b);
		return b;
	};
	const deny = add('거부', '', { approve: false, always: false });
	if (call.alwaysLabel) add(call.alwaysLabel, '', { approve: true, always: true });
	add(call.allowLabel, 'allow', { approve: true, always: false });
	shadow.append(error, actions);

	const wasInert = document.body.inert;
	document.body.inert = true;
	root.append(host);
	host.showPopover();
	deny.focus();

	return () => {
		host.remove();
		document.body.inert = wasInert;
		for (const [p, v, prio] of saved) {
			if (v) root.style.setProperty(p as string, v as string, prio as string);
			else root.style.removeProperty(p as string);
		}
	};
}
