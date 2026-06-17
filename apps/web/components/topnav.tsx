/**
 * Substrate Top Navigation — substrate-topnav-001 (2026-05-24).
 *
 * Renders the navigation strip at the top of every page. Reads its
 * link manifest from apps/web/lib/nav-config.ts so agents can extend
 * the nav by editing config, not by re-implementing the component.
 *
 * Per the Spec the substrate ships with just a Home entry; per
 * cto-prompt-nav-requirement-001, CTO's F1-001 extends NAV_CONFIG
 * to include the company's specific feature paths.
 *
 * Server component — zero client JS bundled.
 */

import Link from "next/link";
import type { JSX } from "react";

import { NAV_CONFIG, type NavLink, type NavGroup } from "@/lib/nav-config";
import { getSessionUser, isAdminEmail } from "@/lib/admin-auth";
import { UserMenu } from "@/components/UserMenu";

export async function TopNav(): Promise<JSX.Element> {
  const companyName = process.env.COMPANY_NAME || "Portfolio Company";
  // Resolve the session user once (NO DB hit when there is no cookie). Logged-in
  // users get a profile avatar; anonymous users get a Log in link. The Admin
  // link renders only for allow-listed admins.
  const user = await getSessionUser();
  const isAdmin = user ? isAdminEmail(user.email) : false;

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        background: "var(--substrate-bg, #fff)",
        color: "var(--substrate-fg, #111)",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <Link
        href="/"
        style={{
          fontWeight: 700,
          fontSize: 18,
          color: "inherit",
          textDecoration: "none",
        }}
      >
        {companyName}
      </Link>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {NAV_CONFIG.primary.map((link) => (
          <NavItem key={link.href} {...link} />
        ))}
        {NAV_CONFIG.groups.map((group) => (
          <NavGroupItem key={group.label} group={group} />
        ))}
        {isAdmin && <NavItem href="/crm" label="CRM" />}
        {isAdmin && <NavItem href="/admin/analytics" label="Analytics" />}
        {isAdmin && <NavItem href="/admin" label="Admin" />}
        {user ? (
          <UserMenu email={user.email} />
        ) : (
          <NavItem href="/login" label="Log in" />
        )}
      </div>
    </nav>
  );
}

function NavItem({ href, label }: NavLink): JSX.Element {
  return (
    <Link
      href={href}
      style={{
        padding: "6px 12px",
        borderRadius: 6,
        color: "inherit",
        textDecoration: "none",
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      {label}
    </Link>
  );
}

function NavGroupItem({ group }: { group: NavGroup }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 6,
        fontSize: 14,
        color: "rgba(0,0,0,0.6)",
      }}
    >
      <span style={{ fontWeight: 600 }}>{group.label}:</span>
      {group.links.map((link, idx) => (
        <span
          key={link.href}
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          {idx > 0 && (
            <span style={{ margin: "0 4px", opacity: 0.4 }}>·</span>
          )}
          <Link
            href={link.href}
            style={{
              color: "var(--substrate-accent, #2563eb)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            {link.label}
          </Link>
        </span>
      ))}
    </span>
  );
}
