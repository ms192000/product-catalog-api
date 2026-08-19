/**
 * Configuration, read from the environment once at startup and passed explicitly.
 *
 * Nothing deeper in the codebase reads `process.env`, which keeps modules testable
 * and makes the complete set of knobs discoverable in one file.
 */
export interface Config {
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  defaultPageSize: number;
  /** Hard ceiling. Larger requests are clamped, not rejected. */
  maxPageSize: number;
  /** `max-age` on product reads. 0 disables client caching. */
  cacheMaxAgeSeconds: number;
  /** Requests per minute per IP. */
  rateLimit: number;
  /** When set, writes require `x-api-key`. Unset = open, for local exploration. */
  apiKey: string | undefined;
  /**
   * Which build this process is.
   *
   * Baked into the image at build time rather than read from a file, so it cannot
   * drift from the artefact it describes. Exposed on `/health` because "which
   * commit is actually live?" is the first question during an incident, and
   * answering it by SSHing in to compare tags is slow and error-prone.
   */
  build: {
    /** Commit the image was built from. Doubles as the image tag. */
    commit: string | null;
    builtAt: string | null;
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    port: intFromEnv('PORT', 3000),
    nodeEnv: (process.env.NODE_ENV ?? 'development') as Config['nodeEnv'],
    defaultPageSize: intFromEnv('DEFAULT_PAGE_SIZE', 20),
    maxPageSize: intFromEnv('MAX_PAGE_SIZE', 100),
    // 60s of shared caching. Safe because writes bump the version, which changes
    // the ETag — so a stale response is detectable on the next conditional GET.
    cacheMaxAgeSeconds: intFromEnv('CACHE_MAX_AGE', 60),
    rateLimit: intFromEnv('RATE_LIMIT', 600),
    apiKey: process.env.API_KEY,
    // Null outside a built image — running from source has no commit baked in, and
    // claiming one would be a lie.
    build: {
      commit: process.env.BUILD_COMMIT || null,
      builtAt: isoOrNull(process.env.BUILD_TIME),
    },
  };
}

/**
 * Normalises a build timestamp to ISO 8601, or null.
 *
 * The value comes from whatever stamped the image, and the obvious CI field for it
 * is a Unix epoch rather than a date string — which silently contradicts the
 * `date-time` format the API advertises. Converting here means the endpoint keeps
 * its contract regardless of which form the build system supplies, instead of the
 * contract depending on a detail of the pipeline.
 */
function isoOrNull(raw: string | undefined): string | null {
  if (!raw) return null;

  // All digits: a Unix timestamp, in seconds or milliseconds.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
