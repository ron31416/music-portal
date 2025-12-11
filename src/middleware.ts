// src/middleware.ts
import { NextResponse, type NextRequest } from "next/server";

// Use your already-set canonical site URL (e.g. https://dev.ronsmusicstore.com)
const CANONICAL = process.env.NEXT_PUBLIC_SITE_URL ?? "";
const CANONICAL_URL = CANONICAL ? new URL(CANONICAL) : null;
const CANONICAL_HOST = CANONICAL_URL?.host ?? "";       // e.g. dev.ronsmusicstore.com
const APEX_HOST = CANONICAL_HOST.replace(/^www\./, ""); // e.g. ronsmusicstore.com

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const host = req.headers.get("host") ?? url.host;

  // If we don't have a canonical host configured, do nothing.
  if (!CANONICAL_HOST || !APEX_HOST) {
    return NextResponse.next();
  }

  // Always allow local dev and preview hosts
  if (
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host.endsWith(".vercel.app")
  ) {
    return NextResponse.next();
  }

  // If it's exactly the canonical host, we're good
  if (host === CANONICAL_HOST) {
    return NextResponse.next();
  }

  // Rewrite classic www → canonical host (or apex if that’s your canonical)
  if (host === `www.${APEX_HOST}`) {
    const to = new URL(url);
    to.hostname = CANONICAL_HOST;
    to.protocol = CANONICAL_URL?.protocol ?? to.protocol;
    return NextResponse.redirect(to, 308);
  }

  // If user hit the bare apex but your canonical is a subdomain (e.g., dev.ronsmusicstore.com),
  // gently redirect to the canonical host.
  if (host === APEX_HOST && CANONICAL_HOST !== APEX_HOST) {
    const to = new URL(url);
    to.hostname = CANONICAL_HOST;
    to.protocol = CANONICAL_URL?.protocol ?? to.protocol;
    return NextResponse.redirect(to, 308);
  }

  // Otherwise, just allow it (no sandbox subdomain logic anymore)
  return NextResponse.next();
}

// Run on “pages”, not static assets
export const config = {
  matcher: ["/((?!_next/|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)"],
};
