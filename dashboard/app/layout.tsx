import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "AI Health Harness", description: "Eval results for the clinical note summariser" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <nav className="mx-auto flex max-w-5xl gap-6 px-4 pt-6 text-sm text-[var(--ink-2)]">
          <Link href="/" className="font-semibold text-[var(--ink)]">AI Health Harness</Link>
          <Link href="/" className="hover:text-[var(--ink)]">Overview</Link>
          <Link href="/compare" className="hover:text-[var(--ink)]">Compare</Link>
        </nav>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
