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
  const id = isPositiveIntString(params.get("id")) ? params.get("id")! : undefined;

  // Build the canonical, same-origin API URL from the id
  const src = id !== undefined ? `/api/song/${id}` : undefined;

  if (src === undefined) {
    return (
      <p style={{ color: "crimson" }}>
        No score id provided. Open this page with <code>?id=2</code>.
      </p>
    );
  }

  // We already know `id` is a positive integer string here.
  const songId = Number(id);

  // TEMP: hard-code your dev user_id for now.
  // Replace this with the real logged-in user's id once we wire auth in.
  const userId = 1; // TODO: replace with actual user id for your account

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
