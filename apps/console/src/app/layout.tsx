import type { ReactNode } from "react";

export const metadata = {
  title: "Agentic Platform — Runs",
  description: "Read-only run viewer: table of runs and per-run step timeline",
};

// Deliberately boring (build-plan Phase 1): truthful over beautiful.
const bodyStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 14,
  margin: "2rem",
  color: "#111",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={bodyStyle}>
        <h1 style={{ fontSize: 18 }}>agentic platform — run viewer (read-only)</h1>
        {children}
      </body>
    </html>
  );
}
