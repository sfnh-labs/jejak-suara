import { NextRequest, NextResponse } from "next/server";

const AUTH_CREDENTIALS = process.env.BASIC_AUTH_CREDENTIALS;
const CLOSED_LAUNCH = process.env.CLOSED_LAUNCH === "true";

function decodeBase64(str: string): string {
  return atob(str);
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
      if (decoded === AUTH_CREDENTIALS) {
        return NextResponse.next();
      }
    } catch {
      // Invalid base64, fall through to 401
    }
  }

  const url = new URL(request.url);
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
