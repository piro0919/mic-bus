import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Sora } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

/* The heading face. Nine packages sharing one face are hard to tell apart. */
const display = Sora({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["700"],
});

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  applicationName: "shared-microphone",
  description:
    "Open the microphone once and share its audio frames with every consumer that needs them.",
  formatDetection: { telephone: false },
  metadataBase: new URL("https://shared-microphone.kkweb.io"),
  title: "shared-microphone - One Microphone, Many Listeners",
};

export const viewport: Viewport = {
  themeColor: "#18181b",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${display.variable} antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
