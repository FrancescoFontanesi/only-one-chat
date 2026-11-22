export interface TestSelection {
  readonly criterion: string;
  readonly className: string;
  readonly name: string;
  readonly files: readonly string[];
  /** An assertion message identifying the expected baseline failure. */
  readonly expectedFailure: string;
}

export interface VerificationResult {
  readonly detail?: string;
  readonly status: 'passed' | 'failed' | 'inconclusive' | 'unavailable';
  readonly summary: string;
}

export interface VerificationEvidence extends VerificationResult {
  readonly reportHash?: string | undefined;
  readonly baselineReportHash?: string | undefined;
  readonly reviewVerdict?: string | undefined;
  readonly round?: number;
  readonly budget?: number;
  readonly id: string;
  readonly origin: 'implementer' | 'reviewer';
  readonly comparison: 'pending' | 'confirmed' | 'already_passed' | 'inconclusive' | 'unavailable';
  readonly selection?: TestSelection | undefined;
  readonly detail: string;
}

export interface WorkVerification {
  begin(): void;
  progress?(round: number, budget: number): void;
  check(
    selection: TestSelection | undefined,
    origin: 'implementer' | 'reviewer',
    signal: AbortSignal,
    reviewVerdict?: string,
  ): Promise<VerificationResult>;
  finish(
    selection: TestSelection | undefined,
    origin: 'implementer' | 'reviewer',
    signal: AbortSignal,
  ): Promise<{ summary: string; result: VerificationResult }>;
}

export interface VerificationCheckpoint {
  readonly id: string;
  readonly baseline: string | null;
  readonly round: number;
  readonly budget: number;
}

/** Stored evidence is untrusted input when a chat is reopened. */
export function isVerificationEvidence(value: unknown): value is VerificationEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const test = item['selection'];
  if (test !== undefined) {
    if (!test || typeof test !== 'object') return false;
    const fields = test as Record<string, unknown>;
    if (
      !['criterion', 'className', 'name', 'expectedFailure'].every(
        (key) => typeof fields[key] === 'string' && fields[key].length <= 1024,
      )
    )
      return false;
    if (
      !Array.isArray(fields['files']) ||
      fields['files'].length > 16 ||
      !fields['files'].every((path) => typeof path === 'string' && path.length <= 512)
    )
      return false;
  }
  return (
    ['reportHash', 'baselineReportHash'].every(
      (key) =>
        item[key] === undefined ||
        (typeof item[key] === 'string' && /^[0-9a-f]{64}$/.test(item[key])),
    ) &&
    (item['reviewVerdict'] === undefined ||
      (typeof item['reviewVerdict'] === 'string' &&
        ['approved', 'with_reservations', 'rejected'].includes(item['reviewVerdict']))) &&
    typeof item['id'] === 'string' &&
    /^[a-z0-9-]{1,64}$/.test(item['id']) &&
    ['implementer', 'reviewer'].includes(String(item['origin'])) &&
    ['passed', 'failed', 'inconclusive', 'unavailable'].includes(String(item['status'])) &&
    ['pending', 'confirmed', 'already_passed', 'inconclusive', 'unavailable'].includes(
      String(item['comparison']),
    ) &&
    typeof item['summary'] === 'string' &&
    item['summary'].length <= 16384 &&
    typeof item['detail'] === 'string' &&
    item['detail'].length <= 65536 &&
    ['round', 'budget'].every(
      (key) =>
        item[key] === undefined ||
        (Number.isInteger(item[key]) && Number(item[key]) >= 0 && Number(item[key]) <= 3),
    )
  );
}
