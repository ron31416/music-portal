// src/app/page.tsx  (server component – NO "use client")
import AdminFab from "@/components/AdminFab";
import HomeClient from "./page.client";

export default function Home() {
  return (
    <main
      className="mx-auto max-w-2xl p-6 space-y-6"
      style={{ paddingTop: 56 }} // headroom for fixed Admin pill
    >
      <AdminFab />
      <HomeClient />
    </main>
  );
}
