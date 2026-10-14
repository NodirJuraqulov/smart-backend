export function canonicalizePlate(raw: string): string {
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mapping: Record<string, string> = {
    O: "0",
    I: "1",
    B: "8",
    S: "5",
  };
  return [...normalized].map((character) => mapping[character] ?? character).join("");
}

export function plateDistance(left: string, right: string): number {
  const canonicalLeft = canonicalizePlate(left);
  const canonicalRight = canonicalizePlate(right);
  const previous = Array.from({ length: canonicalRight.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= canonicalLeft.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= canonicalRight.length; rightIndex += 1) {
      const substitutionCost = canonicalLeft[leftIndex - 1] === canonicalRight[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[canonicalRight.length];
}

export function similarityPercent(left: string, right: string): number {
  const canonicalLeft = canonicalizePlate(left);
  const canonicalRight = canonicalizePlate(right);
  const length = Math.max(canonicalLeft.length, canonicalRight.length);
  if (length === 0) return 100;
  const similarity = 100 - (plateDistance(canonicalLeft, canonicalRight) / length) * 100;
  return Math.max(0, Math.min(100, Math.round(similarity)));
}
