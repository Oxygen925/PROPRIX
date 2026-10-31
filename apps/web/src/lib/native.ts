// 앱(Tauri) 모드: 셸이 띄운 daemon 의 주소·토큰, 네이티브 알림, 창 보이기, 시작 시 자동 실행.
// 브라우저(개발)에서는 inApp 이 false 라 모두 쓰지 않는다 — 같은 origin 쿠키와 Web Notification 그대로
export const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface Endpoint {
	url: string; // http://127.0.0.1:<port>
	token: string;
}

let endpoint: Endpoint | null = null;

export function getEndpoint(): Endpoint | null {
	return endpoint;
}

// 셸이 daemon 준비(health)를 기다린 뒤 돌려준다
export async function loadEndpoint(): Promise<Endpoint | null> {
	if (!inApp) return null;
	const { invoke } = await import('@tauri-apps/api/core');
	endpoint = await invoke<Endpoint>('endpoint');
	return endpoint;
}

// 앱을 다시 시작한다 (daemon 을 닫고 새로 띄운다). 백업 복구 적용에 쓴다
export async function restartApp(): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('restart_app');
}

// 시스템 브라우저로 연다 (http·https 만)
export async function openExternal(url: string): Promise<void> {
	if (!/^https?:\/\//.test(url)) return;
	const { openUrl } = await import('@tauri-apps/plugin-opener');
	await openUrl(url);
}

// 폴더 선택 창 (앱에서만). 고르지 않으면 null
export async function pickFolder(title: string): Promise<string | null> {
	if (!inApp) return null;
	const { open } = await import('@tauri-apps/plugin-dialog');
	const picked = await open({ directory: true, multiple: false, title });
	return typeof picked === 'string' ? picked : null;
}

// 앱 창 안의 외부 링크(<a href="https://…">) 클릭을 시스템 브라우저로 돌린다
export function routeExternalLinks(): () => void {
	const onClick = (e: MouseEvent) => {
		const a = (e.target as Element | null)?.closest?.('a[href]');
		if (!(a instanceof HTMLAnchorElement)) return;
		const url = new URL(a.href, location.href);
		if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) return;
		e.preventDefault();
		void openExternal(url.href);
	};
	document.addEventListener('click', onClick, true);
	return () => document.removeEventListener('click', onClick, true);
}

async function showWindow() {
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	const w = getCurrentWindow();
	await w.show();
	await w.unminimize();
	await w.setFocus();
}

let actionHandler: ((roomId: string) => void) | null = null;
let actionRegistered = false;
const rooms = new Map<number, string>(); // 알림 id → 방
let nextId = Math.floor(Date.now() / 1000) % 1_000_000;

// 네이티브 알림 (클릭하면 창을 보이고 그 방으로 — roomId 자리에 '/경로' 를 넣으면 그 화면으로). 권한이 없으면 false
export async function nativeNotify(
	title: string,
	body: string,
	roomId: string,
	onClick: (roomId: string) => void
): Promise<boolean> {
	const n = await import('@tauri-apps/plugin-notification');
	let granted = await n.isPermissionGranted();
	if (!granted) granted = (await n.requestPermission()) === 'granted';
	if (!granted) return false;
	actionHandler = onClick;
	if (!actionRegistered) {
		actionRegistered = true;
		await n.onAction((event) => {
			// 플랫폼마다 돌려주는 필드가 달라 extra 가 없으면 보낼 때 기억해 둔 id 로 찾는다.
			// Windows 는 알림이 화면에 떠 있을 때의 클릭만 알려 준다 (알림 센터로 넘어간 뒤는 앱을 직접 열어야 함)
			const extra = event.notification?.extra?.roomId;
			const room = typeof extra === 'string' ? extra : rooms.get(event.notification?.id ?? -1);
			void showWindow();
			if (room) actionHandler?.(room);
		});
	}
	const id = nextId++;
	rooms.set(id, roomId);
	n.sendNotification({ id, title, body, extra: { roomId } });
	return true;
}

export async function autostartEnabled(): Promise<boolean> {
	const a = await import('@tauri-apps/plugin-autostart');
	return a.isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
	const a = await import('@tauri-apps/plugin-autostart');
	if (on) await a.enable();
	else await a.disable();
}
