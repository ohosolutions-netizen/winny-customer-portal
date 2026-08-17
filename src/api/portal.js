// ─────────────────────────────────────────────────────────────────────────
// Portal + CRM async layer — copied VERBATIM from the original widget.
// EXACT endpoints/forms preserved: Portal_CRM_Request via CREATOR.DATA.addRecords
// / CREATOR.API.addRecord / invokeUrl REST; Deluge poll via getRecordById;
// CRM v8 REST + CRM SDK lookups; hydrate from CRM/Deluge responses.
// Mechanical changes only:
//   • `applicationData = blankApplication()` → replaceApplicationData(...)
//   • renderDashboard()/renderStepper()/renderDeal() → requestRender()
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG, packageCatalog } from "../config/config.js";
import { applicationData, state, blankApplication, replaceApplicationData } from "../store/runtime.js";
import { mergeDeep, safeJsonParse } from "../lib/utils.js";
import { toast, showLoader, hideLoader, requestRender } from "../lib/ui.js";
import {
  hasZohoTransport, hasCreatorRestTransport, canUseCrmSdk, getZohoTransportDiagnostics,
  crmRest, crmGetRecords, getResponseRows, readZohoId, readZohoValue,
  compareCreatedTimeDesc, getCreatorRecordId, getLoggedInEmail
} from "./zoho.js";
import {
  hasApplicationInfo, isFullyPaidStatus, syncCustomerToTraveller,
  getSelectedServiceNames, deriveTravellerRelationship
} from "../core/derive.js";
import { getGoalDefinition } from "../core/catalog.js";
import {
  saveDraft, getDraftIndexKey, draftsToApplicationCards, loadApplicationDraftIndex
} from "../core/drafts.js";

    // ── submit + poll (Portal_CRM_Request bridge) ──
    async function submitPortalCrmRequest(requestType) {
      const isPortalReadRequest =
  requestType === "Get Applications" ||
  requestType === "Get Application Details";
const requestEmail = isPortalReadRequest
  ? (applicationData.crmSync.loggedInEmail || applicationData.customer.email || "")
  : (applicationData.customer.email || applicationData.crmSync.loggedInEmail || "");
      const selectedServiceType =
        getGoalDefinition(applicationData.deal.serviceTypeKey || applicationData.deal.goal)?.crmLabel ||
        applicationData.deal.goal ||
        "";
      const payload = {
        customer: {
          ...applicationData.customer,
          email: requestEmail,
          coordinator: applicationData.customer.coordinator || null
        },
        deal: {
          ...applicationData.deal,
          serviceNames:   getSelectedServiceNames(),
          serviceType:    selectedServiceType,
          Service_Type:   selectedServiceType,
          // Persist family membership separately from traveller CRM fields so
          // application hydration can rebuild the same family cards.
          travellerFamilyGroups: Object.fromEntries(
            applicationData.deal.travellers.map((traveller) => [
              traveller.id,
              traveller.familyId || "family-1"
            ])
          ),
          travellers: applicationData.deal.travellers.map((traveller) => {
            // familyId groups cards in the portal only. Keep the CRM traveller
            // payload identical to the pre-grouping contract.
            const crmTraveller = { ...traveller };
            delete crmTraveller.familyId;
            return {
              ...crmTraveller,
              local_id: traveller.id || "",
              crm_id: traveller.crmId || "",
              CRM_Traveller_ID: traveller.crmId || "",
              Date_of_Birth: traveller.dob || "",
              Email: traveller.email || "",
              Mobile: traveller.mobile || "",
              serviceType: selectedServiceType,
              Service_Type: selectedServiceType,
              relationship: deriveTravellerRelationship(
                traveller,
                applicationData.deal.travellers
              )
            };
          }),
          // Include CRM Product IDs for each selected service
          selectedCrmProductIds: applicationData.deal.selectedServices.map((id) => {
            const pkg = packageCatalog.find((p) => p.id === id);
            return pkg ? (pkg.crmId || pkg.id) : id;
          })
               },
                payment: applicationData.payment,
        questionnaire: applicationData.questionnaire,
        cifRecords: applicationData.cifRecords || {}
      };

      // Exact field names from Portal_CRM_Request form (verified via MCP)
      const recordData = {
        Request_Type:       requestType,
        Status:             "Pending",
        Application_Number: applicationData.applicationId,
        Customer_Email:     requestEmail,
        CRM_Contact_ID:     applicationData.deal.crmContactId || "",
        CRM_Deal_ID:        applicationData.deal.crmDealId    || "",   // ← key: lets Deluge update vs create
        Payload:            JSON.stringify(payload)
      };

      console.log(`[Winny] Submitting ${requestType} | DealID: ${recordData.CRM_Deal_ID || "new"}`);

      // ── Transport 1: CREATOR.DATA.addRecords (SDK v2 — correct for portal) ─
      if (window.ZOHO?.CREATOR?.DATA?.addRecords) {
        console.log("[Winny] Transport 1: CREATOR.DATA.addRecords (SDK v2)");
        try {
          const res = await ZOHO.CREATOR.DATA.addRecords({
            app_name:  CONFIG.creator.appLinkName,
            form_name: CONFIG.creator.formLinkNames.portalCrmRequest,
            payload:   { data: recordData }
          });
          console.log("[Winny] Transport 1 response:", JSON.stringify(res));
          if (res?.code === 3000) {
            return res?.data?.ID || res?.data?.id || null;
          }
          // code 3001 = validation error — log the exact error for debugging
          const errMsg = Array.isArray(res?.error) ? res.error.join(", ") : (res?.message || JSON.stringify(res));
          throw new Error(`Creator validation error (${res?.code}): ${errMsg}`);
        } catch (e) {
          console.error("[Winny] Transport 1 failed:", e.message || e);
          throw e;   // ← propagate so the caller sees the real error
        }
      }

      // ── Transport 2: CREATOR.API.addRecord (SDK v1 — appName/formName camelCase) ─
      // SDK v1 uses appName + formName (NOT appLinkName/formLinkName)
      if (window.ZOHO?.CREATOR?.API?.addRecord) {
        console.log("[Winny] Transport 2: CREATOR.API.addRecord (SDK v1)");
        try {
          const res = await ZOHO.CREATOR.API.addRecord({
            appName:  CONFIG.creator.appLinkName,                        // ← appName in v1
            formName: CONFIG.creator.formLinkNames.portalCrmRequest,     // ← formName in v1
            data:     { data: recordData }
          });
          console.log("[Winny] Transport 2 response:", JSON.stringify(res));
          if (res?.code === 3000) {
            return res?.data?.ID || res?.data?.id || null;
          }
          throw new Error(`addRecord returned code ${res?.code}: ${res?.message || JSON.stringify(res)}`);
        } catch (e) {
          console.warn("[Winny] Transport 2 failed:", e.message || e);
        }
      }

      // ── Transport 3: invokeUrl REST ───────────────────────────────────────
      if (window.ZOHO?.CREATOR?.API?.invokeUrl) {
        console.log("[Winny] Transport 3: CREATOR.API.invokeUrl REST");
        try {
          const res = await ZOHO.CREATOR.API.invokeUrl({
            url:            `https://creator.zoho.in/api/v2/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/form/${CONFIG.creator.formLinkNames.portalCrmRequest}`,
            type:           "POST",
            connectionName: CONFIG.crmConnectionName,
            headers:        { "Content-Type": "application/json" },
            data:           JSON.stringify({ data: recordData })
          });
          console.log("[Winny] Transport 3 response:", JSON.stringify(res));
          return getCreatorRecordId(res);
        } catch (e) {
          console.warn("[Winny] Transport 3 failed:", e.message || e);
          throw e;
        }
      }

      // ── Last resort: local only ───────────────────────────────────────────
      console.warn("[Winny] No transport available — local only.", getZohoTransportDiagnostics());
      saveDraft(false);
      toast("Saved locally. Zoho unavailable — please contact support.");
      return null;
    }

    async function pollCreatorRecord(recordId, maxAttempts = 10, intervalMs = 2000) {
      if (!recordId) return { Status: "Success" };  // local-only fallback

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));

        try {
          let record = null;

          // SDK v2: CREATOR.DATA.getRecordById
          // params: app_name (optional), report_name, id
          // response: { code: 3000, data: { Status: "...", CRM_Deal_ID: "...", ... } }
          if (window.ZOHO?.CREATOR?.DATA?.getRecordById) {
            const res = await ZOHO.CREATOR.DATA.getRecordById({
              app_name:    CONFIG.creator.appLinkName,
              report_name: CONFIG.creator.reportLinkName,
              id:          recordId
            });
            console.log(`[Winny] Poll ${attempt} raw response:`, JSON.stringify(res));
            if (res?.code === 3000) {
              record = res?.data || null;
            }
          }
          // SDK v1 fallback — uses appName/reportName camelCase
          else if (window.ZOHO?.CREATOR?.API?.getRecordById) {
            const res = await ZOHO.CREATOR.API.getRecordById({
              appName:    CONFIG.creator.appLinkName,
              reportName: CONFIG.creator.reportLinkName,
              id:         recordId
            });
            record = res?.data || res;
          }

          if (!record) continue;

          const status = record.Status || record.status || "";
          console.log(`[Winny] Poll attempt ${attempt}: Status = ${status}`);

          if (status !== "Pending" && status !== "Processing") {
            return record;   // Done — Success or Failed
          }
        } catch (e) {
          console.warn(`[Winny] Poll attempt ${attempt} error:`, e.message || e);
        }
      }

      // Timed out — return optimistic success so UI doesn't block
      console.warn("[Winny] Poll timed out after", maxAttempts, "attempts.");
      return { Status: "Success", _timedOut: true };
    }

    // ── portal load + application details ──
    async function loadPortalCustomerData() {
  const applicationIdAtLoadStart = String(
    applicationData.applicationId || ""
  );
  const loggedInEmail = await getLoggedInEmail();
      if (!loggedInEmail) { toast("Could not detect the logged-in portal email. Continue with manual details."); return; }
      applicationData.crmSync.loggedInEmail = loggedInEmail;
      if (!applicationData.customer.email) applicationData.customer.email = loggedInEmail;
      state.localApplicationDrafts = loadApplicationDraftIndex();
      if (!hasZohoTransport()) return;
      showLoader("Loading your CRM application...");
     try {
        // findContactByEmail / findDealsForContact rely on direct CRM SDK
        // transport (hasCreatorRestTransport / canUseCrmSdk) which is NOT
        // available inside this Creator portal widget context — both always
        // return false here, so that path is effectively dead code. The
        // Deluge "Get Applications" bridge is the only transport that
        // reliably reaches CRM from here, so it's now the single source of
        // truth for both hydration and pruning, regardless of whether the
        // direct contact lookup below succeeds.
const { success: requestSucceeded, deals: requestDeals } = await fetchApplicationsViaPortalRequest();
        if (requestSucceeded) {
          pruneStaleLocalDrafts(requestDeals);
        } else {
          console.warn("[Winny] Skipping stale-draft pruning — could not confirm current CRM state.");
        }
        state.portalApplications = requestDeals.map(applicationCardFromDeal);

// The user may have started a new application while CRM data was loading.
// Keep the application cards, but do not hydrate the old deal into the new application.
if (
  String(applicationData.applicationId || "") !==
  applicationIdAtLoadStart
) {
  console.log(
    "[Winny] Skipping stale initial CRM hydration because the active application changed."
  );
  return;
}

const contact = await findContactByEmail(loggedInEmail);
        if (!contact) {
          if (requestDeals.length) {
            await loadApplicationCardsFromDeals(requestDeals);
            toast("CRM applications loaded for this portal user.");
          } else if (requestSucceeded) {
            toast("No CRM contact found for this portal email. A contact will be created when details are saved.");
          }
          return;
        }
        hydrateCustomerFromContact(contact);
        const contactId = contact.id || contact.ID;
        applicationData.deal.crmContactId = contactId || applicationData.deal.crmContactId;
        const savedDealId = String(applicationData.deal.crmDealId || "").trim();
        const directDeals = contactId ? await findDealsForContact(contactId) : [];
        const relatedDeals = directDeals.length ? directDeals : requestDeals;
        const latestDeal = savedDealId
          ? relatedDeals.find((deal) => String(deal.id || deal.ID || "") === savedDealId) || await findDealById(savedDealId)
          : relatedDeals[0] || null;
        if (latestDeal) {
          hydrateDealFromCrm(latestDeal);
          const dealId = latestDeal.id || latestDeal.ID;
          if (dealId) {
            applicationData.deal.crmDealId = dealId;
            const travellers = await findTravellersForDeal(dealId);
            if (travellers.length) hydrateTravellersFromCrm(travellers);
          }
          toast("Latest CRM deal loaded for this portal user.");
        } else {
          toast("CRM contact found. No related deal yet.");
        }
      } catch (error) {
        console.error(error);
        applicationData.crmSync.lastError = error.message || "CRM load failed";
        toast("Could not load CRM data for this portal user.");
      } finally {
        applicationData.crmSync.lastSyncAt = new Date().toISOString();
        hideLoader();
      }
    }

    async function loadApplicationCardsFromDeals(deals) {
      state.portalApplications = deals.map(applicationCardFromDeal);
      const latestDeal = deals[0] || null;
      if (!latestDeal || hasApplicationInfo()) return;
      hydrateDealFromCrm(latestDeal);
      const dealId = latestDeal.id || latestDeal.ID;
      if (dealId) applicationData.deal.crmDealId = dealId;
    }

    // Returns { success, deals }. success=false means the request itself
    // failed or timed out — an empty deals list in that case must NOT be
    // trusted as "customer has zero applications," since a network hiccup
    // looks identical to a genuinely empty result otherwise.
    async function fetchApplicationsViaPortalRequest() {
      if (!window.ZOHO?.CREATOR?.DATA?.addRecords) return { success: false, deals: [] };
      try {
        const creatorRecordId = await submitPortalCrmRequest("Get Applications");
        if (!creatorRecordId) return { success: false, deals: [] };
        const processedRecord = await pollCreatorRecord(creatorRecordId, 6, 1200);
        if (processedRecord.Status === "Failed" || processedRecord._timedOut) {
          console.warn("[Winny] Get Applications did not confirm success:", processedRecord);
          return { success: false, deals: [] };
        }
        const rows = parseApplicationsResponse(processedRecord);
        return { success: true, deals: rows.sort(compareCreatedTimeDesc) };
      } catch (error) {
        console.warn("Portal application request failed", error);
        return { success: false, deals: [] };
      }
    }
    async function fetchApplicationDetailsViaPortalRequest(dealId) {
  const normalizedDealId = String(dealId || "").trim();
  if (!normalizedDealId) return null;

  applicationData.deal.crmDealId = normalizedDealId;

  const requestId = await submitPortalCrmRequest("Get Application Details");
  if (!requestId) {
    throw new Error("Could not create the application-details request.");
  }

  const result = await pollCreatorRecord(requestId, 15, 1200);

  if (result._timedOut) {
    throw new Error("Application-details request timed out.");
  }

  if (result.Status === "Failed") {
    throw new Error(
      result.Error_Message || "Application details could not be loaded."
    );
  }

  const raw =
    result.CRM_Response ||
    result.crmResponse ||
    "";

  const parsed =
    typeof raw === "string"
      ? safeJsonParse(raw)
      : raw;

  if (!parsed || typeof parsed !== "object" || !parsed.deal) {
    throw new Error("Application-details response was empty or invalid.");
  }

  return parsed;
}

function hydrateApplicationDetails(details) {
  if (!details) return;

  const existingFamilyByTravellerId = new Map();
  const existingFamilyByCrmId = new Map();
  (applicationData.deal.travellers || []).forEach((traveller) => {
    if (!traveller.familyId) return;
    if (traveller.id) existingFamilyByTravellerId.set(String(traveller.id), traveller.familyId);
    if (traveller.crmId) existingFamilyByCrmId.set(String(traveller.crmId), traveller.familyId);
  });

  const savedPayload =
    details.savedPayload &&
    typeof details.savedPayload === "object"
      ? details.savedPayload
      : {};

  // Restore the complete snapshot stored during Payment Complete.
  if (savedPayload.customer) {
    applicationData.customer = mergeDeep(
      applicationData.customer || {},
      savedPayload.customer
    );
  }

  if (savedPayload.deal) {
    applicationData.deal = mergeDeep(
      applicationData.deal || {},
      savedPayload.deal
    );

    const travellerFamilyGroups =
      applicationData.deal.travellerFamilyGroups &&
      typeof applicationData.deal.travellerFamilyGroups === "object"
        ? applicationData.deal.travellerFamilyGroups
        : {};

    (applicationData.deal.travellers || []).forEach((traveller) => {
      traveller.familyId =
        travellerFamilyGroups[traveller.id] ||
        existingFamilyByTravellerId.get(String(traveller.id || "")) ||
        existingFamilyByCrmId.get(String(traveller.crmId || "")) ||
        traveller.familyId ||
        "family-1";
    });
  }

      if (savedPayload.payment) {
    applicationData.payment = mergeDeep(
      applicationData.payment || {},
      savedPayload.payment
    );
  }

  if (
    savedPayload.questionnaire &&
    typeof savedPayload.questionnaire === "object"
  ) {
    applicationData.questionnaire = mergeDeep(
      applicationData.questionnaire || {},
      savedPayload.questionnaire
    );
  }

  if (
    savedPayload.cifRecords &&
    typeof savedPayload.cifRecords === "object"
  ) {
    applicationData.cifRecords = mergeDeep(
      applicationData.cifRecords || {},
      savedPayload.cifRecords
    );
  }

  // Overlay the latest Contact and Deal values from CRM.
  if (details.contact) {
    hydrateCustomerFromContact(details.contact);

    applicationData.deal.crmContactId =
      String(details.contact.id || details.contact.ID || "") ||
      applicationData.deal.crmContactId;

    applicationData.customer.mailingStreet =
      readZohoValue(details.contact.Mailing_Street) ||
      applicationData.customer.mailingStreet;

    applicationData.customer.mailingCity =
      readZohoValue(details.contact.Mailing_City) ||
      applicationData.customer.mailingCity;

    applicationData.customer.mailingState =
      readZohoValue(details.contact.Mailing_State) ||
      applicationData.customer.mailingState;

    applicationData.customer.mailingZip =
      readZohoValue(details.contact.Mailing_Zip) ||
      applicationData.customer.mailingZip;

    applicationData.customer.mailingCountry =
      readZohoValue(details.contact.Mailing_Country) ||
      applicationData.customer.mailingCountry;
  }

  if (details.deal) {
    hydrateDealFromCrm(details.deal);

    const received = Number(
      readZohoValue(details.deal.Amount_Received)
    );

    const balance = Number(
      readZohoValue(details.deal.Balance_Amount)
    );

    const requested = Number(
      readZohoValue(details.deal.Payment_Requested)
    );

    if (Number.isFinite(received)) {
      applicationData.payment.paidAmount = received;
    }

    if (Number.isFinite(balance)) {
      applicationData.payment.balanceAmount = balance;
    }

    if (Number.isFinite(requested) && requested > 0) {
      applicationData.payment.payableNow = requested;
    }
  }

  const crmTravellerRows =
    Array.isArray(details.travellers)
      ? details.travellers
      : [];

  /*
   * The stored Payment Complete payload contains richer traveller data.
   * Keep it and only attach current CRM record IDs. If no snapshot exists,
   * reconstruct the travellers from CRM.
   */
  if (
    !Array.isArray(applicationData.deal.travellers) ||
    !applicationData.deal.travellers.length
  ) {
    if (crmTravellerRows.length) {
      hydrateTravellersFromCrm(crmTravellerRows);
    }
  } else {
    reconcileTravellerCrmRows(crmTravellerRows);
  }

  applicationData.deal.crmDealId =
    String(details.deal?.id || details.deal?.ID || "") ||
    applicationData.deal.crmDealId;

  applicationData.deal.dealSavedToCRM = Boolean(
    applicationData.deal.crmDealId
  );

  /*
 * The Creator questionnaire record is the authoritative submission lock.
 * Once it exists for this Deal, the portal must never permit resubmission.
 */
const questionnaireStatus =
  details.questionnaire &&
  typeof details.questionnaire === "object"
    ? details.questionnaire
    : {};

const questionnaireSubmitted =
  questionnaireStatus.submitted === true ||
  String(questionnaireStatus.submitted || "")
    .trim()
    .toLowerCase() === "true";

if (questionnaireSubmitted) {
  applicationData.stepStatus.questionnaireCompleted = true;

  applicationData.questionnaire.creatorRecordId =
    String(
      questionnaireStatus.recordId ||
      questionnaireStatus.recordID ||
      ""
    );
}

syncCustomerToTraveller();
}
function parseApplicationsResponse(response) {
      const data = Array.isArray(response?.data) ? response.data[0] : response?.data || response || {};
      const raw = data.CRM_Response || data.crmResponse || data.Applications || data.applications || "";
      const parsed = typeof raw === "string" && raw.trim() ? safeJsonParse(raw) : raw;
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.deals)) return parsed.deals;
      if (Array.isArray(parsed?.applications)) return parsed.applications;
      if (Array.isArray(data.deals)) return data.deals;
      if (Array.isArray(data.applications)) return data.applications;
      return [];
    }

    // ── CRM lookups ──
    async function findContactByEmail(email) {
      if (!email) return null;
      if (hasCreatorRestTransport()) {
        const r = await crmRest("GET", `/${CONFIG.modules.contacts}/search?email=${encodeURIComponent(email)}`);
        return getResponseRows(r)[0] || null;
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.searchRecord) {
        const r = await ZOHO.CRM.API.searchRecord({ Entity: CONFIG.modules.contacts, Type: "email", Query: email });
        return getResponseRows(r)[0] || null;
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getAllRecords) {
        const r = await crmGetRecords(CONFIG.modules.contacts, "id,First_Name,Last_Name,Email,Mobile,Phone");
        return getResponseRows(r).find((row) => String(row.Email||"").toLowerCase() === email.toLowerCase()) || null;
      }
      return null;
    }

    async function findDealById(dealId) {
      if (!dealId) return null;
      if (hasCreatorRestTransport()) {
        try {
          const r = await crmRest(
  "GET",
  `/${CONFIG.modules.deals}/${dealId}?fields=${encodeURIComponent(
    "id,Deal_Name,Stage,Amount,Contact_Name,Destination,Service_Type,Payment_Status,Application_Number,Amount_Receivable,Payment_Requested,Amount_Received,Balance_Amount,Created_Time"
  )}`
);
          return getResponseRows(r)[0] || null;
        } catch(e) { console.warn(e); }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getRecord) {
        try {
          const r = await ZOHO.CRM.API.getRecord({ Entity: CONFIG.modules.deals, RecordID: dealId });
          return getResponseRows(r)[0] || r?.data?.[0] || r || null;
        } catch(e) { console.warn(e); }
      }
      return null;
    }

    async function refreshCurrentDealFromCrm(silent = false) {
      const dealId = String(applicationData.deal.crmDealId || "").trim();
      if (!dealId || state.refreshingCurrentDeal || !hasZohoTransport()) return false;

      state.refreshingCurrentDeal = true;
      try {
        const previousStatus = applicationData.payment.status;

let applicationDetails = null;

try {
  applicationDetails =
    await fetchApplicationDetailsViaPortalRequest(dealId);
} catch (detailsError) {
  console.warn(
    "[Winny] Complete CRM refresh was unavailable:",
    detailsError
  );
}

const deal =
  applicationDetails?.deal ||
  await findDealById(dealId);

// Ignore this response if the user opened or created another application
// while the CRM request was still running.
if (
  String(applicationData.deal.crmDealId || "").trim() !== dealId
) {
  console.log(
    "[Winny] Ignoring stale payment refresh for previous deal:",
    dealId
  );
  return false;
}

if (applicationDetails) {
  hydrateApplicationDetails(applicationDetails);
} else if (deal) {
  hydrateDealFromCrm(deal);
} else {
  const paymentStatus = await fetchPaymentStatusViaPortalRequest();

  // The active application may also change during the fallback request.
  if (
    String(applicationData.deal.crmDealId || "").trim() !== dealId
  ) {
    console.log(
      "[Winny] Ignoring stale fallback payment response for previous deal:",
      dealId
    );
    return false;
  }

  if (!paymentStatus) return false;
  applicationData.payment.status = paymentStatus;
          if (isFullyPaidStatus(applicationData.payment.status)) {
            applicationData.stepStatus.dealCompleted = true;
          } else if (!applicationData.stepStatus.questionnaireCompleted) {
            applicationData.stepStatus.dealCompleted = false;
          }
        }
        applicationData.crmSync.lastSyncAt = new Date().toISOString();
        saveDraft(false);
        requestRender();
        requestRender();
        requestRender();

        if (!silent && previousStatus !== applicationData.payment.status) {
          toast(`Payment status updated: ${applicationData.payment.status}`);
        }
        console.log("[Winny] Refreshed CRM deal payment status:", {
          dealId,
          paymentStatus: applicationData.payment.status,
          dealCompleted: applicationData.stepStatus.dealCompleted
        });
        return true;
      } catch (error) {
        console.warn("[Winny] Current deal refresh failed:", error);
        if (!silent) toast("Could not refresh payment status from CRM.");
        return false;
      } finally {
        state.refreshingCurrentDeal = false;
      }
    }

    async function fetchPaymentStatusViaPortalRequest() {
      const creatorRecordId = await submitPortalCrmRequest("Check Payment Status");
      const result = await pollCreatorRecord(creatorRecordId, 10, 1500);

      if (result.Status === "Failed") {
        throw new Error(result.Error_Message || "Check Payment Status failed.");
      }

      let crmResponse = result.CRM_Response || "";
      if (typeof crmResponse === "string" && crmResponse.trim()) {
        try {
          crmResponse = JSON.parse(crmResponse);
        } catch (error) {
          console.warn("[Winny] Could not parse payment status CRM_Response:", crmResponse);
        }
      }

      return (
        result.Payment_Status ||
        crmResponse?.paymentStatus ||
        crmResponse?.Payment_Status ||
        crmResponse?.payment_status ||
        ""
      );
    }

    async function findLatestDealForContact(contactId) {
      if (!contactId) return null;
      if (hasCreatorRestTransport()) {
        const attempts = [
          () => crmRest("GET", `/${CONFIG.modules.contacts}/${contactId}/${CONFIG.modules.deals}?sort_by=Created_Time&sort_order=desc&per_page=10`),
          () => crmRest("GET", `/${CONFIG.modules.deals}/search?criteria=${encodeURIComponent(`(Contact_Name:equals:${contactId})`)}`)
        ];
        for (const attempt of attempts) {
          try { const r = await attempt(); const rows = getResponseRows(r); if (rows.length) return rows.sort(compareCreatedTimeDesc)[0]; } catch(e) { console.warn(e); }
        }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getRelatedRecords) {
        try { const r = await ZOHO.CRM.API.getRelatedRecords({ Entity: CONFIG.modules.contacts, RecordID: contactId, RelatedList: CONFIG.modules.deals, page: 1, per_page: 100 }); const rows = getResponseRows(r); if (rows.length) return rows.sort(compareCreatedTimeDesc)[0]; } catch(e) { console.warn(e); }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getAllRecords) {
        const r    = await crmGetRecords(CONFIG.modules.deals, "id,Deal_Name,Stage,Amount,Contact_Name,Destination,Service_Type,Payment_Status,Created_Time");
        const rows = getResponseRows(r).filter((row) => readZohoId(row.Contact_Name) === String(contactId));
        if (rows.length) return rows.sort(compareCreatedTimeDesc)[0];
      }
      return null;
    }

    async function findDealsForContact(contactId) {
      if (!contactId) return [];
      if (hasCreatorRestTransport()) {
        const attempts = [
          () => crmRest("GET", `/${CONFIG.modules.contacts}/${contactId}/${CONFIG.modules.deals}?sort_by=Created_Time&sort_order=desc&per_page=100`),
          () => crmRest("GET", `/${CONFIG.modules.deals}/search?criteria=${encodeURIComponent(`(Contact_Name:equals:${contactId})`)}`)
        ];
        for (const attempt of attempts) {
          try {
            const r = await attempt();
            const rows = getResponseRows(r);
            if (rows.length) return rows.sort(compareCreatedTimeDesc);
          } catch(e) { console.warn(e); }
        }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getRelatedRecords) {
        try {
          const r = await ZOHO.CRM.API.getRelatedRecords({ Entity: CONFIG.modules.contacts, RecordID: contactId, RelatedList: CONFIG.modules.deals, page: 1, per_page: 100 });
          const rows = getResponseRows(r);
          if (rows.length) return rows.sort(compareCreatedTimeDesc);
        } catch(e) { console.warn(e); }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getAllRecords) {
        const r = await crmGetRecords(CONFIG.modules.deals, "id,Deal_Name,Stage,Amount,Contact_Name,Destination,Service_Type,Payment_Status,Application_Number,Created_Time");
        const rows = getResponseRows(r).filter((row) => readZohoId(row.Contact_Name) === String(contactId));
        if (rows.length) return rows.sort(compareCreatedTimeDesc);
      }
      return [];
    }
    // Only application cards backed by a CRM Deal ID that still exists in
    // CRM get shown. Anything without a live, matching crmDealId is hidden —
    // no fallback matching by application number, since that field isn't
    // reliably saved to CRM.
    function pruneStaleLocalDrafts(validDeals) {
      const validIds = new Set((validDeals || []).map((d) => String(d.id || d.ID || "")).filter(Boolean));
      const indexKey = getDraftIndexKey();
      let drafts;
      try { drafts = JSON.parse(localStorage.getItem(indexKey) || "{}"); } catch (e) { return; }
      let changed = false;
      Object.keys(drafts).forEach((key) => {
        const draft = drafts[key];
       const draftDealId = String(
  draft?.deal?.crmDealId || ""
).trim();

// Application cards must be backed by a currently existing CRM Deal.
const stale =
  !draftDealId ||
  !validIds.has(draftDealId);
        if (stale) {
          delete drafts[key];
          changed = true;
        }
      });
      if (changed) {
        localStorage.setItem(indexKey, JSON.stringify(drafts));
        state.localApplicationDrafts = draftsToApplicationCards(drafts);
      }
      const currentDealId = String(applicationData.deal.crmDealId || "");
      if (currentDealId && !validIds.has(currentDealId)) {
        toast("This application was deleted in CRM and has been removed.");
        try { localStorage.removeItem(CONFIG.localStorageKey); } catch (e) {}
        replaceApplicationData(blankApplication());
        state.dealSubStep = 1;
      }
    }
    function applicationCardFromDeal(deal) {
      const dealId = String(deal.id || deal.ID || "");
      const paymentStatus = readZohoValue(deal.Payment_Status) || "Pending";
      const stage = readZohoValue(deal.Stage) || "In Progress";
      const normalizedStage = String(stage).toLowerCase();
      const stageIndex = /submitted|closed/.test(normalizedStage)
        ? 5
        : /review/.test(normalizedStage)
          ? 4
          : /case file|cif|document submission|documents?/.test(normalizedStage)
            ? 3
            : /case question|questionnaire/.test(normalizedStage)
              ? 2
              : isFullyPaidStatus(paymentStatus) || /payment complete/.test(normalizedStage)
                ? 1
                : 0;
      const progressPercent = Math.round((stageIndex / 5) * 100);
      return {
        source: "crm",
        dealId,
        applicationId: readZohoValue(deal.Application_Number) || "",
        title: readZohoValue(deal.Deal_Name) || "Application",
        destination: readZohoValue(deal.Destination) || "",
        serviceType: readZohoValue(deal.Service_Type) || "",
        stage,
        stageIndex,
        progressPercent,
        paymentStatus,
        status: /closed|submitted|complete/i.test(stage) ? "Submitted" : "In Progress",
        createdTime: readZohoValue(deal.Created_Time) || ""
      };
    }

    async function findTravellersForDeal(dealId) {
      if (!dealId) return [];
      if (hasCreatorRestTransport()) {
        const attempts = [
          () => crmRest("GET", `/${CONFIG.modules.deals}/${dealId}/${CONFIG.modules.travellers}?per_page=100`),
          () => crmRest("GET", `/${CONFIG.modules.travellers}/search?criteria=${encodeURIComponent(`(Deal_Name:equals:${dealId})`)}`)
        ];
        for (const attempt of attempts) {
          try { const r = await attempt(); const rows = getResponseRows(r); if (rows.length) return rows; } catch(e) { console.warn(e); }
        }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getRelatedRecords) {
        try { const r = await ZOHO.CRM.API.getRelatedRecords({ Entity: CONFIG.modules.deals, RecordID: dealId, RelatedList: "Traveller_Details", page: 1, per_page: 100 }); const rows = getResponseRows(r); if (rows.length) return rows; } catch(e) { console.warn(e); }
      }
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getAllRecords) {
        const r = await crmGetRecords(CONFIG.modules.travellers, "id,Name,First_Name,Last_Name,Email,Mobile,Date_of_Birth,Destination_Name,Service_Type,Traveller_Type,Deal_Name,Created_Time");
        return getResponseRows(r).filter((row) => readZohoId(row.Deal_Name) === String(dealId));
      }
      return [];
    }

    function reconcileTravellerCrmRows(rows) {
      if (!Array.isArray(rows) || !rows.length) return 0;
      const usedCrmIds = new Set(
        applicationData.deal.travellers
          .map((traveller) => String(traveller.crmId || ""))
          .filter(Boolean)
      );
      let matchedCount = 0;

      applicationData.deal.travellers.forEach((traveller) => {
        if (traveller.crmId) return;
        const localEmail = String(traveller.email || "").trim().toLowerCase();
        const localName = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim().toLowerCase();
        const localDob = String(traveller.dob || "").trim();

        const matchingRow = rows.find((row) => {
          const crmId = String(row.id || row.ID || "");
          if (!crmId || usedCrmIds.has(crmId)) return false;
          const crmEmail = String(readZohoValue(row.Email) || "").trim().toLowerCase();
          const crmName = String(
            readZohoValue(row.Name) ||
            readZohoValue(row.Full_Name) ||
            `${readZohoValue(row.First_Name) || ""} ${readZohoValue(row.Last_Name) || ""}`
          ).trim().toLowerCase();
          const crmDob = String(readZohoValue(row.Date_of_Birth) || "").trim();

          if (localEmail && crmEmail && localEmail === crmEmail) return true;
          return Boolean(localName && crmName === localName && (!localDob || !crmDob || localDob === crmDob));
        });

        if (!matchingRow) return;
        traveller.crmId = String(matchingRow.id || matchingRow.ID);
        usedCrmIds.add(traveller.crmId);
        matchedCount += 1;
      });

      return matchedCount;
    }

    // ─── CRM HYDRATE ─────────────────────────────────────────────────────────

    function hydrateCustomerFromContact(contact) {
      applicationData.customer.firstName = readZohoValue(contact.First_Name) || applicationData.customer.firstName;
      applicationData.customer.lastName  = readZohoValue(contact.Last_Name)  || applicationData.customer.lastName;
      applicationData.customer.email     = readZohoValue(contact.Email)      || applicationData.customer.email;
      applicationData.customer.mobile    = readZohoValue(contact.Mobile) || readZohoValue(contact.Phone) || applicationData.customer.mobile;
    }

    function hydrateDealFromCrm(deal) {
      const dealId = deal.id || deal.ID || "";
      if (dealId) {
        applicationData.deal.crmDealId = String(dealId);
        applicationData.deal.dealSavedToCRM = true;
      }
      const appNo = readZohoValue(deal.Application_Number);
      if (appNo) applicationData.applicationId = appNo;
      applicationData.deal.dealName      = readZohoValue(deal.Deal_Name)      || applicationData.deal.dealName;
      applicationData.deal.destination   = readZohoValue(deal.Destination)    || applicationData.deal.destination;
      const crmServiceType = readZohoValue(deal.Service_Type);
      const crmGoal = getGoalDefinition(crmServiceType);
      if (crmGoal) {
        applicationData.deal.goal = crmGoal.label;
        applicationData.deal.serviceTypeKey = crmGoal.key;
      } else if (crmServiceType && !applicationData.deal.goal) {
        applicationData.deal.goal = crmServiceType;
      }
const crmReceivableRaw =
  readZohoValue(deal.Amount_Receivable);

const crmAmountRaw =
  readZohoValue(deal.Amount);

const crmPaidRaw =
  readZohoValue(deal.Amount_Received);

const crmBalanceRaw =
  readZohoValue(deal.Balance_Amount);

const crmRequestedRaw =
  readZohoValue(deal.Payment_Requested);

const hasCrmNumber = (value) =>
  value !== null &&
  value !== undefined &&
  String(value).trim() !== "" &&
  Number.isFinite(Number(value));

if (hasCrmNumber(crmReceivableRaw)) {
  applicationData.payment.grandTotal =
    Number(crmReceivableRaw);
} else if (hasCrmNumber(crmAmountRaw)) {
  applicationData.payment.grandTotal =
    Number(crmAmountRaw);
}

if (hasCrmNumber(crmPaidRaw)) {
  applicationData.payment.paidAmount =
    Number(crmPaidRaw);
}

if (hasCrmNumber(crmBalanceRaw)) {
  const crmBalance = Number(crmBalanceRaw);

  applicationData.payment.balanceAmount =
    crmBalance;

  applicationData.payment.crmBalanceAmount =
    crmBalance;
} else if (
  hasCrmNumber(crmReceivableRaw) &&
  hasCrmNumber(crmPaidRaw)
) {
  const calculatedBalance = Math.max(
    Number(crmReceivableRaw) - Number(crmPaidRaw),
    0
  );

  applicationData.payment.balanceAmount =
    calculatedBalance;

  applicationData.payment.crmBalanceAmount =
    calculatedBalance;
}

if (hasCrmNumber(crmRequestedRaw)) {
  applicationData.payment.payableNow =
    Number(crmRequestedRaw);
}

const crmStatusRaw =
  readZohoValue(deal.Payment_Status);

const crmStatus =
  String(crmStatusRaw || "").trim();

const crmStage =
  String(readZohoValue(deal.Stage) || "").trim();

applicationData.payment.status =
  crmStatus ||
  (crmStage === "Payment Received" ? "Paid" : "Pending");

if (/partial/i.test(applicationData.payment.status)) {
  applicationData.payment.paymentMode = "Partial";
}

applicationData.stepStatus.dealCompleted =
  isFullyPaidStatus(applicationData.payment.status);
    }

    function hydrateTravellersFromCrm(rows) {
      applicationData.deal.travellers = rows.map((row, index) => {
        const name  = readZohoValue(row.Name) || readZohoValue(row.Full_Name) || "";
        const parts = name.split(" ");
        return {
          id:           `crm-traveller-${row.id||row.ID||index}`,
          crmId:        row.id || row.ID || "",
          familyId:     "family-1",
          type:
  readZohoValue(row.Traveller_Type) === "Primary Applicant"
    ? "Primary Applicant"
    : readZohoValue(row.Traveller_Relation) === "Spouse"
      ? "Spouse"
      : ["Child 1", "Child 2", "Child 3"].includes(
          readZohoValue(row.Traveller_Relation)
        )
        ? "Child"
        : (index === 0 ? "Primary Applicant" : "Additional Traveller"),
          firstName:    readZohoValue(row.First_Name) || parts.shift() || "",
          lastName:     readZohoValue(row.Last_Name)  || parts.join(" "),
          dob:          readZohoValue(row.Date_of_Birth) || "",
          relationship: readZohoValue(row.Traveller_Relation) || "",
          nationality:  readZohoValue(row.Nationality)  || "Indian",
          email:        readZohoValue(row.Email)  || "",
          mobile:       readZohoValue(row.Mobile) || "",
          serviceType:  readZohoValue(row.Service_Type) || applicationData.deal.goal || ""
        };
      });
    }

export {
  submitPortalCrmRequest, pollCreatorRecord,
  loadPortalCustomerData, loadApplicationCardsFromDeals,
  fetchApplicationsViaPortalRequest, fetchApplicationDetailsViaPortalRequest,
  hydrateApplicationDetails, parseApplicationsResponse,
  findContactByEmail, findDealById, refreshCurrentDealFromCrm,
  fetchPaymentStatusViaPortalRequest, findLatestDealForContact, findDealsForContact,
  pruneStaleLocalDrafts, applicationCardFromDeal, findTravellersForDeal, reconcileTravellerCrmRows,
  hydrateCustomerFromContact, hydrateDealFromCrm, hydrateTravellersFromCrm
};
