// 아바타 이미지: 가운데를 정사각형으로 잘라 256px 로 줄이고 webp data URL 로 (daemon 상한 안으로 품질을 낮춰 가며)
import { AVATAR_IMAGE_MAX } from '@proprix/shared';

const SIZE = 256;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function avatarDataUrl(file: File): Promise<string> {
	if (!TYPES.includes(file.type)) throw new Error('png·jpeg·webp 이미지만 올릴 수 있습니다.');
	const bitmap = await createImageBitmap(file).catch(() => {
		throw new Error('이미지를 읽지 못했습니다.');
	});
	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement('canvas');
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('이미지를 처리하지 못했습니다.');
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
	bitmap.close();
	for (const q of [0.9, 0.8, 0.65, 0.5, 0.35]) {
		const url = canvas.toDataURL('image/webp', q);
		// webp 를 못 만드는 환경이면 png 가 나온다 — 그래도 상한 안이면 쓴다
		if (url.length <= AVATAR_IMAGE_MAX) return url;
	}
	throw new Error('이미지가 너무 큽니다. 더 단순한 이미지를 골라 주세요.');
}
