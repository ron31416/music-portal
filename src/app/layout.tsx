// src/app/layout.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

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

async function computeSandboxHost(): Promise<boolean> {
  const h = await headers();                    // ← await here
  const host = h.get("host") ?? "";

  const canonical = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  let canonicalHost = "";
  let apexHost = "";
  try {
    canonicalHost = canonical ? new URL(canonical).host : "";
    apexHost = canonicalHost.replace(/^www\./, "");
  } catch {
    // ignore parse failures
  }

  // Local dev & vercel previews are never sandbox viewers
  if (host === "localhost" || host.startsWith("localhost:") || host.endsWith(".vercel.app")) {
    return false;
  }

  if (!apexHost) { return false; }

  // Any subdomain of apex that is NOT canonical and NOT www.* → sandbox viewer host
  if (host.endsWith(`.${apexHost}`) && host !== canonicalHost && host !== `www.${apexHost}`) {
    return true;
  }

  return false;
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const isSandboxViewerHost = await computeSandboxHost();   // ← await here

  // Sandbox viewer hosts: no global header/spacing
  if (isSandboxViewerHost) {
    return (
      <html lang="en">
        <body className="m-0 p-0 overflow-hidden bg-white">
          {children}
        </body>
      </html>
    );
  }

  // Normal hosts: keep your site chrome here if you have one
  return (
    <html lang="en">
      <body>
        {/* e.g., <Header /> */}
        <div>{children}</div>
      </body>
    </html>
  );
}
