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

  const email = traveller.email || "";
  const name = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() || "Primary Applicant";

  if (signed) {
    return (
      <div className="agreement-card is-signed">
        <span className="agreement-signed-check">&#10003;</span>
        <div>
          <strong>{name} — agreement signed</strong>
          <small>
            Verified digitally via OTP
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

      // Fire-and-forget — send agreement copy to customer email
      const c = applicationData.customer || {};
      const d = applicationData.deal || {};
      const byCountry = d.agreementHtmlByCountry || {};
      const allHtml = d.agreementHtml || Object.values(byCountry).join("") || "";
      sendAgreementEmail({
        email,
        customerName: `${c.firstName || ""} ${c.lastName || ""}`.trim() || name,
        applicationId: applicationData.applicationId || "",
        signedByName: name,
        signedAt: traveller.agreementSignedAt,
        country: Object.keys(byCountry).join(", ") || d.destination || "",
        agreementHtml: allHtml,
      });
    } catch (err) {
      setError(err.message || "OTP verification failed. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="agreement-card">
      <div className="agreement-card-head">
        <div>
          <strong>{name}</strong>
          <small>OTP will be sent to <em>{email || "— no email on file —"}</em></small>
        </div>
      </div>

      {error ? <div className="notice red agreement-card-error">{error}</div> : null}

      {!sent ? (
        <button
          className="btn primary"
          type="button"
          onClick={handleSend}
          disabled={sending || !email}
        >
          {sending ? "Sending OTP…" : "Send OTP to email"}
        </button>
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
