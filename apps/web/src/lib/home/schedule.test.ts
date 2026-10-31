/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type Agent, DEFAULT_CHECKIN, type Reminder } from '@proprix/shared';
import { laterReminders, todaySchedule } from './schedule';

const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 29 + dayOffset, h, m).getTime(); // 2026-10-29 (목)
const now = at(12);

const reminder = (id: string, dueAt: number, status: Reminder['status'] = 'scheduled'): Reminder => ({
	id,
	roomId: 'r',
	agentId: 'a1',
	text: id,
	dueAt,
	repeat: 'none',
	status,
	firedCount: 0,
	lastFiredAt: null,
	createdAt: 0
});

const agent = (id: string, checkin = DEFAULT_CHECKIN) => ({ id, checkin }) as unknown as Agent;

describe('todaySchedule', () => {
	test('오늘의 예약 리마인더와 오늘 요일 체크인을 시각 순으로', () => {
		const items = todaySchedule(
			[reminder('저녁', at(18)), reminder('내일', at(9, 0, 1)), reminder('취소됨', at(15), 'cancelled'), reminder('아침', at(8))],
			[
				agent('a1', { enabled: true, time: '09:30', days: [4] }), // 목요일
				agent('a2', { enabled: true, time: '10:00', days: [1] }), // 월요일만
				agent('a3', { enabled: false, time: '07:00', days: [4] })
			],
			now
		);
		expect(items.map((i) => i.text)).toEqual(['아침', '정기 체크인', '저녁']);
		expect(items[1]).toMatchObject({ kind: 'checkin', agentId: 'a1', at: at(9, 30) });
	});

	test('오늘 이후 리마인더 수', () => {
		expect(laterReminders([reminder('a', at(18)), reminder('b', at(9, 0, 1)), reminder('c', at(9, 0, 3))], now)).toBe(2);
	});
});
