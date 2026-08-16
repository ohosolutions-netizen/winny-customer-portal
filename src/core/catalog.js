// Product-catalog helpers — copied VERBATIM (source 14043-14219, view builders
// excluded). Pure: goal defs, filters, product card theme/icon/badge/tagline/fee,
// and description parsing.
import { packageCatalog } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";

    const GOAL_DEFS = [
      { key: "visit",    icon: "✈️",  label: "Visit & Travel",      sub: "UK, USA, Schengen...",   filter: (p) => /schengen|europe tourism|documented|usa.*b1.*b2|visitor/i.test(productSearchText(p)) },
      { key: "work",     icon: "💼",  label: "Work Abroad",          sub: "Germany GOC, OWP...",    filter: (p) => /goc|work permit|owp/i.test(productSearchText(p)) },
      { key: "pr",       icon: "🏠",  label: "Permanent Residency",  sub: "Australia, Canada...",   filter: (p) => /australia pr|canada pr/i.test(productSearchText(p)) },
      { key: "coaching", icon: "📚",  label: "Coaching & Language",  sub: "IELTS, German, PTE...",  filter: (p) => /ielts|german language|pte|toefl|interview prep/i.test(productSearchText(p)) }
    ];

    const ADDON_DEFS = ["Priority Processing within 7 Business Days","Visa Refusal Insurance","Specific Location","USA Priority Date Booking","Interview Preparation (5 Sessions)"];

    function getGoalProducts(goalKey) {
      const def = GOAL_DEFS.find(g => g.key === goalKey);
      if (!def) return [];
      return packageCatalog.filter(p => def.filter(p) && p.category !== "Add on");
    }

    function productSearchText(product) {
      return [
        product.name,
        product.category,
        product.alias,
        product.code,
        ...(product.tags || [])
      ].filter(Boolean).join(" ");
    }

    function getAddonProducts() {
      return packageCatalog.filter(p => {
        const text = productSearchText(p).toLowerCase();
        return p.category === "Add on" || ADDON_DEFS.some(n => text.includes(n.slice(0,10).toLowerCase()));
      });
    }

    function getProductDescriptionBullets(pkg) {
      return String(pkg.desc || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(div|p|li)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\r/g, "\n")
        .replace(/\s+(\d+\))/g, "\n$1")
        .split(/\n|;|\u2022|\u2713|\u2714/g)
        .map(line => line.trim().replace(/^\d+\)\s*/, "").replace(/^-+\s*/, ""))
        .filter(line => line && !/^(stage|includes?)\s*:?$/i.test(line));
    }

    function getProductDescriptionLines(pkg) {
      return String(pkg.desc || "")
        .replace(/\r/g, "\n")
        .split(/\n|•|;|\u2713|\u2714/g)
        .map(line => line.trim().replace(/^\d+\)\s*/, "").replace(/^-+\s*/, ""))
        .filter(line => line && !/^(stage|includes?)\s*:?$/i.test(line));
    }

    function getProductCardTheme(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding|refusal|insurance/.test(text)) return "amber";
      if (/premium|priority|smartfile|pr|permanent|residency/.test(text)) return "indigo";
      if (/study|admission|complete|mobility|documented|visitor|schengen|visa/.test(text)) return "teal";
      return "blue";
    }

    function getProductCardIcon(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding/.test(text)) return "🏅";
      if (/admission|study|student/.test(text)) return "📨";
      if (/smartfile|document|visa|visitor|schengen/.test(text)) return "📋";
      if (/work|job|goc|owp|ausbildung/.test(text)) return "💼";
      if (/pr|permanent|residency/.test(text)) return "🏠";
      return "🌟";
    }

    function getProductCardBadge(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (pkg.alias) return pkg.alias;
      if (/complete|mobility|premium/.test(text)) return "Most Comprehensive";
      if (/scholar|funding/.test(text)) return "Scholarship Help";
      if (/admission/.test(text)) return "Admission Only";
      if (/smartfile|document/.test(text)) return "SmartFile";
      if (/priority/.test(text)) return "Priority";
      return pkg.category || "Package";
    }

    function getProductCardTagline(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding/.test(text)) return "Just the research report";
      if (/admission/.test(text)) return "Application support and shortlisting";
      if (/smartfile|document/.test(text)) return "Facilitation and documentation only";
      if (/work|job|goc|owp|ausbildung/.test(text)) return "Career and work pathway support";
      if (/pr|permanent|residency/.test(text)) return "Profile and nomination support";
      return "End-to-end application support";
    }

    function getProductFeeNote(pkg) {
      if (!pkg.price || pkg.price <= 0) return "No Winny service fee · third-party fees extra";
      return "Winny service fee · +18% GST · government/third-party fees extra";
    }

export {
  GOAL_DEFS, ADDON_DEFS, getGoalProducts, productSearchText, getAddonProducts,
  getProductDescriptionBullets, getProductDescriptionLines, getProductCardTheme,
  getProductCardIcon, getProductCardBadge, getProductCardTagline, getProductFeeNote
};
