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
  const id = isPositiveIntString(idParam) ? Number(idParam) : undefined;

  if (id === undefined) {
    return (
      <p style={{ color: "crimson" }}>
        No score id provided. Use <code>?id=2</code>.
      </p>
    );
  }

  const src = `/api/song/${id}`;

  return (
    <div
      style={{
        position: "relative",
        background: "#fff",
        width: "100%",
        minHeight: 0,
      }}
    >
      <AnnotationsProvider songId={id}>
        <ScoreViewer src={src} />
      </AnnotationsProvider>
    </div>
  );
}
