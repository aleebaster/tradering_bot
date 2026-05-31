import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live Crypto Signal Radar | Telegram Trade Alerts",
  description: "Vercel dashboard для live криптосигналів з Telegram-сповіщеннями про угоди, в які варто зайти"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
