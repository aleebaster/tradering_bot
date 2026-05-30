import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Crypto Signal Bot",
  description: "Live local crypto signal dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
