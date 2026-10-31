// bun tools/mock-siwc/src/main.ts [--port=N]
import { startMockSiwc } from "./mock";

const portArg = process.argv.find((a) => a.startsWith("--port="));
const mock = await startMockSiwc(portArg ? Number(portArg.slice(7)) : 47900);
console.log(`[mock-siwc] ${mock.url}  (모드: POST /mock/mode, 통계: GET /mock/stats)`);
