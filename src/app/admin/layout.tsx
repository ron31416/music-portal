// app/admin/layout.tsx
import { requireAdminPage } from "@/lib/requireAdminPage";

export default async function AdminLayout({
    children,
}: { children: React.ReactNode }) {
    await requireAdminPage(); // server-side check before rendering any admin page
    return <>{children}</>;
}
