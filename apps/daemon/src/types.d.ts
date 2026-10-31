declare module "*.sql" {
  const sql: string;
  export default sql;
}

// 리서치 본문 추출 (P11a): Readability 원본을 글자로 넣어 페이지 안에서 실행한다
declare module "@mozilla/readability/Readability.js" {
  const source: string;
  export default source;
}
