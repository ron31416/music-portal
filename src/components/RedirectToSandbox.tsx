// src/components/RedirectToSandgox.tsx
'use client';
import { useEffect } from 'react';

const APEX = process.env.NEXT_PUBLIC_APEX_DOMAIN ?? 'ronsmusicstore.com';

function makeSlug(len = 10): string {
    try {
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => (b % 36).toString(36)).join('');
    } catch {
        return Math.random().toString(36).slice(2, 2 + len);
    }
}

function looksLikeSlug(label?: string) {
    return !!label && /^[a-z0-9]{8,12}$/.test(label);
}

export default function RedirectToSandbox() {
    useEffect(() => {
        try {
            const { protocol, hostname, pathname, search, hash } = window.location;
            // Debug escape hatch
            if (new URLSearchParams(search).has('nosandbox')) { return; }
            // Only operate on https (avoid dev http churn)
            if (protocol !== 'https:') { return; }

            // If this host isn't the apex or a subdomain of it, do nothing
            const isApexOrSub = hostname === APEX || hostname.endsWith('.' + APEX);
            if (!isApexOrSub) { return; }

            const parts = hostname.split('.');

            // If it's already slugged, do nothing (idempotent)
            if (looksLikeSlug(parts[0])) { return; }

            // Determine subdomain prefix before the apex ('' | 'dev' | 'staging' | 'foo.dev' | ...)
            const suffix = '.' + APEX;
            const prefix =
                hostname === APEX ? '' : hostname.slice(0, hostname.length - suffix.length); // e.g. '', 'dev', 'staging', 'foo.dev'

            const slug = makeSlug(10);
            const targetHost = prefix ? `${slug}.${prefix}.${APEX}` : `${slug}.${APEX}`;
            const target = `${protocol}//${targetHost}${pathname}${search}${hash}`;

            // Swap without adding history entry
            window.location.replace(target);
        } catch {
            // noop
        }
    }, []);

    return null;
}
