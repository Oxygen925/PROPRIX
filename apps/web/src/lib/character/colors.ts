// 마스코트 색 (사용자 결정 2026-10-31): 배경은 아바타의 페르소나 색 원. 기본 페르소나 색이면 그림 원본 색(테마가 바꿀 수 있다), 나머지는 페르소나 색을 밝게 섞는다
const DEFAULT_PERSONA_COLOR = '#4f6bed';

// 아바타 배경: 기본 페르소나 색은 테마가 바꿀 수 있다
export function avatarBackground(color: string): string {
	return color.toLowerCase() === DEFAULT_PERSONA_COLOR ? `var(--mascot-default-bg, ${color})` : color;
}

// 상대 휘도 (0~1). #rgb·#rrggbb 가 아니면 null
function luminance(color: string): number | null {
	const m = /^#(?:([\da-f]{3})|([\da-f]{6}))$/i.exec(color);
	if (!m) return null;
	const hex = m[2] ?? [...(m[1] ?? '')].map((c) => c + c).join('');
	const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK = 0.08;
const LIGHT = 0.6;

export function mascotColors(color: string): { core: string; orbit: string } {
	if (!color || color.toLowerCase() === DEFAULT_PERSONA_COLOR) return { core: 'var(--mascot-default-core, #62a4f6)', orbit: 'var(--mascot-default-orbit, #c1dbfa)' };
	// 눈은 어두운 색이라 몸통은 밝아야 한다. 어두운 배경은 흰색을 더 섞고, 아주 밝은 배경은 어둡게 눌러 배경과 구분한다
	const l = luminance(color) ?? 0.5;
	if (l < DARK) return { core: `color-mix(in srgb, ${color} 35%, white)`, orbit: `color-mix(in srgb, ${color} 15%, white)` };
	if (l > LIGHT) return { core: `color-mix(in srgb, ${color} 80%, black)`, orbit: `color-mix(in srgb, ${color} 55%, black)` };
	return { core: `color-mix(in srgb, ${color} 65%, white)`, orbit: `color-mix(in srgb, ${color} 30%, white)` };
}
