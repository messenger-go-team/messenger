import { SharedArray } from "k6/data";

export const fixturePairs = new SharedArray("messenger fixture pairs", () => {
  const file = __ENV.K6_FIXTURE_FILE;
  const baseUrl = __ENV.BASE_URL;
  if (!file || !baseUrl) throw new Error("Set K6_FIXTURE_FILE and BASE_URL");
  const minimumTtl = Number(__ENV.K6_MIN_TOKEN_TTL_SECONDS ?? "60");
  if (!Number.isSafeInteger(minimumTtl) || minimumTtl < 0 ||
      (__ENV.K6_MIN_TOKEN_TTL_SECONDS ?? "60").trim() === "") {
    throw new Error("K6_MIN_TOKEN_TTL_SECONDS must be a nonnegative integer");
  }

  let manifest;
  try {
    manifest = JSON.parse(open(file));
  } catch {
    throw new Error("Cannot read the private fixture manifest");
  }
  if (manifest?.version !== 1 || manifest.baseUrl !== baseUrl) {
    throw new Error("Fixture manifest version or target origin does not match");
  }
  const validAfter = Date.now() + minimumTtl * 1000;
  if (!Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt <= validAfter) {
    throw new Error("Fixture access tokens are expired or have insufficient TTL. Prepare fixtures again.");
  }
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0 ||
      manifest.pairs.some((pair) =>
        !pair?.chatId || ![pair.a, pair.b].every((account) =>
          account?.id && typeof account.accessToken === "string" && account.accessToken &&
          Number.isSafeInteger(account.expiresAt) && account.expiresAt > validAfter,
        ),
      )) {
    throw new Error("Incomplete fixture pairs or insufficient access-token TTL");
  }
  return manifest.pairs;
});
