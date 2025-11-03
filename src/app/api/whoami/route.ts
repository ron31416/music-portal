// src/app/api/whoami/route.ts
import { NextResponse } from "next/server";

export function GET(req: Request) {
    const url = new URL(req.url);

    const envOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? "(unset)";

    // list cookie names only (don't echo values for security)
    const cookieHeader = req.headers.get("cookie") ?? "";
    const cookieNames = cookieHeader
        .split(";")
        .map(c => c.trim().split("=")[0])
        .filter(Boolean);

    return NextResponse.json({
        url: url.toString(),
        hostname: url.hostname,
        protocol: url.protocol,
        canonicalEnvOrigin: envOrigin,
        cookieNames
    });
}
