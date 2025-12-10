// src/lib/requireAdminPage.ts
import { redirect } from "next/navigation";
import { getCurrentUserInfo } from "@/lib/currentUser";

export async function requireAdminPage(): Promise<void> {
  const { email, isAdmin } = await getCurrentUserInfo();

  // Not signed in → go to login with return path
  if (!email) {
    redirect("/login?next=/admin");
  }

  // Signed in but not admin → go home (or a 403 page if you prefer)
  if (!isAdmin) {
    redirect("/");
  }

  // Otherwise: allowed through
}
