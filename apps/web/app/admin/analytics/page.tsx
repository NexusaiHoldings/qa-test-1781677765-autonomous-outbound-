/**
 * /admin/analytics — analytics dashboard (ADMIN, substrate-lego-wiring-001 Phase 4).
 * Mounts @nexus/analytics-and-telemetry AnalyticsDashboard. Data comes from the
 * client AnalyticsBeacon (page_view) + any events the app/agent records.
 */
import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AnalyticsDashboard } from "@nexus/analytics-and-telemetry/ui/AnalyticsDashboard";
import { getAdminUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AnalyticsPage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/login");

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Analytics</h1>
        <Link href="/admin" className="text-sm text-blue-600 underline">← Admin</Link>
      </div>
      <AnalyticsDashboard />
    </main>
  );
}
