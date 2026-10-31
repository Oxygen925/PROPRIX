import { expect, test } from "bun:test";
import { isNewer, UpdateChecker } from "./check";

test("버전 비교: 숫자로 비교하고 형식이 다르면 새 버전으로 보지 않는다", () => {
  expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("0.0.9", "0.1.0")).toBe(false);
  for (const bad of ["latest", "v1.0.0-rc.1", "<img>", "1.0"]) expect(isNewer(bad, "0.1.0")).toBe(false);
});

function checker(respond: () => Response) {
  let now = 0;
  let hits = 0;
  const c = new UpdateChecker(
    "0.1.0",
    (async () => {
      hits++;
      return respond();
    }) as unknown as typeof fetch,
    () => now,
  );
  return {
    c,
    hits: () => hits,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("새 버전을 알려 주고 하루 보관한다. 동시 요청은 한 번만 보낸다", async () => {
  const s = checker(() => Response.json({ tag_name: "v0.2.0" }));
  const [a, b] = await Promise.all([s.c.latest(), s.c.latest()]);
  expect([a, b]).toEqual(["0.2.0", "0.2.0"]);
  s.advance(23 * 60 * 60_000);
  await s.c.latest();
  expect(s.hits()).toBe(1);
  s.advance(2 * 60 * 60_000);
  await s.c.latest();
  expect(s.hits()).toBe(2);
});

test("비공개 저장소(404)·오류·이상한 응답은 알리지 않고 1시간 뒤 다시 확인한다", async () => {
  for (const respond of [
    () => new Response("없음", { status: 404 }),
    () => new Response("not json"),
    () => Response.json({ tag_name: 3 }),
    () => {
      throw new Error("연결 실패");
    },
  ]) {
    const s = checker(respond);
    expect(await s.c.latest()).toBeNull();
    s.advance(30 * 60_000);
    await s.c.latest();
    expect(s.hits()).toBe(1);
    s.advance(31 * 60_000);
    await s.c.latest();
    expect(s.hits()).toBe(2);
  }
});

test("같거나 낮은 버전은 알리지 않는다", async () => {
  expect(await checker(() => Response.json({ tag_name: "v0.1.0" })).c.latest()).toBeNull();
});
