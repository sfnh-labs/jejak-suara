import { NextRequest, NextResponse } from "next/server";

const AUTH_CREDENTIALS = process.env.BASIC_AUTH_CREDENTIALS;
const CLOSED_LAUNCH = process.env.CLOSED_LAUNCH === "true";

function decodeBase64(str: string): string {
  return atob(str);
}

/** Compares in time independent of where the first difference falls. */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Length is not secret here (it leaks through the comparison either way),
  // but bail early so the loop below always compares equal-length buffers.
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function middleware(request: NextRequest) {
  if (!CLOSED_LAUNCH || !AUTH_CREDENTIALS) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");

  if (authHeader?.startsWith("Basic ")) {
    const encoded = authHeader.slice(6);
    try {
      const decoded = decodeBase64(encoded);
      if (safeEqual(decoded, AUTH_CREDENTIALS)) {
        return NextResponse.next();
      }
    } catch {
      // Invalid base64, fall through to 401
    }
  }

  return new NextResponse(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="Jejak Suara (Closed Launch)", charset="UTF-8"`,
    },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
