// 입력창 첨부 준비: 이미지는 줄여서 data URL, 텍스트 파일은 내용, PDF 는 뽑은 글자 (사용자 결정 2026-10-29)
import { ATTACHMENT_IMAGE_MAX, ATTACHMENT_TEXT_MAX, type AttachmentInput } from '@proprix/shared';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const IMAGE_EDGE = 1568; // 긴 변 (모델이 더 크게는 쓰지 않는다)
const TEXT_EXT =
	/\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|svelte|vue|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|php|sql|sh|ps1|bat)$/i;
const TRUNCATED = '\n\n…(너무 길어 이후는 잘림)';

export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.pdf,text/*,.md,.csv,.json,.yaml,.yml,.log,.ts,.js,.py,.svelte,.cs,.sql';

const clip = (s: string) =>
	s.length > ATTACHMENT_TEXT_MAX ? s.slice(0, ATTACHMENT_TEXT_MAX - TRUNCATED.length) + TRUNCATED : s;

export async function prepareAttachment(file: File): Promise<AttachmentInput> {
	if ((IMAGE_TYPES as readonly string[]).includes(file.type)) return image(file);
	if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
		const text = await pdfText(file);
		if (!text.trim()) throw new Error(`${file.name}: 글자를 찾지 못했습니다 (스캔한 PDF 일 수 있음)`);
		return { kind: 'text', name: file.name, mime: 'application/pdf', size: file.size, data: clip(text) };
	}
	if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
		const text = await file.text();
		if (text.includes('\u0000')) throw new Error(`${file.name}: 텍스트 파일이 아닙니다`);
		return { kind: 'text', name: file.name, mime: file.type || 'text/plain', size: file.size, data: clip(text) };
	}
	throw new Error(`${file.name}: 이미지·텍스트·PDF 만 첨부할 수 있습니다`);
}

async function image(file: File): Promise<AttachmentInput> {
	const bitmap = await createImageBitmap(file).catch(() => {
		throw new Error(`${file.name}: 이미지를 읽지 못했습니다`);
	});
	const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('이미지를 처리하지 못했습니다');
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	for (const q of [0.85, 0.7, 0.55, 0.4]) {
		const data = canvas.toDataURL('image/webp', q);
		const mime = data.slice(5, data.indexOf(';')) as AttachmentInput['mime'];
		if (data.length <= ATTACHMENT_IMAGE_MAX && (IMAGE_TYPES as readonly string[]).includes(mime))
			return { kind: 'image', name: file.name, mime: mime as (typeof IMAGE_TYPES)[number], size: file.size, data };
	}
	throw new Error(`${file.name}: 이미지가 너무 큽니다`);
}

// PDF.js 는 처음 PDF 를 열 때 불러온다 (첫 화면 번들을 가볍게)
async function pdfText(file: File): Promise<string> {
	const pdfjs = await import('pdfjs-dist');
	const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
	const doc = await task.promise;
	const pages: string[] = [];
	let length = 0;
	for (let i = 1; i <= doc.numPages && length < ATTACHMENT_TEXT_MAX; i++) {
		const content = await (await doc.getPage(i)).getTextContent();
		const text = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
		pages.push(`[${i}쪽]\n${text.trim()}`);
		length += text.length;
	}
	await task.destroy();
	return pages.join('\n\n');
}
