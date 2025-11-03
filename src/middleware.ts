// src/middleware.ts
import { NextResponse, type NextRequest } from "next/server";

/** Force every request onto the env's canonical origin (protocol + host). */
export function middleware(req: NextRequest) {
    const canonical = process.env.NEXT_PUBLIC_SITE_URL;
    if (!canonical) { return NextResponse.next(); }

    const want = new URL(canonical);
    const url = new URL(req.url);

    const sameProto = url.protocol === want.protocol;
    const sameHost = url.hostname === want.hostname;

    if (sameProto && sameHost) { return NextResponse.next(); }

    const dest = new URL(url.href);
    dest.protocol = want.protocol;
    dest.hostname = want.hostname;
    return NextResponse.redirect(dest, 308);
}

export const config = {
    matcher: ["/((?!_next/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
