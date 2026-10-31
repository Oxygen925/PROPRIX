// 리서치 화면 상태 (P12d): 채팅 흐름(화면)과 에이전트 패널(레이아웃)이 함께 본다.
// 불러온 기록에 실시간 이벤트를 덧입혀, 행동 로그·글·대화를 시간순 한 흐름으로 만든다
import { app } from '#lib/app.svelte.js';
import type { ResearchEvent, ResearchMessage, ResearchPage, ResearchRun } from '@proprix/shared';

export type StreamItem =
	| { k: 'start'; key: string; at: number; agents: number }
	| { k: 'log'; key: string; at: number; run: ResearchRun; lines: ResearchEvent[] }
	| { k: 'result'; key: string; at: number; run: ResearchRun }
	| { k: 'note'; key: string; at: number; run: ResearchRun }
	| { k: 'msg'; key: string; at: number; m: ResearchMessage };

const upsert = <T extends { id: string }>(base: T[], live: T[]): T[] => {
	const m = new Map(base.map((x) => [x.id, x]));
	for (const x of live) m.set(x.id, x);
	return [...m.values()];
};

class ResearchView {
	id = $state('');
	loading = $state(false);
	runs = $state<ResearchRun[]>([]); // 새것부터
	events = $state<ResearchEvent[]>([]);
	messages = $state<ResearchMessage[]>([]);
	pages = $state<(ResearchPage & { agentId: string })[]>([]); // 패널: 보는 묶음에서 읽은 페이지
	batchId = $state(''); // 패널이 보는 묶음 ('' 이면 최신)

	research = $derived(app.researches.find((r) => r.id === this.id) ?? null);
	current = $derived.by(() => {
		const live = new Map((app.researchLive[this.id] ?? []).map((r) => [r.id, r]));
		return this.runs.map((r) => live.get(r.id) ?? r);
	});
	running = $derived(app.researchRunning(this.id));
	allMessages = $derived(
		upsert(this.messages, app.researchMessages[this.id] ?? []).toSorted((a, b) => a.at - b.at)
	);
	answering = $derived(this.allMessages.some((m) => m.status === 'streaming'));
	batches = $derived.by(() => {
		const m = new Map<string, ResearchRun[]>();
		for (const r of this.current) m.set(r.batchId, [r, ...(m.get(r.batchId) ?? [])]); // 묶음 안은 만든 순서
		return [...m.entries()].map(([key, list]) => ({ key, list }));
	});
	batch = $derived(
		(this.batches.find((b) => b.key === this.batchId) ?? this.batches[0])?.list ?? []
	);
	hasArticle = $derived(this.current.some((r) => r.result && (r.noteId || r.changeId)));

	// 시간순 한 흐름: 묶음 시작 표시, 에이전트별 행동 로그(연속된 줄은 한 덩어리), 글, 말풍선
	items = $derived.by<StreamItem[]>(() => {
		const runs = new Map(this.current.map((r) => [r.id, r]));
		const live = this.current.flatMap((r) => app.researchEvents[r.id] ?? []);
		const events = upsert(this.events, live).toSorted((a, b) => a.at - b.at);
		const out: (StreamItem & { p: number })[] = [];
		for (const b of this.batches) {
			const first = b.list[0];
			if (first) out.push({ k: 'start', key: `s-${b.key}`, at: first.startedAt, agents: b.list.length, p: 0 });
		}
		let block: (StreamItem & { k: 'log' }) | null = null;
		for (const e of events) {
			const run = runs.get(e.runId);
			if (!run) continue;
			if (block && block.run.agentId === run.agentId && block.run.id === run.id) block.lines.push(e);
			else {
				block = { k: 'log', key: `l-${e.id}`, at: e.at, run, lines: [e] };
				out.push({ ...block, p: 1 });
				block = out.at(-1) as StreamItem & { k: 'log' };
			}
		}
		for (const r of this.current) {
			if (r.status === 'running') continue;
			const at = r.finishedAt ?? r.startedAt;
			if (r.result) out.push({ k: 'result', key: `r-${r.id}`, at, run: r, p: 2 });
			else if (r.status !== 'done' && r.role !== 'collect') out.push({ k: 'note', key: `n-${r.id}`, at, run: r, p: 2 });
		}
		for (const m of this.allMessages) out.push({ k: 'msg', key: m.id, at: m.at, m, p: 1 });
		return out.toSorted((a, b) => a.at - b.at || a.p - b.p);
	});

	async load(id: string) {
		this.id = id;
		this.loading = true;
		try {
			const t = await app.researchTimeline(id);
			if (id !== this.id) return;
			this.runs = t.runs;
			this.events = t.events;
			this.messages = t.messages;
		} finally {
			this.loading = false;
		}
	}

	async loadPages() {
		const list = this.batch;
		const details = await Promise.all(list.map((r) => app.researchRun(r.id)));
		this.pages = details.flatMap((d) => d.pages.map((p) => ({ ...p, agentId: d.agentId })));
	}
}

export const researchView = new ResearchView();
