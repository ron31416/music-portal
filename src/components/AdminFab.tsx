// src/components/AdminFab.tsx
import Link from "next/link";
import { getCurrentUserInfo } from "@/lib/currentUser";

export default async function AdminFab() {
  const { isAdmin } = await getCurrentUserInfo();

  if (!isAdmin) {
    return null; // hide if not admin
  }

  return (
    <Link
      href="/admin"
      className="fixed right-4 bottom-4 rounded-full px-4 py-2 border shadow"
      aria-label="Admin"
    >
      Admin
    </Link>
  );
}
