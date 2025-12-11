// src/app/viewer/page.tsx

import ViewerClient from "./viewer-client";

export const dynamic = "force-dynamic";

export default function ViewerPage() {
  return (
    <main className="p-4">
      <ViewerClient />
    </main>
  );
}
