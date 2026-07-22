import type { ReactNode } from "react";

export const metadata = {
  title: "OmniArena × Vercel AI SDK",
  description: "Blind LLM arena mode wired through the Vercel AI SDK adapter.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          margin: 0,
          background: "#0b0d12",
          color: "#e7e9ee",
        }}
      >
        {children}
      </body>
    </html>
  );
}
