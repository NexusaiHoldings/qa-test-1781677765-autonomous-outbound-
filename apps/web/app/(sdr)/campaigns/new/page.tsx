import type { JSX } from "react";
import { IcpForm, type SubmitResult } from "./icp-form";
import type { IcpConfig } from "@/lib/sdr/icp-validator";
import { validateCampaignInput } from "@/lib/sdr/icp-validator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SDR_CAMPAIGNS_DDL = `
CREATE TABLE IF NOT EXISTS sdr_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  icp jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

async function createCampaign(name: string, icp: IcpConfig): Promise<SubmitResult> {
  "use server";

  const validation = validateCampaignInput({ name, icp });
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  try {
    const { Pool } = await import(/* webpackIgnore: true */ "pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
      await pool.query(SDR_CAMPAIGNS_DDL);
      await pool.query(
        "INSERT INTO sdr_campaigns (name, icp) VALUES ($1, $2::jsonb)",
        [name.trim(), JSON.stringify(icp)],
      );
    } finally {
      await pool.end();
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sdr] createCampaign failed:", message);
    return { success: false, error: "Failed to save campaign. Please try again." };
  }
}

export default function NewCampaignPage(): JSX.Element {
  return (
    <main>
      <h1>New campaign</h1>
      <p>Define your Ideal Customer Profile to target professional services firms in your Apollo prospect fetch.</p>
      <IcpForm onSubmit={createCampaign} />
    </main>
  );
}
