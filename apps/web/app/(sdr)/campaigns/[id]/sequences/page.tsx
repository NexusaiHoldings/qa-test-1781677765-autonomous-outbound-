import type { JSX } from "react";
import Link from "next/link";
import { getSequencesForCampaign } from "@/lib/sdr/sequence-builder";

interface PageProps {
  params: {
    id: string;
  };
}

export default async function CampaignSequencesPage({
  params,
}: PageProps): Promise<JSX.Element> {
  let sequences = await getSequencesForCampaign(params.id).catch(() => []);

  return (
    <main>
      <h1>Email Sequences</h1>
      <p>
        GPT-powered 3-touch cold email sequences for campaign{" "}
        <strong>{params.id}</strong>. Each sequence is personalized with
        real-time prospect signals (funding rounds, new hires, product launches)
        to avoid generic openers.
      </p>

      <div className="toolbar">
        <Link href={`/campaigns/${params.id}`} className="btn secondary">
          ← Campaign
        </Link>
        <span className="muted">{sequences.length} sequence{sequences.length !== 1 ? "s" : ""}</span>
      </div>

      {sequences.length === 0 ? (
        <div className="empty">
          <p>No email sequences yet.</p>
          <p>
            Use the API or agent to generate a personalized 3-touch sequence
            for each prospect — each touch references a specific signal so
            replies beat generic mail-merge benchmarks.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Role</th>
              <th>Company</th>
              <th>Signal</th>
              <th>Status</th>
              <th>Generated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sequences.map((seq) => (
              <tr key={seq.id}>
                <td>
                  {seq.prospectFirstName} {seq.prospectLastName}
                </td>
                <td>
                  <span className="muted">{seq.prospectRole}</span>
                </td>
                <td>{seq.prospectCompany}</td>
                <td>
                  <span className="muted">
                    {seq.emails[0]?.signal
                      ? seq.emails[0].signal.length > 60
                        ? seq.emails[0].signal.slice(0, 60) + "…"
                        : seq.emails[0].signal
                      : "—"}
                  </span>
                </td>
                <td>
                  <span className="muted">{seq.status}</span>
                </td>
                <td>
                  <span className="muted">
                    {new Date(seq.generatedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </td>
                <td>
                  <Link
                    href={`/campaigns/${params.id}/sequences/${seq.id}/preview`}
                    className="btn secondary"
                  >
                    Preview
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
