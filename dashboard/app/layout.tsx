import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "AI Health Harness", description: "Eval results for the clinical note summariser" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
