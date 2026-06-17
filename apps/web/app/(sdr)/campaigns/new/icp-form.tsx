"use client";

import { useState, type JSX, type KeyboardEvent } from "react";
import type { IcpConfig } from "@/lib/sdr/icp-validator";
import { SUPPORTED_INDUSTRIES, JOB_TITLE_SUGGESTIONS } from "@/lib/sdr/icp-validator";

export interface SubmitResult {
  success: boolean;
  error?: string;
  errors?: Record<string, string>;
}

export interface IcpFormProps {
  readonly onSubmit: (name: string, icp: IcpConfig) => Promise<SubmitResult>;
}

const INDUSTRY_LABELS: Record<string, string> = {
  legal: "Legal",
  accounting: "Accounting",
  it_consulting: "IT Consulting",
  financial_services: "Financial Services",
  management_consulting: "Management Consulting",
  hr_consulting: "HR Consulting",
  marketing_agency: "Marketing Agency",
  real_estate: "Real Estate",
};

export function IcpForm({ onSubmit }: IcpFormProps): JSX.Element {
  const [campaignName, setCampaignName] = useState("");
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([
    "legal",
    "accounting",
    "it_consulting",
  ]);
  const [sizeMin, setSizeMin] = useState(2);
  const [sizeMax, setSizeMax] = useState(15);
  const [jobTitles, setJobTitles] = useState<string[]>(["Founder", "Managing Partner"]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [jobTitleInput, setJobTitleInput] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  function toggleIndustry(value: string): void {
    setSelectedIndustries((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  function addJobTitle(title: string): void {
    const trimmed = title.trim();
    if (trimmed && !jobTitles.map((t) => t.toLowerCase()).includes(trimmed.toLowerCase())) {
      setJobTitles((prev) => [...prev, trimmed]);
    }
    setJobTitleInput("");
  }

  function removeJobTitle(title: string): void {
    setJobTitles((prev) => prev.filter((t) => t !== title));
  }

  function handleJobTitleKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addJobTitle(jobTitleInput);
    }
  }

  function addKeyword(keyword: string): void {
    const trimmed = keyword.trim();
    if (trimmed && !excludeKeywords.map((k) => k.toLowerCase()).includes(trimmed.toLowerCase())) {
      setExcludeKeywords((prev) => [...prev, trimmed]);
    }
    setKeywordInput("");
  }

  function removeKeyword(keyword: string): void {
    setExcludeKeywords((prev) => prev.filter((k) => k !== keyword));
  }

  function handleKeywordKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(keywordInput);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    const icp: IcpConfig = {
      industries: selectedIndustries,
      companySizeMin: sizeMin,
      companySizeMax: sizeMax,
      geographies: ["US"],
      jobTitles,
      excludeKeywords,
    };

    try {
      const result = await onSubmit(campaignName, icp);
      if (result.success) {
        setSuccess(true);
      } else {
        if (result.errors && Object.keys(result.errors).length > 0) {
          setFieldErrors(result.errors);
        }
        if (result.error) {
          setSubmitError(result.error);
        }
      }
    } catch (err) {
      setSubmitError(`Unexpected error: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="card">
        <h2>Campaign created</h2>
        <p>Your ICP configuration has been saved. The Apollo enrichment worker will use these filters when fetching prospects.</p>
        <a href="/campaigns" className="btn">View campaigns</a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {submitError && (
        <p role="alert" style={{ color: "var(--color-error, #b91c1c)", marginBottom: "1rem" }}>
          {submitError}
        </p>
      )}

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Campaign details</h2>
        <label htmlFor="campaign-name">
          Campaign name
          {fieldErrors["name"] && (
            <span role="alert" className="muted" style={{ color: "var(--color-error, #b91c1c)", marginLeft: "0.5rem" }}>
              {fieldErrors["name"]}
            </span>
          )}
        </label>
        <input
          id="campaign-name"
          type="text"
          value={campaignName}
          onChange={(e) => setCampaignName(e.target.value)}
          placeholder="e.g. Q3 Legal Firms Outreach"
          maxLength={120}
          required
          aria-invalid={!!fieldErrors["name"]}
          style={{ width: "100%" }}
        />
      </section>

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Target industries</h2>
        <p className="muted">Select the professional services verticals to target.</p>
        {fieldErrors["industries"] && (
          <p role="alert" style={{ color: "var(--color-error, #b91c1c)" }}>{fieldErrors["industries"]}</p>
        )}
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {SUPPORTED_INDUSTRIES.map((ind) => (
            <li key={ind}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selectedIndustries.includes(ind)}
                  onChange={() => toggleIndustry(ind)}
                />
                {INDUSTRY_LABELS[ind] ?? ind}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Company size</h2>
        <p className="muted">Target companies with employee count in this range.</p>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div>
            <label htmlFor="size-min">Min employees</label>
            {fieldErrors["companySizeMin"] && (
              <span role="alert" className="muted" style={{ color: "var(--color-error, #b91c1c)", marginLeft: "0.5rem" }}>
                {fieldErrors["companySizeMin"]}
              </span>
            )}
            <input
              id="size-min"
              type="number"
              min={1}
              max={10000}
              value={sizeMin}
              onChange={(e) => setSizeMin(Number(e.target.value))}
              aria-invalid={!!fieldErrors["companySizeMin"]}
              style={{ width: "100px" }}
            />
          </div>
          <span aria-hidden="true">–</span>
          <div>
            <label htmlFor="size-max">Max employees</label>
            {fieldErrors["companySizeMax"] && (
              <span role="alert" className="muted" style={{ color: "var(--color-error, #b91c1c)", marginLeft: "0.5rem" }}>
                {fieldErrors["companySizeMax"]}
              </span>
            )}
            <input
              id="size-max"
              type="number"
              min={1}
              max={10000}
              value={sizeMax}
              onChange={(e) => setSizeMax(Number(e.target.value))}
              aria-invalid={!!fieldErrors["companySizeMax"]}
              style={{ width: "100px" }}
            />
          </div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Geography</h2>
        <p className="muted">MVP targets US-based companies only.</p>
        <input type="text" value="United States (US)" disabled style={{ background: "var(--color-muted-bg, #f3f4f6)", cursor: "not-allowed" }} />
      </section>

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Target job titles</h2>
        <p className="muted">Add the decision-maker titles you want to reach. Press Enter or comma to add.</p>
        {fieldErrors["jobTitles"] && (
          <p role="alert" style={{ color: "var(--color-error, #b91c1c)" }}>{fieldErrors["jobTitles"]}</p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            type="text"
            value={jobTitleInput}
            onChange={(e) => setJobTitleInput(e.target.value)}
            onKeyDown={handleJobTitleKey}
            placeholder="Type a title and press Enter"
            aria-label="Add job title"
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => addJobTitle(jobTitleInput)} className="btn secondary">
            Add
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
          {jobTitles.map((title) => (
            <span key={title} className="card" style={{ padding: "0.2rem 0.6rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              {title}
              <button
                type="button"
                onClick={() => removeJobTitle(title)}
                aria-label={`Remove ${title}`}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "1rem", lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <p className="muted" style={{ fontSize: "0.85rem" }}>Suggestions:</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {JOB_TITLE_SUGGESTIONS.filter((s) => !jobTitles.map((t) => t.toLowerCase()).includes(s.toLowerCase())).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => addJobTitle(suggestion)}
              className="btn secondary"
              style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}
            >
              + {suggestion}
            </button>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <h2>Exclude keywords</h2>
        <p className="muted">Companies matching these keywords will be skipped. Press Enter or comma to add.</p>
        {fieldErrors["excludeKeywords"] && (
          <p role="alert" style={{ color: "var(--color-error, #b91c1c)" }}>{fieldErrors["excludeKeywords"]}</p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            type="text"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={handleKeywordKey}
            placeholder="e.g. enterprise, healthcare"
            aria-label="Add exclude keyword"
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => addKeyword(keywordInput)} className="btn secondary">
            Add
          </button>
        </div>
        {excludeKeywords.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {excludeKeywords.map((keyword) => (
              <span key={keyword} className="card" style={{ padding: "0.2rem 0.6rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                {keyword}
                <button
                  type="button"
                  onClick={() => removeKeyword(keyword)}
                  aria-label={`Remove ${keyword}`}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "1rem", lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {excludeKeywords.length === 0 && (
          <p className="muted" style={{ fontSize: "0.85rem" }}>No keywords added — all matching companies will be included.</p>
        )}
      </section>

      <button type="submit" className="btn" disabled={submitting}>
        {submitting ? "Saving…" : "Create campaign"}
      </button>
    </form>
  );
}
