// ─────────────────────────────────────────────────────────────────────────
// Product catalog loader — copied VERBATIM from the original widget.
// EXACT endpoints preserved (Products_Report via CREATOR.DATA.getRecords /
// getAllRecords / getRecords / invokeUrl REST, and the "Get Products" Deluge
// bridge). Mechanical change only: `packageCatalog = mapped` → in-place mutation
// so the exported live binding is preserved.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG, packageCatalog } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { parseJsonMaybe } from "../lib/utils.js";
import { getResponseRows, readZohoValue } from "./zoho.js";
import { submitPortalCrmRequest, pollCreatorRecord } from "./portal.js";

    async function loadDynamicProducts() {
      if (!window.ZOHO?.CREATOR) {
        console.warn("[Winny] Product catalog using fallback: Creator SDK unavailable.");
        return;
      }
      try {
        let rows = await fetchCreatorProducts();
        console.log("[Winny] Direct product rows:", rows.length);
        let mapped = rows.map(mapCreatorProductToCatalogItem).filter(Boolean);
        console.log("[Winny] Direct mapped product rows:", mapped.length);
        const directDescriptionCount = mapped.filter(p => String(p.desc || "").trim()).length;
        if (!mapped.length || directDescriptionCount === 0) {
          const portalRows = await fetchCreatorProductsViaPortalRequest();
          console.log("[Winny] Portal request product rows:", portalRows.length);
          const portalMapped = portalRows.map(mapCreatorProductToCatalogItem).filter(Boolean);
          console.log("[Winny] Portal mapped product rows:", portalMapped.length);
          const portalDescriptionCount = portalMapped.filter(p => String(p.desc || "").trim()).length;
          if (portalMapped.length && portalDescriptionCount >= directDescriptionCount) {
            rows = portalRows;
            mapped = portalMapped;
          }
        }
        console.log("[Winny] Mapped active product rows:", mapped.length);
        console.log("[Winny] Products with description:", mapped.filter(p => String(p.desc || "").trim()).length);
        if (!mapped.length) {
          console.warn("[Winny] Product catalog using fallback: Products_Report returned no active rows.");
          return;
        }
        packageCatalog.length = 0; packageCatalog.push(...mapped);
        pruneUnavailableProductSelections();
        console.log("[Winny] Product catalog loaded from Creator:", packageCatalog.length);
      } catch (error) {
        console.warn("[Winny] Product catalog using fallback:", error.message || error);
      }
    }

    async function fetchCreatorProducts() {
      const appName = CONFIG.creator.appLinkName;
      const reportName = CONFIG.creator.productReportLinkName;
      if (window.ZOHO?.CREATOR?.DATA?.getRecords) {
        const res = await ZOHO.CREATOR.DATA.getRecords({
  app_name: appName,
  report_name: reportName,
  max_records: 200,
  field_config: "all"
});

console.log("[Winny] Products_Report response:", JSON.stringify(res));

if (res?.code !== 3000) {
  throw new Error(
    res?.message ||
    `Products_Report returned code ${res?.code || "unknown"}`
  );
}
return getResponseRows(res);
      }
      if (window.ZOHO?.CREATOR?.API?.getAllRecords) {
        const res = await ZOHO.CREATOR.API.getAllRecords({
          appName,
          reportName,
          page: 1,
          pageSize: 200
        });
        return getResponseRows(res);
      }
      if (window.ZOHO?.CREATOR?.API?.getRecords) {
        const res = await ZOHO.CREATOR.API.getRecords({
          appName,
          reportName,
          page: 1,
          pageSize: 200
        });
        return getResponseRows(res);
      }
      if (window.ZOHO?.CREATOR?.API?.invokeUrl) {
        const res = await ZOHO.CREATOR.API.invokeUrl({
          url: `https://www.zohoapis.in/creator/v2.1/data/${CONFIG.creator.appOwner}/${appName}/report/${reportName}?from=1&limit=200`,
          type: "GET",
          connectionName: CONFIG.creatorConnectionName
        });
        return getResponseRows(res);
      }
      return [];
    }

    async function fetchCreatorProductsViaPortalRequest() {
      try {
        const creatorRecordId = await submitPortalCrmRequest("Get Products");
        if (!creatorRecordId) return [];
        const result = await pollCreatorRecord(creatorRecordId, 10, 1200);
        if (result.Status === "Failed") {
          console.warn("[Winny] Get Products request failed:", result.Error_Message || result.CRM_Response || result);
          return [];
        }
        const directRows = getResponseRows(result);
        if (directRows.length) return directRows;
        const response = parseJsonMaybe(
          result.CRM_Response ||
          result.Document_Checklist_JSON ||
          result.Products_JSON ||
          result.Payload ||
          result.products ||
          result.Products ||
          ""
        );
        if (Array.isArray(response)) return response;
        if (Array.isArray(response?.products)) return response.products;
        if (Array.isArray(response?.Products)) return response.Products;
        return getResponseRows(response);
      } catch (error) {
        console.warn("[Winny] Get Products request unavailable:", error.message || error);
        return [];
      }
    }

    function mapCreatorProductToCatalogItem(row) {
      const normalizeKey = (key) => String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const productValue = (...keys) => {
        for (const key of keys) {
          if (row[key] !== undefined && row[key] !== null && row[key] !== "") return readZohoValue(row[key]);
          const normalized = normalizeKey(key);
          const actualKey = Object.keys(row).find(rowKey => normalizeKey(rowKey) === normalized);
          if (actualKey && row[actualKey] !== undefined && row[actualKey] !== null && row[actualKey] !== "") {
            return readZohoValue(row[actualKey]);
          }
        }
        return "";
      };
      const crmId = String(productValue("CRM_Product_ID", "CRM_Product_Id", "CRM Product ID", "CRM Product Id")).trim();
      const creatorId = String(row.ID || row.id || "").trim();
      const name = String(productValue("Product_Name", "Product Name", "Name")).trim();
      if (!name || (!crmId && !creatorId)) return null;

      const activeRaw = row.Is_Active ?? row["Is Active"];
      const active = activeRaw === undefined || activeRaw === null || activeRaw === "" ||
        activeRaw === true || String(activeRaw).toLowerCase() === "true" || String(activeRaw).toLowerCase() === "yes";
      if (!active) return null;

      const price = Number(String(productValue("Unit_Price", "Unit Price") || "0").replace(/[^0-9.-]/g, "")) || 0;
      const code = String(productValue("Product_Code", "Product Code")).trim();
      const category = normalizeProductCategory(
        productValue("Category") ||
        productValue("Product_Category", "Product Category") ||
        productValue("Product_Alias", "Product Alias") ||
        productValue("Alias_Subcategory", "Alias Subcategory") ||
        code ||
        ""
      );
      const desc = String(productValue(
        "Description",
        "Product_Description",
        "Product Description",
        "Service_Description",
        "Service Description"
      ) || "").trim();
      if (/Australia PR.*Stage\s*2/i.test(name)) {
        console.log("[Winny] Australia Stage 2 product debug:", {
          keys: Object.keys(row),
          descriptionLength: desc.length,
          descriptionPreview: desc.slice(0, 160)
        });
      }
      const alias = String(productValue("Product_Alias", "Product Alias", "Alias_Subcategory", "Alias Subcategory") || "").trim();
      const destinationText = String(productValue(
        "Destination_Countries",
        "Destination Countries",
        "Destinations",
        "Countries",
        "Country",
        "Destination"
      ) || "").trim();
      const destinations = destinationText
        .split(/[,;|]/)
        .map(value => value.trim())
        .filter(Boolean);
      const serviceType = String(productValue(
        "Service_Type",
        "Service Type",
        "Service_Category",
        "Service Category",
        "Service",
        "Goal"
      ) || "").trim();
      const tags = [category, alias, code, serviceType, ...destinations].filter(Boolean);

      return {
        id: crmId || creatorId,
        crmId: crmId || creatorId,
        creatorId,
        name,
        category,
        price,
        desc,
        code,
        alias,
        serviceType,
        destinations,
        tags
      };
    }

    function normalizeProductCategory(value) {
      const raw = String(value || "").trim();
      if (!raw) return "Package";
      if (/add[\s-]?on|addon|priority|interview/i.test(raw)) return "Add on";
      return raw;
    }

    function pruneUnavailableProductSelections() {
      const availableIds = new Set(packageCatalog.map(p => p.id));
      const paymentStatus = String(applicationData.payment.status || "").trim().toLowerCase();
      const hasRecordedPayment =
        Number(applicationData.payment.paidAmount || 0) > 0 ||
        paymentStatus === "paid" ||
        paymentStatus === "partially paid";
      // A paid basket is historical transaction data. Keep it even if a
      // product is later disabled, removed, or returned under a different ID.
      if (hasRecordedPayment) {
        if (state.pendingPackageId && !availableIds.has(state.pendingPackageId)) {
          state.pendingPackageId = null;
          state.pendingAssignedTo = [];
        }
        return;
      }
      applicationData.deal.selectedServices = (applicationData.deal.selectedServices || []).filter(id => availableIds.has(id));
      applicationData.deal.selectedAddons = (applicationData.deal.selectedAddons || []).filter(id => availableIds.has(id));
      applicationData.deal.serviceBasket = (applicationData.deal.serviceBasket || []).filter(item => availableIds.has(item.pkgId));
      if (state.pendingPackageId && !availableIds.has(state.pendingPackageId)) {
        state.pendingPackageId = null;
        state.pendingAssignedTo = [];
      }
    }

export {
  loadDynamicProducts, fetchCreatorProducts, fetchCreatorProductsViaPortalRequest,
  mapCreatorProductToCatalogItem, normalizeProductCategory, pruneUnavailableProductSelections
};
