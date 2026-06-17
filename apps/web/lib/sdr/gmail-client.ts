/**
 * Gmail OAuth client for SDR send-from-founder mailbox.
 *
 * Handles the Google OAuth 2.0 authorization code flow and Gmail API email
 * dispatch. Tokens are returned to the caller (mailbox-router) for encrypted
 * storage — this module never writes to the database directly.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID       — Google OAuth app client ID
 *   GOOGLE_CLIENT_SECRET   — Google OAuth app client secret
 *   GOOGLE_REDIRECT_URI    — Callback URL (must match Google console config)
 */

const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export interface GmailTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  emailAddress: string;
}

export interface GmailSendParams {
  to: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
}

/**
 * Build the Google OAuth authorization URL with the given opaque state token.
 * `prompt: "consent"` forces a refresh token to be issued even for returning users.
 */
export function getGmailAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? "",
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code returned by Google for access + refresh tokens.
 * Fetches the user's email address via the userinfo endpoint.
 */
export async function exchangeGmailCode(
  code: string,
  redirectUri: string
): Promise<GmailTokens> {
  const tokenResp = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `Gmail code exchange failed (${tokenResp.status}): ${body}`
    );
  }

  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!tokenData.refresh_token) {
    throw new Error(
      "Gmail did not return a refresh token. Re-authorize with prompt=consent."
    );
  }

  const userResp = await fetch(GMAIL_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResp.ok) {
    throw new Error(`Failed to fetch Gmail user info (${userResp.status})`);
  }

  const userInfo = (await userResp.json()) as { email: string };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    emailAddress: userInfo.email,
  };
}

/**
 * Use the refresh token to obtain a new access token.
 * Google may optionally issue a new refresh token; we keep the old one if not.
 */
export async function refreshGmailToken(
  existing: GmailTokens
): Promise<GmailTokens> {
  const tokenResp = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: existing.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `Gmail token refresh failed (${tokenResp.status}): ${body}`
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
 * Send an email via the Gmail API using a valid access token.
 * Builds a minimal RFC 2822 MIME message, base64url-encodes it, and POSTs it.
 * Returns the Gmail message ID assigned by Google.
 */
export async function sendGmailEmail(
  accessToken: string,
  params: GmailSendParams
): Promise<string> {
  const { to, fromEmail, fromName, subject, htmlBody, textBody } = params;
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const content = htmlBody ?? textBody ?? "";
  const contentType = htmlBody ? "text/html" : "text/plain";

  const mimeMessage = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    ``,
    content,
  ].join("\r\n");

  // Gmail API requires standard base64url without padding
  const raw = Buffer.from(mimeMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const sendResp = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendResp.ok) {
    const body = await sendResp.text();
    throw new Error(`Gmail send failed (${sendResp.status}): ${body}`);
  }

  const result = (await sendResp.json()) as { id: string };
  return result.id;
}
