/** GET /api/admin/sections — list registered admin nav sections. */
import { handleListSections } from "@nexus/admin-console";
import { requireAdmin, adminCtx, tok, translate } from "@/lib/admin-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const g = await requireAdmin();
  if (!g.admin) return g.response;
  const result = await handleListSections({
    adminTokenHeader: tok(),
    adminToken: tok(),
    ctx: adminCtx(),
  });
  return translate(result);
}
