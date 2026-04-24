import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Daily News · Claude Code + AI coding",
  description:
    "Daily 4-story digest, hand-picked at 08:00 Asia/Taipei by a Claude Code Routine. Each run's full execution log is public.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-slate-900">
        <header className="border-b border-slate-200">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-semibold tracking-tight text-lg">
              Daily News
              <span className="text-slate-500 font-normal text-sm ml-2">· Claude Code + AI coding</span>
            </Link>
            <nav className="flex gap-5 text-sm text-slate-600">
              <Link href="/" className="hover:text-slate-900">Today</Link>
              <Link href="/archive" className="hover:text-slate-900">Archive</Link>
              <Link href="/runs" className="hover:text-slate-900">Runs</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 py-5 text-center text-xs text-slate-500">
          Picked daily at 08:00 Asia/Taipei by a Claude Code Routine ·
          <a href="https://github.com/aipmtw/showcase-003-daily-news" className="underline ml-1">source code</a>
          · AIA × Claude Code Showcase 003
        </footer>
      </body>
    </html>
  );
}
