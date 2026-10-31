// 수정·다시 받기 판단 (요약에 들어가지 않은 최근 메시지만. 그 사용자 메시지 뒤의 대화는 지워진다)
import type { Message, Room } from '@proprix/shared';

/** 다시 보낼 사용자 메시지 (답이면 그 앞의 사용자 메시지) */
function turnStart(messages: Message[], m: Message): Message | undefined {
	for (let j = messages.findIndex((x) => x.id === m.id); j >= 0; j--)
		if (messages[j]?.role === 'user') return messages[j];
}

export function canRewind(
	messages: Message[],
	m: Message,
	ctx: { streaming: boolean; room: Room | null | undefined; coveredUntil: number }
): boolean {
	if (ctx.streaming || ctx.room?.kind === 'lounge' || m.debateId || m.proactive || m.status === 'streaming') return false;
	const u = turnStart(messages, m);
	return !!u && !u.debateId && u.createdAt > ctx.coveredUntil;
}

/** 이 턴 뒤에 이어진 대화 중 지워질 메시지 수 (이 턴의 답은 어차피 바뀌므로 세지 않는다) */
export function laterCount(messages: Message[], m: Message): number {
	const u = turnStart(messages, m);
	const i = u ? messages.findIndex((x) => x.id === u.id) : -1;
	const next = i < 0 ? -1 : messages.findIndex((x, j) => j > i && x.role === 'user');
	return next < 0 ? 0 : messages.length - next;
}
