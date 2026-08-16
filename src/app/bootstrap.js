// Boot sequence — mirrors the original init() ordering exactly:
//   bindEvents(); loadDraft(); await initZoho();
//   email = getLoggedInEmail(); await loadDynamicProducts();
//   await loadPortalCustomerData(); renderAll(); autosave timer (30s).
// bindEvents()/renderAll() have no React equivalent to call here — event
// binding is per-component and the initial render happens once boot resolves.
import { initZoho, getLoggedInEmail, hasZohoTransport, getZohoTransportDiagnostics } from "../api/zoho.js";
import { applicationData, state } from "../store/runtime.js";
import { loadDraft, autoSave } from "../core/drafts.js";
import { loadDynamicProducts } from "../api/products.js";
import { loadPortalCustomerData } from "../api/portal.js";

export async function bootstrap() {
  state.applicationsLoading = true;
  try {
    loadDraft();
    await initZoho();
    state.isZohoReady = hasZohoTransport();

    const loggedInEmail = await getLoggedInEmail();
    if (loggedInEmail) {
      applicationData.crmSync.loggedInEmail = loggedInEmail;
      if (!applicationData.customer.email) applicationData.customer.email = loggedInEmail;
    }

    await loadDynamicProducts();
    await loadPortalCustomerData();

    if (!state.autosaveTimer) state.autosaveTimer = setInterval(autoSave, 30000);
    console.log("[Winny] Boot transport diagnostics:", getZohoTransportDiagnostics());
    return { loggedInEmail, isZohoReady: state.isZohoReady };
  } finally {
    state.applicationsLoading = false;
  }
}
