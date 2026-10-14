import type { Metadata, Viewport } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: no render-blocking request to fonts.googleapis.com,
// and the CSS variables here are what globals.css's --font-* tokens resolve to.
const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-public-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Jejak Suara",
  description: "Portal rekam jejak tokoh publik, dirangkum dari pemberitaan bersumber.",
};

// The browser chrome takes the brand red (Logo sheet).
export const viewport: Viewport = {
  themeColor: "#8B2E1F",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`${newsreader.variable} ${publicSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
