// src/lib/sandboxUrl.ts
const APEX = process.env.NEXT_PUBLIC_APEX_DOMAIN || "";

/** True when hostname is apex or a subdomain of apex */
function isApexOrSub(host: string): boolean {
    return !!APEX && (host === APEX || host.endsWith("." + APEX));
}

/** Short, DNS-safe random slug (lowercase letters+digits) */
function randSlug(len = 10): string {
    try {
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => (b % 36).toString(36)).join("");
    } catch {
        return Math.random().toString(36).slice(2, 2 + len);
    }
}

/** Detect if first label looks like a random slug */
function isLikelySlug(label: string | undefined): boolean {
    return !!label && /^[a-z0-9]{8,12}$/.test(label);
}

/**
 * Build a sandboxed URL on a fresh subdomain so Chrome’s per-origin zoom is isolated.
 * In non-apex hosts (localhost / Vercel previews) we do not change host.
 */
export function makeSandboxUrl(path: string): string {
    const loc = typeof window !== "undefined" ? window.location : null;
    const proto = loc?.protocol === "http:" ? "http:" : "https:";
    const pathname = path.startsWith("/") ? path : `/${path}`;

    if (loc && isApexOrSub(loc.hostname)) {
        const parts = loc.hostname.split(".");
        const first = parts[0] ?? "";

        // If we already have slug.dev/apex form, replace slug; else prepend one
        if (isLikelySlug(first) && parts.length > 2) {
            parts[0] = randSlug(10);
        } else {
            parts.unshift(randSlug(10));
        }

        return `${proto}//${parts.join(".")}${pathname}`;
    }

    // Local or preview fallback
    const host = loc ? loc.host : APEX;
    return `${proto}//${host}${pathname}`;
}
