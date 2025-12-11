// src/app/viewer/viewer-client.tsx
"use client";

import { useSearchParams } from "next/navigation";
import ScoreViewer from "@/components/ScoreViewer";
import { AnnotationsProvider } from "@/components/AnnotationsProvider";

function isPositiveIntString(v: string | null): v is string {
  return v !== null && /^\d+$/.test(v);
}

export default function ViewerClient(): React.ReactElement {
  const params = useSearchParams();

  const idParam = params.get("id");
  const uidParam = params.get("uid");      // <-- this is the key line

  const id = isPositiveIntString(idParam) ? Number(idParam) : undefined;
  const userId = isPositiveIntString(uidParam) ? Number(uidParam) : null;  // authoritative

  if (id === undefined) {
    return (
      <p style={{ color: "crimson" }}>
        No score id provided. Use <code>?id=2</code>.
      </p>
    );
  }

  const src = `/api/song/${id}`;

  //
  // If there is NO uid, this is a read-only viewer
  //
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

        {/* provider stays mounted but in read-only mode */}
        <AnnotationsProvider songId={id} userId={null}>
          <ScoreViewer src={src} />
        </AnnotationsProvider>
      </div>
    );
  }

  //
  // Normal: uid was passed in the URL
  //
  return (
    <div
      style={{
        position: "relative",
        background: "#fff",
        width: "100%",
        minHeight: 0,
      }}
    >
      <AnnotationsProvider songId={id} userId={userId}>
        <ScoreViewer src={src} />
      </AnnotationsProvider>
    </div>
  );
}
