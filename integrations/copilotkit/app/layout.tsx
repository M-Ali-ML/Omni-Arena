import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OmniArena × CopilotKit",
  description:
    "Blind A/B model matchups in a CopilotKit chat, over OmniArena's AG-UI adapter.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
