// src/app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import NavAccount from "@/components/NavAccount";

export const metadata: Metadata = {
  title: "Music Portal",
  description: "",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Top bar */}
        <div className="w-full border-b">
          <div className="mx-auto max-w-screen-xl px-3 py-2 flex items-center justify-between">
            <div className="text-sm font-semibold">Music Portal</div>
            <NavAccount />
          </div>
        </div>

        {/* Page content */}
        <div className="mx-auto max-w-screen-xl px-3 py-3">
          {children}
        </div>
      </body>
    </html>
  );
}
