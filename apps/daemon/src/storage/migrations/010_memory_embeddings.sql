-- 로컬 임베딩 (선택 기능): 기억 원문의 문장 벡터. 모델이나 내용이 바뀌면 다시 계산한다
CREATE TABLE memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  vec        BLOB NOT NULL, -- Float32Array (정규화됨)
  updated_at INTEGER NOT NULL
);
