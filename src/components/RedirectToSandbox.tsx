// src/app/RedirectToSandbox.tsx
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

            // Only operate on apex or its subdomains
            const isApexOrSub = hostname === APEX || hostname.endsWith('.' + APEX);
            if (!isApexOrSub) { return; }

            // Split labels and drop a leading 'www' if present
            const parts = hostname.split('.');
            if (parts[0] === 'www') { parts.shift(); }

            // Already slugged? (idempotent)
            if (looksLikeSlug(parts[0])) { return; }

            // Apex labels, e.g. ['ronsmusicstore','com']
            const apexLabels = APEX.split('.');

            // Prefix labels are everything before the apex ('' | 'dev' | 'staging' | 'foo','dev' | …)
            const prefixLabels = parts.slice(0, Math.max(0, parts.length - apexLabels.length));

            const slug = makeSlug(10);
            const targetHost = [slug, ...prefixLabels, ...apexLabels].join('.');
            const target = `${protocol}//${targetHost}${pathname}${search}${hash}`;

            // Swap without adding history entry
            window.location.replace(target);
        } catch {
            /* noop */
        }
    }, []);

    return null;
}
