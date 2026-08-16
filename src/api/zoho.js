// ─────────────────────────────────────────────────────────────────────────
// Zoho transport core — copied VERBATIM from the original widget.
// Exact endpoints, connection names and SDK calls preserved unchanged:
//   • CRM v8 REST via ZOHO.CREATOR.API.invokeUrl (CONFIG.crmConnectionName)
//   • ZOHO.CRM.API.* SDK fallback
//   • Zoho Payments REST via invokeUrl (CONFIG.paymentsConnectionName)
// DOM helpers (showLoader/hideLoader) are imported from the UI bridge.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { validators } from "../lib/validators.js";
import { parseJsonMaybe } from "../lib/utils.js";
import { showLoader, hideLoader } from "../lib/ui.js";

// ─── TRANSPORT PREDICATES ─────────────────────────────────────────────────
    function hasZohoTransport()      { return Boolean(window.ZOHO?.CREATOR?.DATA?.addRecords || hasCreatorRestTransport() || canUseCrmSdk()); }
    function hasCreatorRestTransport(){ return Boolean(window.ZOHO?.CREATOR?.API?.invokeUrl); }
    function isCreatorPortalContext() { return /(^|\.)creatorapp\.zoho\./i.test(window.location.hostname) || /(^|\.)creator\.zoho\./i.test(window.location.hostname); }
    function canUseCrmSdk()           { return Boolean(!isCreatorPortalContext() && window.ZOHO?.CRM?.API); }

    function getZohoTransportDiagnostics() {
      return [
        `host=${window.location.hostname||"unknown"}`,
        `ZOHO=${Boolean(window.ZOHO)}`,
        `CREATOR=${Boolean(window.ZOHO?.CREATOR)}`,
        `CREATOR.init=${Boolean(window.ZOHO?.CREATOR?.init)}`,
        `CREATOR.API=${Boolean(window.ZOHO?.CREATOR?.API)}`,
        `CREATOR.API.addRecord=${Boolean(window.ZOHO?.CREATOR?.API?.addRecord)}`,
        `CREATOR.API.getAllRecords=${Boolean(window.ZOHO?.CREATOR?.API?.getAllRecords)}`,
        `CREATOR.API.getRecords=${Boolean(window.ZOHO?.CREATOR?.API?.getRecords)}`,
        `CREATOR.API.invokeUrl=${Boolean(window.ZOHO?.CREATOR?.API?.invokeUrl)}`,
        `CREATOR.DATA=${Boolean(window.ZOHO?.CREATOR?.DATA)}`,
        `CREATOR.DATA.addRecords=${Boolean(window.ZOHO?.CREATOR?.DATA?.addRecords)}`,
        `CREATOR.DATA.getRecords=${Boolean(window.ZOHO?.CREATOR?.DATA?.getRecords)}`,
        `CREATOR.DATA.getRecordById=${Boolean(window.ZOHO?.CREATOR?.DATA?.getRecordById)}`,
        `CREATOR.DATA.updateRecordById=${Boolean(window.ZOHO?.CREATOR?.DATA?.updateRecordById)}`,
        `CREATOR.FILE=${Boolean(window.ZOHO?.CREATOR?.FILE)}`,
        `CREATOR.FILE.uploadFile=${Boolean(window.ZOHO?.CREATOR?.FILE?.uploadFile)}`,
        `SDK_version=${window.ZOHO?.CREATOR?.DATA ? "v2" : window.ZOHO?.CREATOR?.API ? "v1" : "none"}`,
        `CRM.API=${Boolean(window.ZOHO?.CRM?.API)}`,
        `creatorPortal=${isCreatorPortalContext()}`
      ].join("; ");
    }


// ─── ZOHO SDK INIT ────────────────────────────────────────────────────────
    async function initZoho() {
      showLoader("Connecting to Zoho...");
      try {
        // SDK v2: ZOHO.CREATOR.DATA is available automatically — no init() call needed.
        // SDK v1 compat: if init() still exists, call it but don't block on failure.
        if (window.ZOHO?.CREATOR?.init) {
          await withTimeout(ZOHO.CREATOR.init(), 3500, "Zoho Creator SDK init timed out.").catch(() => {});
        }
        // Wait a tick for SDK v2 to self-initialise DATA namespace
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.warn("Zoho SDK init failed", error);
      } finally {
        state.isZohoReady = hasZohoTransport();
        hideLoader();
      }
      console.log("[Winny] Transport diagnostics:", getZohoTransportDiagnostics());
    }

    function withTimeout(promise, timeoutMs, message) {
      return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => setTimeout(() => reject(new Error(message || "Operation timed out.")), timeoutMs))
      ]);
    }

// ─── CRM / PAYMENTS REST + CRUD ──────────────────────────────────────────
    async function crmGetRecords(moduleName, fields) {
      if (hasCreatorRestTransport()) return crmRest("GET", `/${moduleName}?page=1&per_page=20&fields=${encodeURIComponent(fields)}`);
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.getAllRecords) return ZOHO.CRM.API.getAllRecords({ Entity: moduleName, page: 1, per_page: 20 });
      throw new Error("Zoho CRM transport is unavailable.");
    }

    async function crmInsertRecords(moduleName, rows) {
      if (hasCreatorRestTransport()) return crmRest("POST", `/${moduleName}`, { data: rows });
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.insertRecord) {
        const responses = await Promise.all(rows.map((row) => ZOHO.CRM.API.insertRecord({ Entity: moduleName, APIData: row })));
        return { data: responses.map((r) => Array.isArray(r?.data) ? r.data[0] : r) };
      }
      throw new Error("Zoho CRM transport is unavailable.");
    }

    async function crmUpdateRecord(moduleName, id, row) {
      if (hasCreatorRestTransport()) return crmRest("PUT", `/${moduleName}/${id}`, { data: [row] });
      if (canUseCrmSdk() && window.ZOHO?.CRM?.API?.updateRecord) return ZOHO.CRM.API.updateRecord({ Entity: moduleName, RecordID: id, APIData: row });
      throw new Error("Zoho CRM transport is unavailable.");
    }

    async function crmRest(method, path, body) {
      if (!window.ZOHO?.CREATOR?.API?.invokeUrl) throw new Error(`Zoho Creator invokeUrl unavailable. ${getZohoTransportDiagnostics()}`);
      const request = { url: `${CONFIG.crmApiBase}${path}`, type: method, connectionName: CONFIG.crmConnectionName };
      if (body) { request.headers = { "Content-Type": "application/json" }; request.data = JSON.stringify(body); }
      return ZOHO.CREATOR.API.invokeUrl(request);
    }

    async function paymentsRest(method, path, body) {
      if (!window.ZOHO?.CREATOR?.API?.invokeUrl) throw new Error("Zoho Creator invokeUrl unavailable.");
      const request = { url: `${CONFIG.paymentsApiBase}${path}`, type: method, connectionName: CONFIG.paymentsConnectionName, headers: { "Content-Type": "application/json" } };
      if (body) request.data = JSON.stringify(body);
      return ZOHO.CREATOR.API.invokeUrl(request);
    }

// ─── RESPONSE UTILITIES ──────────────────────────────────────────────────
    function getResponseRows(response) {
      response = parseJsonMaybe(response);
      if (typeof response === "string") return [];
      if (response?.responseText) return getResponseRows(response.responseText);
      if (response?.response) return getResponseRows(response.response);
      if (Array.isArray(response?.data)) return response.data;
      if (Array.isArray(response?.data?.data)) return response.data.data;
      if (Array.isArray(response?.data?.records)) return response.data.records;
      if (Array.isArray(response?.data?.Products)) return response.data.Products;
      if (Array.isArray(response?.data?.products)) return response.data.products;
      if (Array.isArray(response?.records)) return response.records;
      if (Array.isArray(response?.Products)) return response.Products;
      if (Array.isArray(response?.products)) return response.products;
      if (Array.isArray(response?.result?.data)) return response.result.data;
      if (Array.isArray(response?.result?.records)) return response.result.records;
      if (Array.isArray(response))       return response;
      return [];
    }

    function readZohoId(value) {
      if (value && typeof value === "object") return String(value.id || value.ID || "");
      return String(value || "");
    }

    function readZohoValue(value) {
      if (Array.isArray(value))                  return value.join(", ");
      if (value && typeof value === "object")     return value.name || value.display_value || value.value || value.text || value.content || value.actual_value || value.id || "";
      return value ?? "";
    }

    function compareCreatedTimeDesc(a, b) {
      return new Date(readZohoValue(b.Created_Time) || 0) - new Date(readZohoValue(a.Created_Time) || 0);
    }

    function getCreatedRecordId(response) {
      const first = Array.isArray(response?.data) ? response.data[0] : response;
      return first?.details?.id || first?.id || "";
    }

    function getCreatorRecordId(response) {
      const first = Array.isArray(response?.data) ? response.data[0] : response?.data || response;
      return first?.ID || first?.id || first?.details?.id || "";
    }

// ─── LOGGED-IN EMAIL DETECTION ───────────────────────────────────────────
    async function getLoggedInEmail() {
      const candidates = [];
      const addCandidate = (value) => {
        if (!value) return;
        if (typeof value === "string") candidates.push(value);
        if (typeof value === "object") {
          ["email","Email","login_email","loginEmail","loginUser","loggedInEmail","logged_in_email","zc_UserName","username"].forEach((key) => addCandidate(value[key]));
          addCandidate(value?.user?.email);
          addCandidate(value?.loginUser?.email);
        }
      };
      addCandidate(Object.fromEntries(new URLSearchParams(window.location.search)));
      addCandidate(Object.fromEntries(new URLSearchParams(window.location.hash.replace(/^#/, ""))));
      try { if (window.ZOHO?.CREATOR?.UTIL?.getQueryParams) addCandidate(await ZOHO.CREATOR.UTIL.getQueryParams()); } catch(e) { console.warn(e); }
      try { if (window.ZOHO?.CREATOR?.UTIL?.getInitParams)  addCandidate(await ZOHO.CREATOR.UTIL.getInitParams());  } catch(e) { console.warn(e); }
      try { if (window.ZOHO?.CREATOR?.API?.getProfile)      addCandidate(await ZOHO.CREATOR.API.getProfile());      } catch(e) { console.warn(e); }
      addCandidate(applicationData.customer.email);
      return candidates.map((v) => String(v).trim()).find((v) => validators.email(v) === "") || "";
    }

    // ─── CRM LOOKUPS ─────────────────────────────────────────────────────────

export {
  hasZohoTransport, hasCreatorRestTransport, isCreatorPortalContext, canUseCrmSdk,
  getZohoTransportDiagnostics, initZoho, withTimeout,
  crmGetRecords, crmInsertRecords, crmUpdateRecord, crmRest, paymentsRest,
  getResponseRows, readZohoId, readZohoValue, compareCreatedTimeDesc,
  getCreatedRecordId, getCreatorRecordId, getLoggedInEmail
};
