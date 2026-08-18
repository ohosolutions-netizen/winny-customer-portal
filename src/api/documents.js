// ─────────────────────────────────────────────────────────────────────────
// Document checklist — copied VERBATIM from the original widget. This is an
// innerHTML island (renderDocuments writes to qs("#stepDocuments"), inline
// loadDocumentChecklist / viewDocumentFile / handleDocumentFileSelected handlers).
// EXACT endpoints preserved: the Portal_CRM_Request → Deluge bridge for
// "Get Document Checklist" / "Upload Document" / "Get Document View URL", the
// 2-step create + CREATOR.FILE.uploadFile, and the CREATOR.UTIL.setImageData
// preview path with the Deluge base64 fallback.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { qs } from "../lib/dom.js";
import { escapeHtml } from "../lib/utils.js";
import { toast } from "../lib/ui.js";
import { documentStatusMeta, isMandatoryDocument, isStrengthDocument, isDocumentReady } from "../core/derive.js";
import { submitPortalCrmRequest, pollCreatorRecord } from "./portal.js";

    async function loadDocumentChecklist(force = false) {
      const dealId = applicationData.deal.crmDealId;
      if (!dealId) {
        state.documents.items = [];
        state.documents.loaded = true;
        renderDocuments();
        return;
      }
      console.log("[Winny] Loading document checklist for CRM Deal ID:", dealId);
      if (state.documents.loading) return;
      if (state.documents.loaded && state.documents.loadedForDealId === dealId && !force) { renderDocuments(); return; }

      state.documents.loading = true;
      renderDocuments();
      try {
        state.documents.items = await findDocumentsForDeal(dealId);
        state.documents.loadedForDealId = dealId;
        state.documents.loaded = true;
      } catch (error) {
        console.warn("[Winny] Document checklist load failed:", error);
        toast("Could not load your document checklist. Please try refreshing.");
      } finally {
        state.documents.loading = false;
        renderDocuments();
      }
    }

    function scheduleDocumentChecklistRefresh(attempt = 1) {
      const delays = [3500, 8000, 15000];
      if (attempt > delays.length) return;
      window.setTimeout(async () => {
        if (applicationData.currentStep !== 3) return;
        if (!applicationData.stepStatus.questionnaireCompleted) return;
        if (state.documents.items && state.documents.items.length) return;
        await loadDocumentChecklist(true);
        if (!state.documents.items || !state.documents.items.length) {
          scheduleDocumentChecklistRefresh(attempt + 1);
        }
      }, delays[attempt - 1]);
    }

    // Direct CRM REST (invokeUrl / CREATOR.API) is NOT available in this widget
    // context — confirmed via transport diagnostics (CREATOR.API.invokeUrl:
    // false, only CREATOR.DATA v2 is present). So checklist reads go through
    // the same Portal_CRM_Request → Deluge bridge already used for every write
    // in this widget. Deluge looks up Document records for CRM_Deal_ID and
    // writes a JSON array back into a Portal_CRM_Request field — requires a
    // NEW Multi-line Text field "Document_Checklist_JSON" on that form (not
    // yet added — see chat) and a new Deluge case for
    // Request_Type == "Get Document Checklist" that:
    //   1. searches Document where Deal = input.CRM_Deal_ID
    //   2. builds JSON: [{"id","traveller_id","traveller_name","requirement","document_requirement","status","review_comments"}, ...]
    //   3. writes that JSON string to Document_Checklist_JSON, sets Status = "Success"
    async function findDocumentsForDeal(dealId) {
      try {
        const creatorRecordId = await submitPortalCrmRequest("Get Document Checklist");
        if (!creatorRecordId) { console.warn("[Winny] Get Document Checklist — no Creator record ID returned."); return []; }

        const result = await pollCreatorRecord(creatorRecordId, 15, 1500);
        console.log("[Winny] Get Document Checklist poll result:", JSON.stringify(result));
        if (result.Status === "Failed") {
          console.warn("[Winny] Get Document Checklist Deluge error:", result.Error_Message);
          return [];
        }

        const raw = result.Document_Checklist_JSON || result.CRM_Response || "";
        if (!raw) { console.warn("[Winny] Get Document Checklist — response field was empty."); return []; }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          // Recover from a missing outer [ ] wrapper — some Zoho field renders/copies
          // can drop the enclosing brackets even when the stored value is correct.
          const trimmed = raw.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              parsed = JSON.parse(`[${trimmed}]`);
              console.warn("[Winny] Document checklist JSON was missing outer [ ] — recovered by wrapping.");
            } catch (e2) {
              console.error("[Winny] Could not parse document checklist JSON even after bracket recovery:", e2.message, raw);
              return [];
            }
          } else {
            console.error("[Winny] Could not parse document checklist JSON:", e.message, raw);
            return [];
          }
        }

        if (!Array.isArray(parsed)) { console.warn("[Winny] Document checklist JSON was not an array:", parsed); return []; }

        return parsed.map((d) => ({
          id:              d.id || d.ID || "",
          requirement:     d.requirement || d.Name || "Document",
          documentRequirement: d.document_requirement ?? d.documentRequirement ?? d.Document_Requirement ?? d.mandatory ?? d.is_mandatory ?? "",
          status:          d.status || d.Document_Status || "Not Collected",
          reviewComments:  d.review_comments || d.Review_Comments || "",
          travellerId:     d.traveller_id || d.travellerId || "",
          travellerName:   d.traveller_name || d.travellerName || "Unassigned",
          sourceRequestId: d.source_request_id || d.Source_Request_ID || "",
          hasFile:         Boolean(d.has_file || d.hasFile || d.Has_File || d.source_request_id || d.Source_Request_ID || ["Collected", "Reviewed", "Accepted"].includes(d.status || d.Document_Status))
        }));
      } catch (e) {
        console.error("[Winny] Document checklist bridge request failed:", e.message || e);
        return [];
      }
    }

    function renderDocuments() {
      const target = qs("#stepDocuments");
      if (!target) return;

      if (!applicationData.deal.crmDealId) {
        target.innerHTML = `
          <section class="wizard-panel"><div class="panel-body">
            <div class="notice amber"><strong>&#x26A0;&#xFE0F; Not available yet</strong>
              <span>Your document checklist appears once your application is saved and your case questionnaire is submitted.</span></div>
          </div></section>`;
        return;
      }

      if (state.documents.loading && !state.documents.items.length) {
        target.innerHTML = `
          <section class="wizard-panel"><div class="panel-body" style="text-align:center;padding:40px;color:var(--muted)">
            <div class="spin" style="margin:0 auto 14px"></div>Loading your document checklist…
          </div></section>`;
        return;
      }

      const items = state.documents.items;
      if (state.documents.loaded && !items.length) {
        target.innerHTML = `
          <section class="wizard-panel"><div class="panel-body">
            <div class="notice blue"><strong>&#x1F4CB; Checklist not generated yet</strong>
              <span>Your document checklist is generated from your questionnaire answers and usually appears shortly after submission. Check back soon, or click refresh below.</span></div>
            <button class="btn" type="button" onclick="loadDocumentChecklist(true)">&#x21BA; Refresh checklist</button>
          </div></section>`;
        return;
      }

      const mandatoryItems = items.filter(isMandatoryDocument);
      const strengthItems = items.filter(isStrengthDocument);
      const optionalItems = items.filter(d => !isMandatoryDocument(d) && !isStrengthDocument(d));
      const mandatoryReadyCount = mandatoryItems.filter(isDocumentReady).length;
      const pct = mandatoryItems.length ? Math.round((mandatoryReadyCount / mandatoryItems.length) * 100) : 100;

      const byTraveller = {};
      items.forEach((d) => {
        const key = d.travellerId || "unassigned";
        if (!byTraveller[key]) byTraveller[key] = { name: d.travellerName, docs: [] };
        byTraveller[key].docs.push(d);
      });

      const travellerBlocks = Object.values(byTraveller).map((group) => `
        <div class="person-block">
          <div class="person-block-hd">
            <div class="pb-av pb-av-pa">${escapeHtml((group.name||"T")[0]||"T")}</div>
            <div class="pb-info"><div class="pb-name">${escapeHtml(group.name)}</div>
            <div class="pb-role">${[
              `${group.docs.filter(isMandatoryDocument).length} mandatory`,
              group.docs.filter(isStrengthDocument).length ? `${group.docs.filter(isStrengthDocument).length} strength` : "",
              group.docs.filter(d => !isMandatoryDocument(d) && !isStrengthDocument(d)).length ? `${group.docs.filter(d => !isMandatoryDocument(d) && !isStrengthDocument(d)).length} optional` : ""
            ].filter(Boolean).join(" · ")}</div></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${group.docs.map((d) => {
              const meta = documentStatusMeta(d.status);
              const mandatory = isMandatoryDocument(d);
              const strength = isStrengthDocument(d);
              const requirementLabel = mandatory ? "Mandatory" : (strength ? "Strength" : "Optional");
              const requirementBackground = mandatory ? "#fff0f3" : (strength ? "#e8f8f2" : "#f0f2f6");
              const requirementColor = mandatory ? "#a1233b" : (strength ? "#077753" : "#5b6072");
              const uploading = state.documents.uploadingId === d.id;
              const viewing = state.documents.viewingId === d.id;
              const isLocked = ["Not Required", "Reviewed", "Accepted"].includes(d.status);
              const canUpload = !isLocked;
              const hasFile = Boolean(d.sourceRequestId || d.hasFile);
              const inputId = `doc-file-${d.id}`;
              return `
              <div style="border:1.5px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
                  <div style="flex:1;font-size:13.5px;font-weight:700;color:var(--ink);line-height:1.4">
                    ${escapeHtml(d.requirement)}
                    <span style="display:inline-flex;margin-left:7px;padding:3px 8px;border-radius:99px;background:${requirementBackground};color:${requirementColor};font-size:10px;font-weight:800;vertical-align:middle">${requirementLabel}</span>
                  </div>
                  <span style="flex-shrink:0;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;background:${meta.bg};color:${meta.fg};font-size:11px;font-weight:800;white-space:nowrap">
                    <span style="width:7px;height:7px;border-radius:50%;background:${meta.dot};display:inline-block"></span>${escapeHtml(d.status)}
                  </span>
                </div>
                ${strength ? `<div style="margin-top:8px;font-size:11.5px;color:#077753">Recommended — providing this document can strengthen your application.</div>` : ""}
                ${d.reviewComments ? `<div style="margin-top:8px;padding:8px 10px;background:#fafbff;border:1px solid var(--line);border-radius:8px;font-size:12px;color:var(--muted)"><strong style="color:var(--ink)">Note from case officer:</strong> ${escapeHtml(d.reviewComments)}</div>` : ""}
                ${isLocked && hasFile ? `<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">&#x1F512; ${d.status === "Reviewed" ? "Approved — this document can no longer be changed." : "Not required for this case."}</div>` : ""}
                <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  ${hasFile ? `
                  <button class="btn ghost" type="button" style="font-size:12.5px;padding:7px 13px" ${viewing ? "disabled" : ""} onclick="viewDocumentFile('${d.id}')">
                    ${viewing ? "Opening…" : "&#x1F441;&#xFE0F; View file"}
                  </button>` : ""}
                  ${canUpload ? `
                  <label class="btn ghost" style="cursor:pointer;font-size:12.5px;padding:7px 13px" for="${inputId}">
                    ${uploading ? "Uploading…" : (hasFile ? "&#x21BA; Replace file" : "&#x1F4CE; Upload file")}
                  </label>
                  <input type="file" id="${inputId}" style="display:none" ${uploading ? "disabled" : ""}
                    onchange="handleDocumentFileSelected('${d.id}', this)">
                  ${uploading ? '<span class="spin" style="width:16px;height:16px;margin:0"></span>' : ""}` : ""}
                </div>
              </div>`;
            }).join("")}
          </div>
        </div>`).join("");

      target.innerHTML = `
        <section class="wizard-panel">
          <div class="panel-head">
            <div><h3>Document Checklist</h3><p>Upload the documents required for your case. This list is generated from your questionnaire answers.</p></div>
            <button class="btn ghost" type="button" onclick="loadDocumentChecklist(true)" title="Refresh">&#x21BA; Refresh</button>
          </div>
          <div class="panel-body">
            <div class="notice blue" style="margin-bottom:16px"><strong>&#x1F4CC; Mandatory documents must be uploaded</strong>
              <span>This checklist is complete only after every mandatory document is ready. Strength documents are recommended but do not block completion.</span></div>
            <div class="q-prog-card" style="margin-bottom:18px">
              <div class="q-prog-top"><div class="q-prog-label">${mandatoryReadyCount} of ${mandatoryItems.length} mandatory documents ready${strengthItems.length ? ` · ${strengthItems.length} strength` : ""}${optionalItems.length ? ` · ${optionalItems.length} optional` : ""}</div><div class="q-prog-pct">${pct}%</div></div>
              <div class="q-prog-bg"><div class="q-prog-fill" style="width:${pct}%"></div></div>
            </div>
            ${travellerBlocks}
          </div>
        </section>`;
    }

    async function handleDocumentFileSelected(documentId, inputEl) {
      const file = inputEl.files && inputEl.files[0];
      if (!file) return;
      await uploadDocumentFile(documentId, file);
      inputEl.value = "";
    }

    // Uploads via the same Portal_CRM_Request → Deluge bridge used elsewhere in
    // this widget. This is a 2-step sequence, NOT a single addRecords call —
    // Zoho's Add Records API cannot set File Upload field values at all (only
    // the dedicated Upload File API can). So:
    //   1. Create the request record (no file yet) — fires Deluge's "On Add"
    //      trigger, which sees Document_File empty and no-ops, leaving
    //      Status = "Pending".
    //   2. Upload the file to that record's Document_File field via the
    //      separate File API (ZOHO.CREATOR.FILE.uploadFile). CONFIRMED via
    //      testing that this call itself fires Deluge's "On Edit" trigger —
    //      no separate explicit re-trigger step is needed (an earlier version
    //      added one via updateRecordById, which turned out to double-fire
    //      Deluge and attach the file to CRM twice — removed).
    // REQUIRES: two fields on Portal_CRM_Request (Document_File — File
    // Upload; Target_Record_ID — single line text), AND the form's workflow
    // trigger configured for BOTH "On Add" and "On Edit" (not just On Add —
    // every other request type here only ever needs On Add, so this may not
    // be enabled yet). Deluge's "Upload Document" branch must check whether
    // Document_File is actually populated before doing anything.
    async function uploadDocumentFile(documentId, file) {
      state.documents.uploadingId = documentId;
      renderDocuments();
      try {
        if (!window.ZOHO?.CREATOR?.DATA?.addRecords) {
          throw new Error("Zoho transport unavailable — cannot upload right now.");
        }
        if (!window.ZOHO?.CREATOR?.FILE?.uploadFile) {
          throw new Error("File upload API unavailable in this context — cannot upload right now.");
        }

        // ── Step 1: create the request record (no file field) ──────────────
        const recordData = {
          Request_Type:       "Upload Document",
          Status:              "Pending",
          Application_Number:  applicationData.applicationId,
          Customer_Email:       applicationData.customer.email,
          CRM_Deal_ID:          applicationData.deal.crmDealId || "",
          Target_Record_ID:     documentId,
          Payload:              JSON.stringify({ documentId, fileName: file.name })
        };
        const createRes = await ZOHO.CREATOR.DATA.addRecords({
          app_name:  CONFIG.creator.appLinkName,
          form_name: CONFIG.creator.formLinkNames.portalCrmRequest,
          payload:   { data: recordData }
        });
        if (createRes?.code !== 3000) {
          throw new Error(`Upload record creation failed (${createRes?.code}): ${createRes?.message || JSON.stringify(createRes)}`);
        }
        const creatorRecordId = createRes?.data?.ID || createRes?.data?.id;
        console.log("[Winny] Upload Document — step 1 (create) OK, record:", creatorRecordId);

        // ── Step 2: upload the file to that record's Document_File field ───
        const uploadRes = await ZOHO.CREATOR.FILE.uploadFile({
          app_name:    CONFIG.creator.appLinkName,
          report_name: CONFIG.creator.reportLinkName,
          id:          creatorRecordId,
          field_name:  "Document_File",
          file:        file
        });
        if (uploadRes?.code !== 3000) {
          throw new Error(`File upload failed (${uploadRes?.code}): ${uploadRes?.message || JSON.stringify(uploadRes)}`);
        }
        console.log("[Winny] Upload Document — step 2 (file attached to Creator record) OK:", JSON.stringify(uploadRes));

        // NOTE: no explicit re-trigger step here — confirmed via testing that
        // the Upload File API call above already fires Deluge's On Edit
        // workflow on its own. An earlier version added an explicit
        // updateRecordById() call to force a re-trigger, which turned out to
        // be redundant and caused the file to be attached to CRM twice.

        // ── Poll for Deluge to actually attach the file to CRM + set status ──
        const result = await pollCreatorRecord(creatorRecordId, 15, 2000);
        if (result.Status === "Failed") throw new Error(result.Error_Message || "Upload processing failed.");
        if (result.Status !== "Success") throw new Error("Upload is still processing — please refresh the checklist in a moment.");

        const item = state.documents.items.find((d) => d.id === documentId);
        if (item) {
          item.status = "Collected";
          item.sourceRequestId = creatorRecordId;
          item.hasFile = true;
        }
        toast(`${file.name} uploaded ✓`);
      } catch (error) {
        console.error("[Winny] Document upload failed:", error);
        toast(`Upload failed: ${error.message || "Please try again."}`);
      } finally {
        state.documents.uploadingId = null;
        renderDocuments();
      }
    }

    // Views the file uploaded for a document. FINAL approach after ruling out
    // every native "just open a URL" option:
    //   - ZOHO.CREATOR.FILE.readFile() corrupts binary content in transit
    //     (confirmed live — garbled bytes after a readable PDF header).
    //   - Creator's REST download API needs an OAuth Bearer token a browser
    //     tab can't attach (confirmed: code 1030 Authorization Failure).
    //   - Creator's public export needs the report PUBLISHED with a
    //     permanent embedded key — anyone with the URL could open ANY file
    //     in it. Not acceptable for passports/bank statements/tax returns.
    //   - CRM's own download_Url (confirmed via live testing) points into
    //     CRM's internal staff UI (/crm/widget_flow/...), authenticated to
    //     the CRM user session, not a portal customer's session.
    // So: Deluge downloads the file server-side (CRM's Download Field
    // Attachments API — already proven reliable throughout this app),
    // explicitly base64-encodes it (zoho.encryption.base64Encode), and hands
    // back plain text the widget decodes into a Blob client-side. This is a
    // deliberate, controlled encoding — not relying on any Zoho SDK's
    // internal binary transport — so it doesn't hit the corruption bug, and
    // it never leaves the existing authenticated Portal_CRM_Request bridge.
    // LIMITATION: Creator text fields cap around 64KB, so this only works up
    // to roughly 45KB raw file size (base64 inflates ~33%). Larger files
    // (e.g. scanned PDF bank statements) will get a clear "too large to
    // preview" message rather than failing silently.
    // The primary preview path below uses Zoho Creator's setImageData helper
    // directly against the uploaded file field, so that 45KB limit now applies
    // only if the code has to fall back to the older Deluge bridge.
    async function viewDocumentFile(documentId) {
      state.documents.viewingId = documentId;
      renderDocuments();
      const previewWindow = window.open("", "_blank");
      if (previewWindow) {
        previewWindow.document.write(`
          <!doctype html><title>Loading preview...</title>
          <div style="font-family:Arial,sans-serif;padding:24px;color:#334155">
            Preparing document preview...
          </div>`);
      }
      try {
        let item = state.documents.items.find((d) => d.id === documentId);
        if (item && !item.sourceRequestId) {
          await loadDocumentChecklist(true);
          item = state.documents.items.find((d) => d.id === documentId);
        }
        if (!item || !item.sourceRequestId) {
          throw new Error("No uploaded file reference found for this document.");
        }

        const dataUrl = await getCreatorFileDataUrl(item.sourceRequestId, "Document_File");
        if (!dataUrl || !dataUrl.startsWith("data:")) {
          throw new Error("Creator did not return a previewable file.");
        }

        await openDataUrlInNewTab(dataUrl, previewWindow);
      } catch (primaryError) {
        console.warn("[Winny] Creator direct file preview failed; falling back to Deluge preview:", primaryError);
        if (previewWindow) previewWindow.close();
        await viewDocumentFileViaDeluge(documentId);
      } finally {
        state.documents.viewingId = null;
        renderDocuments();
      }
    }

    async function getCreatorFileDataUrl(recordId, fieldName) {
      const fileUrl = await getCreatorFileDownloadPath(recordId, fieldName);
      return getCreatorDataUrlFromPath(fileUrl);
    }

    async function getCreatorFileDownloadPath(recordId, fieldName) {
      if (!window.ZOHO?.CREATOR?.DATA?.getRecordById) {
        return `/api/v2.1/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/report/${CONFIG.creator.reportLinkName}/${recordId}/${fieldName}/download`;
      }

      const res = await ZOHO.CREATOR.DATA.getRecordById({
        app_name:    CONFIG.creator.appLinkName,
        report_name: CONFIG.creator.reportLinkName,
        id:          recordId
      });
      if (res?.code !== 3000 || !res?.data) {
        throw new Error(`Could not read uploaded file record (${res?.code || "unknown"}).`);
      }

      const fileValue = res.data[fieldName];
      const firstFile = Array.isArray(fileValue) ? fileValue[0] : fileValue;
      if (!firstFile) {
        throw new Error("Uploaded file path is missing on the source request.");
      }

      return String(firstFile);
    }

    function getCreatorDataUrlFromPath(fileUrl) {
      return new Promise((resolve, reject) => {
        if (!window.ZOHO?.CREATOR?.UTIL?.setImageData) {
          reject(new Error("Creator preview API unavailable in this context."));
          return;
        }

        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        document.body.appendChild(iframe);

        console.log("[Winny] Creator preview file URL:", fileUrl);
        const timer = setTimeout(() => {
          iframe.remove();
          reject(new Error("Creator file preview timed out."));
        }, 30000);

        ZOHO.CREATOR.UTIL.setImageData(iframe, fileUrl, function () {
          clearTimeout(timer);
          const dataUrl = iframe.src || "";
          iframe.remove();
          resolve(dataUrl);
        });
      });
    }

    async function openDataUrlInNewTab(dataUrl, previewWindow) {
      const targetWindow = previewWindow || window.open("", "_blank");
      if (!targetWindow) {
        throw new Error("Preview popup was blocked.");
      }

      const mimeType = dataUrl.slice(5, dataUrl.indexOf(";"));
      targetWindow.document.open();
      targetWindow.document.write(`
        <!doctype html>
        <html>
        <head>
          <title>Document Preview</title>
          <style>
            html,body{margin:0;min-height:100%;font-family:Arial,sans-serif;background:#f8fafc;color:#1f2937}
            .bar{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#fff;border-bottom:1px solid #e5e7eb;font-size:15px;font-weight:800}
            .wrap{min-height:calc(100vh - 57px);padding:24px;display:flex;align-items:center;justify-content:center}
            .image-preview{width:min(1180px,calc(100vw - 48px));max-height:calc(100vh - 105px);object-fit:contain;background:#fff;box-shadow:0 12px 36px rgba(15,23,42,.16)}
            iframe{width:100%;height:calc(100vh - 49px);border:0;background:#fff}
            pre{white-space:pre-wrap;width:min(960px,100%);padding:18px;background:#fff;border:1px solid #e5e7eb;border-radius:8px}
            a{color:#0561f4}
            .download-btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;border-radius:8px;background:#0561f4;color:#fff;text-decoration:none;font-weight:800}
            .unsupported{width:min(560px,calc(100vw - 48px));padding:28px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;box-shadow:0 12px 34px rgba(15,23,42,.08);text-align:center}
            .unsupported h2{margin:0 0 8px;font-size:19px;color:#111827}
            .unsupported p{margin:0 0 18px;color:#64748b;line-height:1.55}
          </style>
        </head>
        <body>
          <div class="bar"><span>Document Preview</span><a id="downloadLink" class="download-btn" download="document">Download</a></div>
          <div id="preview"></div>
        </body>
        </html>`);
      targetWindow.document.close();

      const doc = targetWindow.document;
      const downloadLink = doc.getElementById("downloadLink");
      downloadLink.href = dataUrl;

      const preview = doc.getElementById("preview");
      if (mimeType === "application/pdf") {
        preview.innerHTML = `<iframe title="PDF preview"></iframe>`;
        preview.querySelector("iframe").src = dataUrl;
      } else if (mimeType.startsWith("image/")) {
        preview.className = "wrap";
        const img = doc.createElement("img");
        img.className = "image-preview";
        img.alt = "Document preview";
        img.src = dataUrl;
        preview.appendChild(img);
      } else if (mimeType.startsWith("text/")) {
        preview.className = "wrap";
        const pre = doc.createElement("pre");
        pre.textContent = atob(dataUrl.split(",")[1] || "");
        preview.appendChild(pre);
      } else {
        preview.className = "wrap";
        preview.innerHTML = `
          <div class="unsupported">
            <h2>Preview unavailable for this file type</h2>
            <p>Word and Excel files cannot be rendered directly inside this portal preview. Please download the file to open it in Microsoft Office, Google Docs, or another compatible app.</p>
            <a class="download-btn" download="document">Download file</a>
          </div>`;
        preview.querySelector("a").href = dataUrl;
      }
    }

    async function viewDocumentFileViaDeluge(documentId) {
      state.documents.viewingId = documentId;
      renderDocuments();
      try {
        if (!window.ZOHO?.CREATOR?.DATA?.addRecords) {
          throw new Error("Zoho transport unavailable — cannot fetch file right now.");
        }
        const recordData = {
          Request_Type:      "Get Document View URL",
          Status:             "Pending",
          Application_Number: applicationData.applicationId,
          Customer_Email:     applicationData.customer.email,
          CRM_Deal_ID:        applicationData.deal.crmDealId || "",
          Target_Record_ID:   documentId,
          Payload:            "{}"   // shared Deluge code always does input.Payload.toMap() first — must not be blank
        };
        const createRes = await ZOHO.CREATOR.DATA.addRecords({
          app_name:  CONFIG.creator.appLinkName,
          form_name: CONFIG.creator.formLinkNames.portalCrmRequest,
          payload:   { data: recordData }
        });
        if (createRes?.code !== 3000) {
          throw new Error(`Request creation failed (${createRes?.code}): ${createRes?.message || JSON.stringify(createRes)}`);
        }
        const creatorRecordId = createRes?.data?.ID || createRes?.data?.id;

        const result = await pollCreatorRecord(creatorRecordId, 15, 1500);
        if (result.Status === "Failed") {
          if (result.Error_Message === "FILE_TOO_LARGE") {
            throw new Error("This file is too large to preview here — please ask your case officer for a copy.");
          }
          throw new Error(result.Error_Message || "Could not fetch this file.");
        }
        if (result.Status !== "Success") throw new Error("Still processing — please try again in a moment.");

        const base64Content = result.View_File_Base64;
        const fileName = result.View_File_Name || "document";
        if (!base64Content) throw new Error("No file content was returned — see console for the raw response.");

        const byteChars = atob(base64Content);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const mimeType = guessMimeTypeFromFilename(fileName);
        const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
        const url = URL.createObjectURL(blob);
        console.log("[Winny] View — opening decoded file:", fileName, mimeType);
        window.open(url, "_blank");
      } catch (error) {
        console.error("[Winny] View document failed:", error);
        toast(`Could not open file: ${error.message || "please try again."}`);
      } finally {
        state.documents.viewingId = null;
        renderDocuments();
      }
    }

    function guessMimeTypeFromFilename(name) {
      const ext = (name.split(".").pop() || "").toLowerCase();
      const map = {
        pdf: "application/pdf",
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        txt: "text/plain"
      };
      return map[ext] || "application/octet-stream";
    }

export {
  loadDocumentChecklist, scheduleDocumentChecklistRefresh, findDocumentsForDeal,
  renderDocuments, handleDocumentFileSelected, uploadDocumentFile, viewDocumentFile
};
