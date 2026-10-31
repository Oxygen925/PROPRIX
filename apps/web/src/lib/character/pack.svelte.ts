// 페르소나 표정 묶음 캐시: 버전이 같으면 다시 받지 않는다 (이미지가 들어 있어 페르소나 목록과 따로 받는다)
import { api } from '#lib/api.js';
import { CharacterPack } from '@proprix/shared';

class CharacterPacks {
	private packs = $state<Record<string, CharacterPack>>({});
	private readonly tried = new Set<string>();

	// 없으면 받기 시작하고 null (도착하면 화면이 다시 그려진다). 실패한 버전은 다시 시도하지 않는다
	get(personaId: string, version: string | null): CharacterPack | null {
		if (!personaId || !version) return null;
		const known = this.packs[personaId];
		if (known?.version === version) return known;
		const key = `${personaId}:${version}`;
		if (!this.tried.has(key)) {
			this.tried.add(key);
			api(CharacterPack, `/personas/${personaId}/character`)
				.then((p) => {
					this.packs[personaId] = p;
				})
				.catch((e) => console.warn('[character] 표정 묶음을 받지 못함', e));
		}
		return null;
	}
}

export const characterPacks = new CharacterPacks();
