// src/app/page.tsx  (server component – NO "use client")
import HomeClient from "./page.client";

export default function Home() {
  return (
    <main
      className="mx-auto max-w-2xl p-6 space-y-6"
      style={{ paddingTop: 10 }}
    >
      <HomeClient />
    </main>
  );
}
