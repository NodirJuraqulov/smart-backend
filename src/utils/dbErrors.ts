interface DuplicateKeyError {
  code: string;
  sqlMessage?: string;
  message: string;
}

function asDuplicateKeyError(err: unknown): DuplicateKeyError | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { code?: unknown };
  if (candidate.code !== "ER_DUP_ENTRY") return null;
  return err as DuplicateKeyError;
}

export function isDuplicateKeyError(err: unknown, keyName?: string): boolean {
  const duplicateError = asDuplicateKeyError(err);
  if (!duplicateError) return false;
  if (!keyName) return true;
  return (duplicateError.sqlMessage ?? "").includes(keyName);
}
