// 방 동작: 헤더 ⋯ 메뉴와 / 명령이 같이 쓴다 (동작·문구가 갈라지지 않게). 반환값은 알림 문구
import { goto } from '$app/navigation';
import { app } from '#lib/app.svelte.js';

export async function togglePin(): Promise<string> {
	const room = app.room;
	if (!room) return '';
	await app.updateRoom({ pinned: !room.pinned });
	return room.pinned ? '고정을 풀었습니다' : '맨 위에 고정했습니다';
}

export async function toggleArchive(): Promise<string> {
	const room = app.room;
	if (!room) return '';
	await app.updateRoom({ archived: !room.archived });
	return room.archived ? '목록으로 돌려놓았습니다' : '보관함으로 옮겼습니다';
}

export async function exportCurrent() {
	if (app.room) await app.exportRoom(app.room.id);
}

/** 그 에이전트와의 1:1 방으로 간다. 없으면 새로 연다 */
export async function openAgent(agentId: string) {
	const room = app.soloRooms(agentId)[0] ?? (await app.newRoom([agentId]));
	await goto(`/rooms/${room.id}`);
}

/** 지금 방의 참여자로 새 대화를 열고, 글이 있으면 첫 메시지로 보낸다 */
export async function newRoomLike(text = '') {
	const room = app.room;
	if (!room) return;
	const created = await app.newRoom(room.agentIds);
	await goto(`/rooms/${created.id}`);
	if (text) await app.sendTo(created.id, text);
}
