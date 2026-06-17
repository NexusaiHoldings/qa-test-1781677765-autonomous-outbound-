/**
 * /settings/mailbox — Founder Mailbox Connection settings page.
 *
 * Lets the founder connect their Gmail or Outlook account so that outbound
 * SDR sequence emails are sent from their personal address (not a platform
 * address). Tokens are encrypted and stored in sdr_mailbox_connections.
 *
 * OAuth flow:
 *  1. Founder clicks "Connect Gmail" or "Connect Outlook" (server action).
 *  2. Server action builds the provider auth URL and redirects.
 *  3. Provider redirects back to this page with ?code=...&state=...
 *  4. Server component detects the callback params, exchanges the code,
 *     stores encrypted tokens, and redirects to the clean URL.
 *
 * Required env vars (see apps/web/lib/sdr/mailbox-router.ts for full list):
 *   GOOGLE_REDIRECT_URI  = https://<host>/settings/mailbox
 *   AZURE_REDIRECT_URI   = https://<host>/settings/mailbox
 */

import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  getActiveConnection,
  disconnectMailbox,
  handleOAuthCallback,
  buildGmailAuthUrl,
  buildOutlookAuthUrl,
  type MailboxConnection,
} from "@/lib/sdr/mailbox-router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  searchParams: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  };
}

export default async function MailboxSettingsPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }

  // ── OAuth error returned by provider ──────────────────────────────────────
  if (searchParams.error) {
    const description =
      searchParams.error_description ?? searchParams.error;
    return (
      <main>
        <h1>Mailbox Connection</h1>
        <p>
          Connect your Gmail or Outlook account so outbound emails appear to
          come from you personally.
        </p>
        <div className="card">
          <p>
            <strong>Authorization failed:</strong> {description}
          </p>
          <p className="muted">
            Please try connecting again. If the problem persists, check that
            your OAuth app credentials are configured correctly.
          </p>
          <ConnectButtons />
        </div>
      </main>
    );
  }

  // ── OAuth callback — exchange code for tokens ─────────────────────────────
  if (searchParams.code && searchParams.state) {
    try {
      await handleOAuthCallback(searchParams.code, searchParams.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return (
        <main>
          <h1>Mailbox Connection</h1>
          <p>
            Connect your Gmail or Outlook account so outbound emails appear to
            come from you personally.
          </p>
          <div className="card">
            <p>
              <strong>Connection error:</strong> {message}
            </p>
            <p className="muted">
              Please try again. Make sure your OAuth app has the required
              Mail.Send scope and that the redirect URI matches exactly.
            </p>
            <ConnectButtons />
          </div>
        </main>
      );
    }
    // Redirect to the clean URL so a refresh does not re-submit the code
    redirect("/settings/mailbox");
  }

  // ── Normal page render ────────────────────────────────────────────────────
  const connection = await getActiveConnection(user.id);

  // Server action: initiate Gmail OAuth flow
  async function connectGmailAction(): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) redirect("/login");
    redirect(buildGmailAuthUrl(currentUser.id));
  }

  // Server action: initiate Outlook OAuth flow
  async function connectOutlookAction(): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) redirect("/login");
    redirect(buildOutlookAuthUrl(currentUser.id));
  }

  // Server action: disconnect active mailbox
  async function disconnectAction(): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) return;
    await disconnectMailbox(currentUser.id);
    redirect("/settings/mailbox");
  }

  return (
    <main>
      <h1>Mailbox Connection</h1>
      <p>
        Connect your Gmail or Outlook account so outbound SDR emails are sent
        from your personal address — not a platform address.
      </p>

      {connection ? (
        <ConnectedCard
          connection={connection}
          disconnectAction={disconnectAction}
        />
      ) : (
        <EmptyState
          connectGmailAction={connectGmailAction}
          connectOutlookAction={connectOutlookAction}
        />
      )}

      <section>
        <h2>How it works</h2>
        <ul>
          <li>
            Your OAuth tokens are encrypted with AES-256-GCM before storage.
          </li>
          <li>
            Tokens are refreshed automatically — you only need to re-connect if
            you revoke access in your Google or Microsoft account.
          </li>
          <li>
            You can switch providers at any time by connecting a different
            account.
          </li>
        </ul>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectedCard({
  connection,
  disconnectAction,
}: {
  connection: MailboxConnection;
  disconnectAction: () => Promise<void>;
}): JSX.Element {
  const providerLabel =
    connection.provider === "gmail" ? "Gmail" : "Outlook";
  const connectedAt = connection.updatedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="card">
      <table>
        <tbody>
          <tr>
            <th scope="row">Provider</th>
            <td>{providerLabel}</td>
          </tr>
          <tr>
            <th scope="row">Send-from address</th>
            <td>{connection.emailAddress}</td>
          </tr>
          <tr>
            <th scope="row">Connected</th>
            <td>{connectedAt}</td>
          </tr>
          <tr>
            <th scope="row">Status</th>
            <td>Active</td>
          </tr>
        </tbody>
      </table>

      <form action={disconnectAction} style={{ marginTop: "1rem" }}>
        <button type="submit" className="btn secondary">
          Disconnect mailbox
        </button>
      </form>
    </div>
  );
}

function EmptyState({
  connectGmailAction,
  connectOutlookAction,
}: {
  connectGmailAction: () => Promise<void>;
  connectOutlookAction: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="empty">
      <p>No mailbox connected yet.</p>
      <p className="muted">
        Connect Gmail or Outlook to start sending outbound emails from your
        personal address.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
        <form action={connectGmailAction}>
          <button type="submit" className="btn">
            Connect Gmail
          </button>
        </form>
        <form action={connectOutlookAction}>
          <button type="submit" className="btn secondary">
            Connect Outlook
          </button>
        </form>
      </div>
    </div>
  );
}

function ConnectButtons(): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap" }}>
      <a href="/settings/mailbox" className="btn">
        Try connecting Gmail
      </a>
      <a href="/settings/mailbox" className="btn secondary">
        Try connecting Outlook
      </a>
    </div>
  );
}
