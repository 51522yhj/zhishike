const VECTOR_SIZE = 96;

export function embedText(text: string) {
  const vector = Array.from({ length: VECTOR_SIZE }, () => 0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % VECTOR_SIZE;
    vector[index] += 1 + Math.min(token.length / 12, 1);
  }

  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / length);
}

export function cosineSimilarity(a: number[], b: number[]) {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    total += a[i] * b[i];
  }
  return total;
}

export function tokenize(text: string) {
  const roughTokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokens: string[] = [];
  for (const token of roughTokens) {
    if (!/[\u4e00-\u9fff]/u.test(token)) {
      tokens.push(token);
      continue;
    }

    const chars = Array.from(token);
    tokens.push(...chars);
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens;
}
