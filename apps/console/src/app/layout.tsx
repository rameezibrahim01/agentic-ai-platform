import type { ReactNode } from "react";
import { currentSession } from "../lib/auth";
import { tenantDisplayName } from "../lib/store";

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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Tenant badge (ticket 038): the header always says which tenant the
  // session is scoped to — the binding is visible, not implicit.
  const session = await currentSession().catch(() => null);
  const tenant = session?.tenant;
  const displayName = tenant !== undefined ? await tenantDisplayName(tenant) : null;
  return (
    <html lang="en">
      <body style={bodyStyle}>
        <h1 style={{ fontSize: 18 }}>
          agentic platform — run viewer (read-only)
          {tenant !== undefined ? (
            <span style={{ fontWeight: "normal", color: "#555" }}>
              {" "}
              · tenant: {displayName ?? tenant} ({tenant})
            </span>
          ) : null}
        </h1>
        {children}
      </body>
    </html>
  );
}
