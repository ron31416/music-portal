// src/app/viewer/viewer-client.tsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ScoreViewer from "@/components/ScoreViewer";
import { AnnotationsProvider } from "@/components/AnnotationsProvider";

function isPositiveIntString(v: string | null): v is string {
  return v !== null && /^\d+$/.test(v);
}

export default function ViewerClient(): React.ReactElement {
  const params = useSearchParams();
  const id = isPositiveIntString(params.get("id")) ? params.get("id")! : undefined;

  // -----------------------------------------
  // Hooks MUST come before any early return
  // -----------------------------------------
  const [userId, setUserId] = useState<number | null>(null);
  const [checkedUser, setCheckedUser] = useState(false);

  useEffect(() => {
    let alive = true;

    async function loadUser() {
      try {
        const res = await fetch("/api/whoami", {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) {
          if (alive) { setCheckedUser(true); }
          return;
        }

        const json = await res.json();
        if (alive) {
          setUserId(json.userId ?? null);
          setCheckedUser(true);
        }
      } catch {
        if (alive) { setCheckedUser(true); }
      }
    }

    loadUser();
    return () => {
      alive = false;
    };
  }, []);

  // -----------------------------------------
  // Now the early return is allowed
  // -----------------------------------------
  if (id === undefined) {
    return (
      <p style={{ color: "crimson" }}>
        No score id provided. Open this page with <code>?id=2</code>.
      </p>
    );
  }

  const songId = Number(id);
  const src = `/api/song/${id}`;

  if (!checkedUser) {
    return <p>Loading…</p>;
  }

  if (userId === null) {
    return (
      <div
        style={{
          position: "relative",
          background: "#fff",
          width: "100%",
          minHeight: 0,
        }}
      >
        <p style={{ color: "crimson" }}>
          You must be signed in to view or edit annotations.
        </p>

        {/* Provider stays mounted, but userId=null means read-only mode */}
        <AnnotationsProvider songId={songId} userId={null}>
          <ScoreViewer src={src} />
        </AnnotationsProvider>
      </div>
    );
  }

  // -----------------------------------------
  // Normal render with real userId
  // -----------------------------------------
  return (
    <div
      style={{
        position: "relative",
        background: "#fff",
        width: "100%",
        minHeight: 0,
      }}
    >
      <AnnotationsProvider songId={songId} userId={userId}>
        <ScoreViewer src={src} />
      </AnnotationsProvider>
    </div>
  );
}
