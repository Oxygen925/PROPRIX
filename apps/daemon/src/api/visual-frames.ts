// 시각화 문서 보관: 앱 창의 CSP 를 물려받지 않게 iframe 을 daemon 주소에서 연다 (srcdoc 은 부모 CSP 를 상속해 스크립트가 막힌다).
// 인증 없이 읽으므로 주소는 내용의 해시, 응답은 CSP sandbox 로 opaque origin 에 가둔다. 메모리에만 두고 오래된 것부터 지운다
import { createHash } from "node:crypto";
import { VISUAL_CSP } from "@proprix/shared";

const MAX_DOCS = 64;
const ID = /^[0-9a-f]{64}$/;

export class VisualFrames {
  private readonly docs = new Map<string, string>();

  put(doc: string): string {
    const id = createHash("sha256").update(doc).digest("hex");
    this.docs.delete(id);
    this.docs.set(id, doc);
    for (const old of this.docs.keys()) {
      if (this.docs.size <= MAX_DOCS) break;
      this.docs.delete(old);
    }
    return id;
  }

  response(id: string): Response {
    const doc = ID.test(id) ? this.docs.get(id) : undefined;
    if (doc === undefined) return new Response("Not Found", { status: 404 });
    return new Response(doc, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${VISUAL_CSP}; sandbox allow-scripts`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
