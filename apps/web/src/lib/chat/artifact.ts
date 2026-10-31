// 토론·협업 맺는 말을 산출물(메모·파일)로 저장할 때의 본문과 기본 파일 이름 (P10a)
import type { Debate, Message } from '@proprix/shared';

export const NOTE_BODY_MAX = 20_000; // NoteInput.body 상한

// 맺는 말 앞에 주제·참가자·진행자·날짜 한 줄
export function artifactBody(d: Debate, m: Message, name: (agentId: string) => string): string {
	const kind = d.mode === 'debate' ? '토론' : '협업';
	const date = new Date(m.createdAt).toLocaleDateString('sv-SE'); // YYYY-MM-DD
	const topic = d.topic.replace(/\s+/g, ' ').trim();
	const head = `> ${kind} · ${topic} · 참여자: ${d.agentIds.map(name).join(', ')} · 진행: ${name(d.moderatorId)} · ${date}`;
	return `${head}\n\n${m.content.trim()}\n`;
}

const BAD = '<>:"/\\|?*';

// 주제로 만든 파일 이름: 쓸 수 없는 글자·공백은 '-', 60자까지, 끝의 점·공백·'-' 는 뗀다 (Windows 규칙)
export function artifactFileName(topic: string): string {
	const safe = [...topic].map((c) => (c < ' ' || BAD.includes(c) ? ' ' : c)).join('');
	const base = safe.trim().replace(/\s+/g, '-').slice(0, 60).replace(/[-. ]+$/, '');
	return `${base || '결과'}.md`;
}
