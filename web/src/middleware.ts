import { NextResponse, type NextRequest } from "next/server";

/**
 * Gate for /kurasi.
 *
 * Cloudflare Access authenticates in front of the Worker, so an unauthorised
 * request should never arrive here at all. This verifies the JWT it mints
 * anyway, because Access is bound to a hostname: anything that reaches the
 * Worker by another route — a workers.dev subdomain, a second custom domain,
 * a Cloudflare misconfiguration — arrives with the edge check skipped. The
 * signature check does not care how the request got here.
 *
 * Required Worker vars (wrangler secret put / dashboard):
 *   CF_ACCESS_TEAM_DOMAIN   e.g. yourteam.cloudflareaccess.com
 *   CF_ACCESS_AUD           the Application Audience tag from the Access app
 *
 * With them unset the gate fails closed in production and opens in `next dev`,
 * so local curation needs no Cloudflare account.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlToJson(input: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (jwksCache && fresh) return jwksCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = b64urlToJson(rawHeader) as { kid?: string; alg?: string };
  // Access signs RS256. Pinning it rejects the `alg: none` downgrade outright.
  if (header.alg !== "RS256" || !header.kid) return false;

  const jwk = (await getJwks(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSignature),
    signed
  );
  if (!ok) return false;

  const payload = b64urlToJson(rawPayload) as {
    aud?: string | string[];
    exp?: number;
    iss?: string;
  };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;
  if (payload.iss !== `https://${teamDomain}`) return false;

  // The audience tag is what binds this token to THIS Access application — a
  // valid token for any other app in the same team would otherwise pass.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return audiences.includes(aud);
}

export async function middleware(req: NextRequest) {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;

  if (!teamDomain || !aud) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("Kurasi is not configured for this deployment.", {
      status: 503,
    });
  }

  const token =
    req.headers.get("Cf-Access-Jwt-Assertion") ??
    req.cookies.get("CF_Authorization")?.value;
  if (!token) return new NextResponse("Unauthorized", { status: 401 });

  try {
    if (!(await verifyAccessJwt(token, teamDomain, aud))) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } catch {
    // A JWKS fetch failure must not become an open door.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/kurasi", "/kurasi/:path*"],
};
