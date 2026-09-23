import React, { useState } from "react";
import { sendAgreementOtp, verifyAgreementOtp, saveDealData, sendAgreementEmail } from "../../api/deal.js";
import { applicationData } from "../../store/runtime.js";
import { toast, requestRender } from "../../lib/ui.js";

export default function AgreementCard({ traveller, onSigned }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [signed, setSigned] = useState(!!traveller.agreementSigned);
  const [signedAt, setSignedAt] = useState(traveller.agreementSignedAt || "");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [hasPortalAccess, setHasPortalAccess] = useState(traveller.portalAccess !== false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const email = traveller.email || "";
  const name = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() || "Primary Applicant";

  function buildAgreementEmailArgs(overrides = {}) {
    const c = applicationData.customer || {};
    const d = applicationData.deal || {};
    const byCountry = d.agreementHtmlByCountry || {};
    const countries = Object.keys(byCountry).join(", ") || d.destination || "";
    const isUSA = /united states|^usa$/i.test(countries);
    return {
      email,
      customerName: `${c.firstName || ""} ${c.lastName || ""}`.trim() || name,
      applicationId: applicationData.applicationId || "",
      signedByName: name,
      signedAt: new Date().toISOString(),
      country: countries,
      crmId: traveller.crmId || "",
      crmDealId: d.crmDealId || "",
      hasUSA: isUSA,
      hasDate: !!d.usaDateBooking,
      hasPremium: !!d.premiumVisaInterview,
      ...overrides,
    };
  }

  function handlePortalToggle(e) {
    const val = e.target.checked;
    setHasPortalAccess(val);
    traveller.portalAccess = val;
  }

  if (signed) {
    return (
      <div className="agreement-card is-signed">
        <span className="agreement-signed-check">&#10003;</span>
        <div>
          <strong>{name} — agreement signed</strong>
          <small>
            {hasPortalAccess
              ? "Verified digitally via OTP"
              : "Agreement emailed directly"}
            {signedAt ? ` · ${new Date(signedAt).toLocaleString("en-IN")}` : ""}
          </small>
        </div>
      </div>
    );
  }

  async function handleResync() {
    setSyncing(true);
    setSyncError("");
    try {
      await saveDealData({ syncOnly: true });
      requestRender();
    } catch (err) {
      setSyncError(err.message || "Sync failed. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  if (!traveller.crmId) {
    return (
      <div className="agreement-card">
        <div className="notice amber" style={{ marginBottom: 12 }}>
          <strong>CRM sync needed</strong>
          <span>Traveller ID not yet linked. Click the button below to sync with CRM — this usually takes a few seconds.</span>
        </div>
        {syncError ? <div className="notice red" style={{ marginBottom: 12 }}>{syncError}</div> : null}
        <button className="btn secondary" type="button" onClick={handleResync} disabled={syncing}>
          {syncing ? "Syncing with CRM…" : "Re-sync now"}
        </button>
      </div>
    );
  }

  // Portal access toggle — shown in both states
  const portalToggle = (
    <label className="agreement-portal-toggle" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: "0.85em", color: "var(--text-muted, #666)", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={hasPortalAccess}
        onChange={handlePortalToggle}
        style={{ cursor: "pointer" }}
      />
      Traveller has portal access
    </label>
  );

  // ── No portal access: send agreement email directly ──────────────────────
  if (!hasPortalAccess) {
    async function handleSendAgreementEmail() {
      if (!email) {
        setError("No email address on file for this traveller.");
        return;
      }
      setError("");
      setEmailSending(true);
      try {
        await sendAgreementEmail(buildAgreementEmailArgs());
        setEmailSent(true);
        traveller.agreementSigned = true;
        traveller.agreementSignedAt = new Date().toISOString();
        setSigned(true);
        setSignedAt(traveller.agreementSignedAt);
        toast(`Agreement emailed to ${email}`);
        if (onSigned) onSigned();
      } catch (err) {
        setError(err.message || "Failed to send agreement email. Please try again.");
      } finally {
        setEmailSending(false);
      }
    }

    return (
      <div className="agreement-card">
        {portalToggle}
        <div className="agreement-card-head">
          <div>
            <strong>{name}</strong>
            <small>Agreement will be emailed as PDF to <em>{email || "— no email on file —"}</em></small>
          </div>
        </div>
        {error ? <div className="notice red agreement-card-error">{error}</div> : null}
        <button
          className="btn primary"
          type="button"
          onClick={handleSendAgreementEmail}
          disabled={emailSending || !email}
        >
          {emailSending ? "Sending Agreement…" : "Send Agreement by Email"}
        </button>
      </div>
    );
  }

  // ── Portal access: OTP signing flow ─────────────────────────────────────
  async function handleSend() {
    setError("");
    setSending(true);
    try {
      await sendAgreementOtp(traveller.crmId, email);
      setSent(true);
      setOtp("");
      toast(`OTP sent to ${email}`);
    } catch (err) {
      setError(err.message || "Failed to send OTP. Please try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    if (otp.length !== 6) {
      setError("Enter the 6-digit OTP sent to your email.");
      return;
    }
    setError("");
    setVerifying(true);
    try {
      const result = await verifyAgreementOtp(traveller.crmId, email, otp);
      let parsedAt = "";
      try { parsedAt = JSON.parse(result.CRM_Response || "{}").signedAt || ""; } catch (e) {}
      traveller.agreementSigned = true;
      traveller.agreementSignedAt = parsedAt || new Date().toISOString();
      setSigned(true);
      setSignedAt(traveller.agreementSignedAt);
      toast(`Agreement signed by ${name} ✓`);
      if (onSigned) onSigned();
      // Agreement email is NOT sent here for portal users —
      // use "Send Agreement with OTP" button before signing if a PDF copy is needed.
    } catch (err) {
      setError(err.message || "OTP verification failed. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleSendWithAgreement() {
    setError("");
    setSending(true);
    try {
      await sendAgreementOtp(traveller.crmId, email);
      sendAgreementEmail(buildAgreementEmailArgs()); // fire-and-forget agreement copy
      setSent(true);
      setOtp("");
      toast(`OTP + agreement copy sent to ${email}`);
    } catch (err) {
      setError(err.message || "Failed to send OTP. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="agreement-card">
      {portalToggle}
      <div className="agreement-card-head">
        <div>
          <strong>{name}</strong>
          <small>OTP will be sent to <em>{email || "— no email on file —"}</em></small>
        </div>
      </div>

      {error ? <div className="notice red agreement-card-error">{error}</div> : null}

      {!sent ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn primary"
            type="button"
            onClick={handleSend}
            disabled={sending || !email}
          >
            {sending ? "Sending OTP…" : "Send OTP to email"}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={handleSendWithAgreement}
            disabled={sending || !email}
            title="Sends OTP + a copy of the agreement PDF to the traveller's email"
          >
            {sending ? "Sending…" : "Send OTP with Agreement"}
          </button>
        </div>
      ) : (
        <div className="agreement-otp-entry">
          <label className="field">
            <span>Enter the 6-digit OTP</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoComplete="one-time-code"
              className="otp-input"
            />
          </label>
          <div className="agreement-otp-actions">
            <button
              className="btn primary"
              type="button"
              onClick={handleVerify}
              disabled={verifying || otp.length !== 6}
            >
              {verifying ? "Verifying…" : "Verify & Sign"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={handleSend}
              disabled={sending}
            >
              {sending ? "Sending…" : "Resend OTP"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
