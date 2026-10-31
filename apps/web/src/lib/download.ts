// daemon 이 만든 파일 내려받기. <a href download> 는 앱(Tauri)에서 토큰을 붙일 수 없어 fetch + Blob 으로 한다
import { ApiFailure } from './api.js';
import { getEndpoint } from './native.js';

/** Content-Disposition 의 파일 이름 (filename*=UTF-8'' 우선) */
export function filenameOf(header: string | null, fallback: string): string {
	if (!header) return fallback;
	const star = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
	if (star) {
		try {
			return decodeURIComponent(star);
		} catch {
			// 잘못된 인코딩이면 아래로
		}
	}
	return /filename="?([^";]+)"?/i.exec(header)?.[1] ?? fallback;
}

export async function download(path: string, fallback: string) {
	const ep = getEndpoint();
	const res = await fetch(`${ep?.url ?? ''}/api${path}`, {
		headers: ep ? { authorization: `Bearer ${ep.token}` } : {}
	});
	if (!res.ok) throw new ApiFailure(res.status, 'download', `내려받지 못했습니다 (HTTP ${res.status})`);
	const url = URL.createObjectURL(await res.blob());
	const a = document.createElement('a');
	a.href = url;
	a.download = filenameOf(res.headers.get('content-disposition'), fallback);
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 화면에서 만든 내용 내려받기 (시각화 .svg·.html 등) */
export function saveBlob(content: string, type: string, name: string) {
	const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
