"use client";
import { useSearchParams, useRouter } from "next/navigation";

export default function AuthErrorPage() {
    const params = useSearchParams();
    const router = useRouter();
    const msg = params.get("message") || "Unknown authentication error.";

    return (
        <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div style={{ width: "100%", maxWidth: 560, borderRadius: 16, border: "1px solid rgba(160,160,160,0.25)", boxShadow: "0 10px 30px rgba(0,0,0,0.25)", padding: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, margin: "4px 0 12px" }}>Authentication error</h1>
                <p style={{ fontSize: 14, opacity: .9, whiteSpace: "pre-wrap" }}>{msg}</p>
                <div style={{ marginTop: 18 }}>
                    <button
                        type="button"
                        onClick={() => router.push("/")}
                        style={{ borderRadius: 10, border: "1px solid rgba(160,160,160,0.35)", padding: "10px 12px", background: "transparent", color: "inherit", cursor: "pointer" }}
                    >
                        Go back home
                    </button>
                </div>
            </div>
        </div>
    );
}
