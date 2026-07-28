const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 2 * 60 * 60;

type ContributionTokenPayload = {
  version: number;
  jobId: string;
  videoId: string;
  reservationId: string;
  expiresAt: number;
};

export type ContributionGrant = {
  token: string;
  reservationId: string;
  expiresAt: string;
};

export async function createContributionGrant(input: {
  jobId: string;
  videoId: string;
}): Promise<ContributionGrant> {
  const reservationId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload: ContributionTokenPayload = {
    version: TOKEN_VERSION,
    jobId: input.jobId,
    videoId: input.videoId,
    reservationId,
    expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = await sign(encodedPayload);
  return {
    token: `${encodedPayload}.${signature}`,
    reservationId,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function verifyContributionGrant(
  token: string,
  expected: { jobId: string; videoId: string },
): Promise<ContributionTokenPayload | null> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return null;

  let payload: ContributionTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as ContributionTokenPayload;
  } catch {
    return null;
  }

  if (
    payload.version !== TOKEN_VERSION ||
    payload.jobId !== expected.jobId ||
    payload.videoId !== expected.videoId ||
    typeof payload.reservationId !== "string" ||
    !payload.reservationId ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  const key = await signingKey(["verify"]);
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const decoded = Buffer.from(encodedSignature, "base64url");
    signature = new Uint8Array(decoded.byteLength);
    signature.set(decoded);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(encodedPayload),
  );
  return valid ? payload : null;
}

export function contributionWorkerId(reservationId: string): string {
  return `contributor:${reservationId}`;
}

async function sign(value: string): Promise<string> {
  const key = await signingKey(["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Buffer.from(signature).toString("base64url");
}

async function signingKey(
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const secret =
    process.env.CONTRIBUTION_SECRET?.trim() ??
    process.env.WORKER_TOKEN?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "CONTRIBUTION_SECRET or WORKER_TOKEN must contain at least 32 characters",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}
