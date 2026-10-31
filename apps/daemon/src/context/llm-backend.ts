import type { AiRequest } from "@proprix/siwc";
import type { StreamOptions, StreamResult } from "../auth/account";

// SiwcAccount 의 추론 부분 (테스트에서 바꿔 끼울 수 있게)
export interface LlmBackend {
  stream(request: AiRequest, opt: StreamOptions): Promise<StreamResult>;
}
