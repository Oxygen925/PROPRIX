import { expect, test } from 'bun:test';
import { orbitRate, rampRate } from './orbit';

test('궤도 속도: 평소 1배, 생각 중 3배, 출력 중 가장 빠르게', () => {
	expect(orbitRate('idle')).toBe(1);
	expect(orbitRate('thinking')).toBe(3);
	expect(orbitRate('working')).toBeCloseTo(12000 / 2200);
});

test('속도 변화: 한 프레임에 조금씩 다가가 결국 목표에 닿고, 느려질 때도 같다', () => {
	const once = rampRate(1, 3, 16);
	expect(once).toBeGreaterThan(1);
	expect(once).toBeLessThan(1.1);
	let up = 1;
	for (let i = 0; i < 400; i++) up = rampRate(up, 3, 16);
	expect(up).toBe(3);
	const down = rampRate(3, 1, 16);
	expect(down).toBeLessThan(3);
	expect(down).toBeGreaterThan(2.9);
});
