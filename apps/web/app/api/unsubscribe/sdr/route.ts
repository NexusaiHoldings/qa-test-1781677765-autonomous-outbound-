/**
 * GET /api/unsubscribe/sdr — CAN-SPAM compliant unsubscribe endpoint.
 *
 * Accepts a `token` query parameter (base64url-encoded recipient email)
 * or a plain `email` query parameter. Hashes the email with SHA-256 and
 * upserts it into sdr_suppression_list, then redirects to /unsubscribed.
 *
 * Every outbound SDR sequence email includes a unique unsubscribe link
 * pointing here. The token approach keeps raw email addresses out of URLs.
 */

import { NextResponse } from "next/server";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + crypto — not edge-compatible

// Lazily initialized PG pool (same singleton pattern as apps/web/lib/db.ts)
let _pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} | null = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function ensureTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_suppression_list (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      email_hash   TEXT        NOT NULL UNIQUE,
      unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source       TEXT        NOT NULL DEFAULT 'can-spam-unsubscribe'
    )
  `);
}

function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex");
}

function decodeToken(token: string): string | null {
  // Attempt base64url first, then standard base64
  const attempts = [
    () => Buffer.from(token, "base64url").toString("utf-8"),
    () => Buffer.from(token, "base64").toString("utf-8"),
  ];
  for (const attempt of attempts) {
    try {
      const decoded = attempt();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decoded)) {
        return decoded.toLowerCase().trim();
      }
    } catch {
      // continue to next attempt
    }
  }
  return null;
}

function getBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "http://localhost:3000";
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  const emailParam = searchParams.get("email");
  const baseUrl = getBaseUrl();

  let email: string | null = null;

  if (token) {
    email = decodeToken(token);
  } else if (emailParam) {
    const normalized = emailParam.toLowerCase().trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      email = normalized;
    }
  }

  if (!email) {
    console.info(
      JSON.stringify({
        event: "sdr_unsubscribe_invalid",
        token: token ? "[present]" : null,
        emailParam: emailParam ? "[present]" : null,
      }),
    );
    return NextResponse.redirect(`${baseUrl}/unsubscribed?status=invalid`, {
      status: 302,
    });
  }

  try {
    await ensureTable();
    const emailHash = hashEmail(email);
    const pool = getPool();
    await pool.query(
      `INSERT INTO sdr_suppression_list (email_hash, source)
       VALUES ($1, $2)
       ON CONFLICT (email_hash) DO NOTHING`,
      [emailHash, "can-spam-unsubscribe"],
    );
    console.info(
      JSON.stringify({
        event: "sdr_unsubscribe_success",
        email_hash: emailHash,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "sdr_unsubscribe_error",
        error: String(err),
      }),
    );
    return NextResponse.redirect(`${baseUrl}/unsubscribed?status=error`, {
      status: 302,
    });
  }

  return NextResponse.redirect(`${baseUrl}/unsubscribed?status=success`, {
    status: 302,
  });
}
