/**
 * Outlook (Microsoft Graph) OAuth client for SDR send-from-founder mailbox.
 *
 * Handles the Microsoft identity platform authorization code flow and Graph
 * API email dispatch. Tokens are returned to the caller (mailbox-router) for
 * encrypted storage — this module never writes to the database directly.
 *
 * Required env vars:
 *   AZURE_CLIENT_ID      — Entra (Azure AD) application client ID
 *   AZURE_CLIENT_SECRET  — Entra application client secret
 *   AZURE_REDIRECT_URI   — Callback URL (must match app registration config)
 *   AZURE_TENANT_ID      — (optional) Tenant ID; defaults to "common" for
 *                          multi-tenant / personal account support
 */

import { randomUUID } from "node:crypto";

const OUTLOOK_SCOPES = [
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
].join(" ");

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  emailAddress: string;
}

export interface OutlookSendParams {
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  fromName?: string;
}

function tenantId(): string {
  return process.env.AZURE_TENANT_ID ?? "common";
}

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`;
}

/**
 * Build the Microsoft identity platform authorization URL with the given
 * opaque state token.
 */
export function getOutlookAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: process.env.AZURE_REDIRECT_URI ?? "",
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state,
  });
  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange the authorization code returned by Microsoft for access + refresh
 * tokens. Fetches the user's email address via the Graph /me endpoint.
 */
export async function exchangeOutlookCode(
  code: string,
  redirectUri: string
): Promise<OutlookTokens> {
  const tokenResp = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.AZURE_CLIENT_ID ?? "",
      client_secret: process.env.AZURE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: OUTLOOK_SCOPES,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `Outlook code exchange failed (${tokenResp.status}): ${body}`
    );
  }

  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!tokenData.refresh_token) {
    throw new Error(
      "Outlook did not return a refresh token. Ensure offline_access scope is requested."
    );
  }

  const userResp = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResp.ok) {
    throw new Error(`Failed to fetch Outlook user info (${userResp.status})`);
  }

  const userInfo = (await userResp.json()) as {
    mail: string | null;
    userPrincipalName: string;
  };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    emailAddress: userInfo.mail ?? userInfo.userPrincipalName,
  };
}

/**
 * Use the refresh token to obtain a new access token via Microsoft identity.
 * Microsoft always returns a new refresh token; we replace the old one.
 */
export async function refreshOutlookToken(
  existing: OutlookTokens
): Promise<OutlookTokens> {
  const tokenResp = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: existing.refreshToken,
      client_id: process.env.AZURE_CLIENT_ID ?? "",
      client_secret: process.env.AZURE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      scope: OUTLOOK_SCOPES,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `Outlook token refresh failed (${tokenResp.status}): ${body}`
    );
  }

  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? existing.refreshToken,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    emailAddress: existing.emailAddress,
  };
}

/**
 * Send an email via the Microsoft Graph /me/sendMail endpoint.
 * Returns a synthetic UUID as the message identifier (Graph sendMail returns
 * HTTP 202 No Content, so no server-assigned ID is available).
 */
export async function sendOutlookEmail(
  accessToken: string,
  params: OutlookSendParams
): Promise<string> {
  const { to, subject, htmlBody, textBody } = params;
  const bodyContent = htmlBody ?? textBody ?? "";
  const contentType = htmlBody ? "HTML" : "Text";

  const payload = {
    message: {
      subject,
      body: { contentType, content: bodyContent },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };

  const sendResp = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!sendResp.ok) {
    const body = await sendResp.text();
    throw new Error(`Outlook send failed (${sendResp.status}): ${body}`);
  }

  // Graph sendMail returns 202 No Content — generate a correlation ID
  return randomUUID();
}
