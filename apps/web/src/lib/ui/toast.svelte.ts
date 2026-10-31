// 토스트: 짧은 알림을 쌓아 두었다가 저절로 닫는다. 오류는 더 오래 보인다
export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
	id: number;
	text: string;
	kind: ToastKind;
}

class Toasts {
	items = $state<Toast[]>([]);
	private next = 1;

	show(text: string, kind: ToastKind = 'info', ms = kind === 'error' ? 8000 : 4000) {
		if (!text) return;
		const id = this.next++;
		this.items = [...this.items.slice(-3), { id, text, kind }];
		setTimeout(() => this.dismiss(id), ms);
	}

	dismiss(id: number) {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new Toasts();
export const toast = (text: string, kind?: ToastKind) => toasts.show(text, kind);

/** catch 로 받은 값을 화면에 보일 문구로 */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const toastError = (e: unknown) => toast(errorText(e), 'error');

/** 실행하고 결과를 토스트로 알린다 (성공 문구 또는 오류) */
export async function toastRun(action: () => Promise<unknown>, success: string) {
	try {
		await action();
		toast(success, 'success');
	} catch (e) {
		toastError(e);
	}
}
