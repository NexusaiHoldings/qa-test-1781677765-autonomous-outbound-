/**
 * Mailbox router — the central dispatch layer for the SDR sequence drip cron.
 *
 * Responsibilities:
 *  1. Store OAuth tokens (encrypted at rest) in sdr_mailbox_connections.
 *  2. On each send, load the founder's active connection, refresh the token
 *     if expiring within 5 minutes, decrypt, and dispatch via the right
 *     provider client (Gmail or Outlook).
 *  3. Expose connect/disconnect helpers consumed by the settings page.
 *
 * Required env vars:
 *   DATABASE_URL             — PostgreSQL connection string
 *   MAILBOX_ENCRYPTION_KEY   — 64-char hex string (32 bytes, AES-256-GCM key)
 *   GOOGLE_REDIRECT_URI      — OAuth callback URL for Gmail
 *   AZURE_REDIRECT_URI       — OAuth callback URL for Outlook
 *
 * Database table (create once via migration):
 *
 *   CREATE TABLE IF NOT EXISTS sdr_mailbox_connections (
 *     id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id                 uuid NOT NULL,
 *     provider                text NOT NULL,          -- 'gmail' | 'outlook'
 *     email_address           text NOT NULL,
 *     access_token_encrypted  text NOT NULL,
 *     refresh_token_encrypted text NOT NULL,
 *     token_expires_at        timestamptz NOT NULL,
 *     is_active               boolean NOT NULL DEFAULT true,
 *     created_at              timestamptz NOT NULL DEFAULT now(),
 *     updated_at              timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_sdr_mailbox_user
 *     ON sdr_mailbox_connections (user_id, is_active);
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  getGmailAuthUrl,
  exchangeGmailCode,
  refreshGmailToken,
  sendGmailEmail,
  type GmailTokens,
} from "./gmail-client";
import {
  getOutlookAuthUrl,
  exchangeOutlookCode,
  refreshOutlookToken,
  sendOutlookEmail,
  type OutlookTokens,
} from "./outlook-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MailboxProvider = "gmail" | "outlook";

export interface MailboxConnection {
  id: string;
  userId: string;
  provider: MailboxProvider;
  emailAddress: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  fromName?: string;
}

// ---------------------------------------------------------------------------
// Database helpers (pg pool — same pattern as apps/web/lib/db.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // `pg` is externalized in next.config.js — normal require resolves at runtime
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

// ---------------------------------------------------------------------------
// Token encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const hex = process.env.MAILBOX_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("MAILBOX_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "MAILBOX_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return key;
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: [12-byte IV][16-byte auth tag][ciphertext]
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  email_address: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: Date;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToConnection(row: ConnectionRow): MailboxConnection {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as MailboxProvider,
    emailAddress: row.email_address,
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    tokenExpiresAt: new Date(row.token_expires_at),
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Public API — connection management
// ---------------------------------------------------------------------------

/** Return the user's active mailbox connection, or null if none is connected. */
export async function getActiveConnection(
  userId: string
): Promise<MailboxConnection | null> {
  const rows = await dbQuery<ConnectionRow>(
    `SELECT id, user_id, provider, email_address,
            access_token_encrypted, refresh_token_encrypted,
            token_expires_at, is_active, created_at, updated_at
     FROM sdr_mailbox_connections
     WHERE user_id = $1 AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows.length > 0 ? rowToConnection(rows[0]) : null;
}

/**
 * Persist a newly-authorized set of tokens.
 * Deactivates any existing connection for the same user+provider first so
 * there is always at most one active connection per provider per user.
 */
export async function upsertMailboxConnection(
  userId: string,
  provider: MailboxProvider,
  tokens: GmailTokens | OutlookTokens
): Promise<MailboxConnection> {
  await dbQuery(
    `UPDATE sdr_mailbox_connections
     SET is_active = false, updated_at = now()
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );

  const id = randomUUID();
  const accessEncrypted = encryptToken(tokens.accessToken);
  const refreshEncrypted = encryptToken(tokens.refreshToken);

  await dbQuery(
    `INSERT INTO sdr_mailbox_connections
       (id, user_id, provider, email_address,
        access_token_encrypted, refresh_token_encrypted,
        token_expires_at, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), now())`,
    [
      id,
      userId,
      provider,
      tokens.emailAddress,
      accessEncrypted,
      refreshEncrypted,
      tokens.expiresAt,
    ]
  );

  const saved = await getActiveConnection(userId);
  if (!saved) {
    throw new Error("Failed to retrieve connection after upsert");
  }
  return saved;
}

/**
 * Deactivate the user's mailbox connection(s).
 * Pass `provider` to disconnect a specific provider only.
 */
export async function disconnectMailbox(
  userId: string,
  provider?: MailboxProvider
): Promise<void> {
  if (provider) {
    await dbQuery(
      `UPDATE sdr_mailbox_connections
       SET is_active = false, updated_at = now()
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
  } else {
    await dbQuery(
      `UPDATE sdr_mailbox_connections
       SET is_active = false, updated_at = now()
       WHERE user_id = $1`,
      [userId]
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — OAuth flow helpers
// ---------------------------------------------------------------------------

/**
 * Build a Gmail authorization URL that encodes the userId in the opaque
 * state parameter so the callback can associate the tokens.
 */
export function buildGmailAuthUrl(userId: string): string {
  const state = Buffer.from(
    JSON.stringify({ userId, provider: "gmail" }),
    "utf8"
  ).toString("base64url");
  return getGmailAuthUrl(state);
}

/**
 * Build an Outlook authorization URL with userId embedded in state.
 */
export function buildOutlookAuthUrl(userId: string): string {
  const state = Buffer.from(
    JSON.stringify({ userId, provider: "outlook" }),
    "utf8"
  ).toString("base64url");
  return getOutlookAuthUrl(state);
}

/**
 * Handle the OAuth callback after the provider redirects back.
 * Decodes the state, exchanges the code for tokens, and persists the
 * encrypted tokens to sdr_mailbox_connections.
 */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<MailboxConnection> {
  let statePayload: { userId: string; provider: MailboxProvider };
  try {
    statePayload = JSON.parse(
      Buffer.from(state, "base64url").toString("utf8")
    ) as { userId: string; provider: MailboxProvider };
  } catch {
    throw new Error("Invalid OAuth state parameter — cannot decode state");
  }

  const { userId, provider } = statePayload;

  if (provider === "gmail") {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "";
    const tokens = await exchangeGmailCode(code, redirectUri);
    return upsertMailboxConnection(userId, "gmail", tokens);
  }

  if (provider === "outlook") {
    const redirectUri = process.env.AZURE_REDIRECT_URI ?? "";
    const tokens = await exchangeOutlookCode(code, redirectUri);
    return upsertMailboxConnection(userId, "outlook", tokens);
  }

  throw new Error(`Unknown OAuth provider in state: ${provider}`);
}

// ---------------------------------------------------------------------------
// Public API — email dispatch
// ---------------------------------------------------------------------------

/**
 * Route an outbound email through the founder's connected mailbox.
 *
 * Called by the sequence drip cron on each touch. Automatically refreshes
 * the OAuth token if it is within 5 minutes of expiry before sending.
 *
 * Returns the provider-assigned message ID for logging / dedup.
 */
export async function routeEmail(
  userId: string,
  params: SendEmailParams
): Promise<string> {
  let connection = await getActiveConnection(userId);
  if (!connection) {
    throw new Error(
      `No active mailbox connection for user ${userId}. Connect Gmail or Outlook first.`
    );
  }

  // Proactively refresh when token expires within 5 minutes
  const msUntilExpiry = connection.tokenExpiresAt.getTime() - Date.now();
  if (msUntilExpiry < 5 * 60 * 1000) {
    connection = await refreshAndPersistTokens(connection);
  }

  const accessToken = decryptToken(connection.accessTokenEncrypted);

  if (connection.provider === "gmail") {
    return sendGmailEmail(accessToken, {
      to: params.to,
      fromEmail: connection.emailAddress,
      fromName: params.fromName,
      subject: params.subject,
      htmlBody: params.htmlBody,
      textBody: params.textBody,
    });
  }

  // outlook
  return sendOutlookEmail(accessToken, {
    to: params.to,
    subject: params.subject,
    htmlBody: params.htmlBody,
    textBody: params.textBody,
    fromName: params.fromName,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function refreshAndPersistTokens(
  connection: MailboxConnection
): Promise<MailboxConnection> {
  const existingRefreshToken = decryptToken(connection.refreshTokenEncrypted);

  let newTokens: GmailTokens | OutlookTokens;

  if (connection.provider === "gmail") {
    newTokens = await refreshGmailToken({
      accessToken: decryptToken(connection.accessTokenEncrypted),
      refreshToken: existingRefreshToken,
      expiresAt: connection.tokenExpiresAt,
      emailAddress: connection.emailAddress,
    });
  } else {
    newTokens = await refreshOutlookToken({
      accessToken: decryptToken(connection.accessTokenEncrypted),
      refreshToken: existingRefreshToken,
      expiresAt: connection.tokenExpiresAt,
      emailAddress: connection.emailAddress,
    });
  }

  const accessEncrypted = encryptToken(newTokens.accessToken);
  const refreshEncrypted = encryptToken(newTokens.refreshToken);

  await dbQuery(
    `UPDATE sdr_mailbox_connections
     SET access_token_encrypted = $1,
         refresh_token_encrypted = $2,
         token_expires_at = $3,
         updated_at = now()
     WHERE id = $4`,
    [accessEncrypted, refreshEncrypted, newTokens.expiresAt, connection.id]
  );

  return {
    ...connection,
    accessTokenEncrypted: accessEncrypted,
    refreshTokenEncrypted: refreshEncrypted,
    tokenExpiresAt: newTokens.expiresAt,
    updatedAt: new Date(),
  };
}
