import { ApiError } from '@proprix/shared';
import type { z } from 'zod';
import { getEndpoint } from './native.js';

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: { code: string; recovery: string }
	) {
		super(message);
	}
}

// daemon API 호출. 브라우저는 같은 origin 의 세션 쿠키로(dev 는 vite 프록시), 앱(Tauri)은 셸이 준 주소·토큰으로
async function request<T extends z.ZodType>(
	schema: T,
	path: string,
	method: string,
	headers: Record<string, string>,
	body?: BodyInit
): Promise<z.infer<T>> {
	const ep = getEndpoint();
	if (ep) headers.authorization = `Bearer ${ep.token}`;
	const res = await fetch(`${ep?.url ?? ''}/api${path}`, { method, headers, body });
	const json: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const err = ApiError.safeParse(json);
		if (err.success) {
			const e = err.data.error;
			throw new ApiFailure(res.status, e.code, e.message, e.detail);
		}
		throw new ApiFailure(res.status, 'internal', `HTTP ${res.status}`);
	}
	return schema.parse(json);
}

// 파일을 본문 그대로 보낸다 (JSON 이 아닌 업로드)
export function apiFile<T extends z.ZodType>(schema: T, path: string, file: Blob): Promise<z.infer<T>> {
	return request(schema, path, 'POST', {}, file);
}

export function api<T extends z.ZodType>(
	schema: T,
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<z.infer<T>> {
	const json = init.body !== undefined;
	return request(
		schema,
		path,
		init.method ?? 'GET',
		json ? { 'content-type': 'application/json' } : {},
		json ? JSON.stringify(init.body) : undefined
	);
}
