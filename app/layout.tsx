import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ШІ-бот криптосигналів",
  description: "Локальна панель живих криптосигналів"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
