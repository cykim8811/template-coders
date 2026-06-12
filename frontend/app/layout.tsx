import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import { DevDeployBadge } from "@/components/DevDeployBadge";
import { Header } from "@/components/Header";
import { WarmingBar } from "@/components/WarmingBanner";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata = {
  title: "template-coders",
  description: "A coders.kr-aware SPA starter.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <WarmingBar />
        <DevDeployBadge />
        <div className="mx-auto max-w-3xl px-6 sm:px-8 pb-16">
          <Header />
          <main>{children}</main>
          <footer className="mt-20 border-t pt-6 text-[12px] text-muted-foreground leading-relaxed">
            Hosted on{" "}
            <a
              href="https://coders.kr"
              className="font-medium text-foreground/80 underline-offset-4 hover:underline"
            >
              coders.kr
            </a>
          </footer>
        </div>
      </body>
    </html>
  );
}
