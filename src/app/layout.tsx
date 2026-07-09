import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Instrument_Sans } from "next/font/google";
import "./globals.css";

// Single deliberate typeface, used throughout via weight/size/tracking for
// hierarchy -- editorial-fashion-adjacent brands (Apple, COS, Aritzia) lean
// on one well-chosen sans rather than mixing families. Avoids Inter/Space
// Grotesk specifically, which read as the generic AI-generated default.
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Aesthetic Match",
  description:
    "Turn a handful of looks you love into a persistent style profile, matched against real inventory from independent fashion brands.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${instrumentSans.className} antialiased`}>{children}</body>
    </html>
  );
}
