// 홈 '오늘 일정': 오늘 보낼 리마인더·오늘 요일의 체크인·오늘 실행할 예약 작업을 시각 순으로 (로컬 시간대)
import { type Agent, type Reminder, type Task, upcoming } from '@proprix/shared';

export interface ScheduleItem {
	key: string;
	at: number;
	kind: 'reminder' | 'checkin' | 'task';
	agentId: string;
	text: string;
	reminder?: Reminder; // 리마인더면 취소할 수 있게
}

const startOfDay = (t: number) => {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function todaySchedule(reminders: Reminder[], agents: Agent[], now = Date.now(), tasks: Task[] = []): ScheduleItem[] {
	const from = startOfDay(now);
	const to = from + 24 * 60 * 60 * 1000;
	const items: ScheduleItem[] = reminders
		.filter((r) => r.status === 'scheduled' && r.dueAt >= from && r.dueAt < to)
		.map((r) => ({ key: r.id, at: r.dueAt, kind: 'reminder', agentId: r.agentId, text: r.text, reminder: r }));
	const weekday = new Date(now).getDay();
	for (const a of agents) {
		if (!a.checkin.enabled || !a.checkin.days.includes(weekday)) continue;
		const [h = 0, m = 0] = a.checkin.time.split(':').map(Number);
		const at = new Date(from).setHours(h, m, 0, 0);
		items.push({ key: `checkin-${a.id}`, at, kind: 'checkin', agentId: a.id, text: '정기 체크인' });
	}
	for (const t of tasks) {
		if (!t.enabled) continue;
		try {
			for (const at of upcoming(t.schedule, from - 1, 24).filter((x) => x < to))
				items.push({ key: `task-${t.id}-${at}`, at, kind: 'task', agentId: t.agentId, text: t.title });
		} catch {
			// 잘못된 일정은 건너뛴다 (저장할 때 막는다)
		}
	}
	return items.sort((x, y) => x.at - y.at);
}

/** 오늘 이후로 예약된 리마인더 수 */
export const laterReminders = (reminders: Reminder[], now = Date.now()) =>
	reminders.filter((r) => r.status === 'scheduled' && r.dueAt >= startOfDay(now) + 24 * 60 * 60 * 1000).length;
