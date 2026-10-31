// / 명령 실행: 내장 명령은 화면에서 바로, 사용자 정의는 템플릿을 펼쳐 메시지로 보낸다
// (사용자 결정 2026-10-29: 없는 명령은 글 그대로 보냄, 팝업에서 Enter 는 이름만 채움)
import { goto } from '$app/navigation';
import { app } from '#lib/app.svelte.js';
import {
	type AgentEffort,
	BUILTIN_COMMANDS,
	type BuiltinCommand,
	type Command,
	commandKey,
	teamKey,
	expandCommand,
	MESSAGE_MAX,
	requiredArgs
} from '@proprix/shared';
import { exportCurrent, newRoomLike, toggleArchive, togglePin } from './room-actions.js';

export const EFFORT_LABEL: Record<AgentEffort, string> = { '': '자동', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음' };
// /effort 인자 (공백은 무시하고 비교)
const EFFORT_NAMES: Record<string, AgentEffort> = {
	자동: '',
	auto: '',
	낮음: 'low',
	low: 'low',
	보통: 'medium',
	medium: 'medium',
	높음: 'high',
	high: 'high',
	매우높음: 'xhigh',
	xhigh: 'xhigh'
};

export interface SlashItem {
	name: string;
	usage: string;
	description: string;
	builtin: boolean;
	skill?: boolean;
}

/** 사용자 정의 명령의 사용법 힌트: $1..$N 이 있으면 <1> <2>, 없으면 [내용] */
export function usageOf(c: Pick<Command, 'template'>): string {
	const n = requiredArgs(c.template);
	return n ? Array.from({ length: n }, (_, i) => `<${i + 1}>`).join(' ') : '[내용]';
}

export function findCommand(name: string): Command | undefined {
	const key = commandKey(name);
	return app.commands.find((c) => commandKey(c.name) === key);
}

/** 팝업 목록: 내장 → 사용자 정의, 각각 앞부분이 맞는 것 먼저 */
export function slashItems(query: string, lounge: boolean): SlashItem[] {
	const q = commandKey(query);
	const all: SlashItem[] = [
		...BUILTIN_COMMANDS.filter((b) => !lounge || b.lounge).map((b) => ({
			name: b.name,
			usage: b.args,
			description: b.description,
			builtin: true
		})),
		...app.commands.map((c) => ({
			name: c.name,
			usage: usageOf(c),
			description: c.description || (c.template.split('\n')[0] ?? '').slice(0, 60),
			builtin: false
		})),
		...(lounge
			? []
			: app.skills.map((s) => ({ name: s.name, usage: '[내용]', description: `Skill · ${s.description}`, builtin: false, skill: true })))
	];
	const key = (i: SlashItem) => commandKey(i.name);
	return [...all.filter((i) => key(i).startsWith(q)), ...all.filter((i) => !key(i).startsWith(q) && key(i).includes(q))];
}

/** 사용자 정의 명령을 펼친다. 필수 인자가 비거나 너무 길면 오류 */
export function expandUser(c: Command, rest: string): { text: string } | { error: string } {
	const r = expandCommand(c.template, rest);
	if (r.missing.length)
		return {
			error: `/${c.name} 에 인자 ${r.missing.map((n) => `$${n}`).join(', ')} 이(가) 필요합니다 — 사용법: /${c.name} ${usageOf(c)}`
		};
	if (r.tooLong) return { error: `펼친 내용이 ${MESSAGE_MAX.toLocaleString()}자를 넘습니다` };
	if (!r.text.trim()) return { error: '펼친 내용이 비어 있습니다' };
	return { text: r.text.trim() };
}

// 실행 결과: 오류(입력창에 그대로 남김) · 알림 문구 · 입력창이 열어야 할 것
export type SlashOutcome = { error: string } | { done: string } | { open: 'model' | 'help' };

const soloAgent = () => (app.room?.kind === 'chat' && app.roomAgents.length === 1 ? app.roomAgents[0] : undefined);
const signedIn = () => !!app.account?.planUsage;

async function pickModel(query: string): Promise<SlashOutcome> {
	const solo = soloAgent();
	const k = query.toLowerCase();
	if (solo && (k === '기본' || k === 'default')) {
		await app.setAgentModel(solo.id, '');
		return { done: `${solo.name}: 전역 기본 모델을 따릅니다` };
	}
	const exact = app.models.filter((m) => m.slug.toLowerCase() === k || m.displayName.toLowerCase() === k);
	const found = exact.length
		? exact
		: app.models.filter((m) => m.slug.toLowerCase().includes(k) || m.displayName.toLowerCase().includes(k));
	const m = found[0];
	if (!m) return { error: `'${query}' 에 맞는 모델이 없습니다` };
	if (found.length > 1) return { error: `여러 모델이 맞습니다: ${found.map((x) => x.displayName).join(', ')}` };
	if (solo) await app.setAgentModel(solo.id, m.slug);
	else await app.setModel(m.slug);
	return { done: `${solo ? `${solo.name}의 ` : ''}모델: ${m.displayName}` };
}

async function pickEffort(query: string): Promise<SlashOutcome> {
	const solo = soloAgent();
	if (!solo) return { error: '추론 강도는 1인 채팅에서만 바꿀 수 있습니다 (에이전트 편집기에서 각자 설정)' };
	if (!query) return { open: 'model' };
	const e = EFFORT_NAMES[query.replace(/\s+/g, '').toLowerCase()];
	if (e === undefined) return { error: '자동·낮음·보통·높음·매우높음 중에서 고르세요' };
	const supported = app.models.find((m) => m.slug === (solo.model || app.model))?.efforts ?? [];
	if (e && supported.length && !supported.includes(e)) return { error: `이 모델은 '${EFFORT_LABEL[e]}' 을(를) 지원하지 않습니다` };
	await app.setEffort(solo.id, e);
	return { done: `${solo.name}의 추론 강도: ${EFFORT_LABEL[e]}` };
}

export async function runBuiltin(b: BuiltinCommand, rest: string): Promise<SlashOutcome> {
	const room = app.room;
	if (!room) return { error: '채팅을 먼저 여세요' };
	if (room.kind === 'lounge' && !b.lounge) return { error: `/${b.name} 은(는) 라운지에서 쓸 수 없습니다` };
	if (!b.args && rest) return { error: `/${b.name} 은(는) 인자를 받지 않습니다` };
	switch (b.name) {
		case 'new':
			if (rest && !signedIn()) return { error: '먼저 ChatGPT 로 로그인하세요' };
			await newRoomLike(rest);
			return { done: '' };
		case 'model':
			return rest ? pickModel(rest) : { open: 'model' };
		case 'effort':
			return pickEffort(rest);
		case 'dir':
			app.roomDialog = 'workspace';
			return { done: '' };
		case 'debate':
		case 'collab':
			// 1인 대화에서도 연다: 방 밖 에이전트를 초대하고 이 대화의 기억·도구 작업을 넘긴다
			if (app.agents.length < 2) return { error: '토론·협업에는 에이전트가 2명 이상 필요합니다' };
			app.debateDraft = { mode: b.name, topic: rest };
			app.roomDialog = 'debate';
			return { done: '' };
		case 'team': {
			// 이름이 맞으면 그 팀으로 새 대화, 없거나 못 찾으면 고르기 (사용자 결정 2026-10-29)
			const team = rest ? app.teams.find((t) => teamKey(t.name) === teamKey(rest)) : undefined;
			if (!team) {
				app.teamPicker = true;
				return { done: '' };
			}
			await app.openTeam(team);
			return { done: '' };
		}
		case 'search':
			await goto(rest ? `/search?q=${encodeURIComponent(rest)}` : '/search');
			return { done: '' };
		case 'export':
			await exportCurrent();
			return { done: '' };
		case 'pin':
			return { done: await togglePin() };
		case 'archive':
			return { done: await toggleArchive() };
		case 'summary':
			if (!app.summary) return { error: '아직 이전 채팅 요약이 없습니다' };
			app.roomDialog = 'summary';
			return { done: '' };
		case 'memory':
			if (!signedIn()) return { error: '먼저 ChatGPT 로 로그인하세요' };
			return { done: await app.extractMemories() };
		case 'help':
			return { open: 'help' };
	}
	return { error: `/${b.name} 은(는) 아직 실행할 수 없습니다` };
}
