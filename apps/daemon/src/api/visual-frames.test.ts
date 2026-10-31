import { expect, test } from "bun:test";
import { VISUAL_CSP } from "@proprix/shared";
import { loadConfig } from "../config";
import { startServer } from "./server";
import { VisualFrames } from "./visual-frames";

test("문서를 인증 없이 sandbox CSP 와 함께 돌려주고, 없는 주소·쓰기는 막는다", async () => {
  const frames = new VisualFrames();
  const api = startServer({ ...loadConfig({}), port: 0, apiToken: "t".repeat(24) }, undefined, undefined, null, frames);
  try {
    const id = frames.put("<p>그림</p>");
    const res = await fetch(`${api.url}/api/visual-frame/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>그림</p>");
    expect(res.headers.get("content-security-policy")).toBe(`${VISUAL_CSP}; sandbox allow-scripts`);
    expect(res.headers.get("content-type")).toContain("text/html");

    expect((await fetch(`${api.url}/api/visual-frame/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${api.url}/api/visual-frame/..%2Fsettings`)).status).toBe(404);
    expect((await fetch(`${api.url}/api/visual-frame/${id}`, { method: "POST" })).status).toBe(401);
    // 다른 API 는 그대로 인증이 필요하다
    expect((await fetch(`${api.url}/api/settings`)).status).toBe(401);
  } finally {
    await api.stop();
  }
});

test("같은 내용은 같은 주소, 오래된 문서는 지운다", () => {
  const frames = new VisualFrames();
  const first = frames.put("문서 0");
  expect(frames.put("문서 0")).toBe(first);
  for (let i = 1; i <= 64; i++) frames.put(`문서 ${i}`);
  expect(frames.response(first).status).toBe(404);
});
