import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Daily News · Claude Code + AI coding",
  description:
    "Daily 3-story digest, hand-picked at 08:00 Asia/Taipei by a Claude Code Routine. Each run's full execution log is public.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-slate-900 font-sans">
        <header className="border-b-2 border-slate-900">
          <div className="max-w-6xl mx-auto px-8 py-5 flex items-center justify-between">
            <Link href="/" className="font-bold tracking-tight text-2xl text-slate-900">
              Daily News
              <span className="text-slate-500 font-normal text-base ml-3">· Claude Code + AI coding</span>
            </Link>
            <nav className="flex gap-8 text-lg font-semibold text-slate-700">
              <Link href="/" className="hover:text-slate-900 hover:underline underline-offset-4">Today</Link>
              <Link href="/archive" className="hover:text-slate-900 hover:underline underline-offset-4">Archive</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 py-6 text-center text-base text-slate-600">
          Picked daily at 08:00 Asia/Taipei by a Claude Code Routine ·
          <a href="https://github.com/aipmtw/showcase-003-daily-news" className="underline ml-2 font-semibold">source code</a>
          · AIA × Claude Code Showcase 003
        </footer>
      </body>
    </html>
  );
}
