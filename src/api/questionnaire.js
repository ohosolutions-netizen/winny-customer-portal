// ─────────────────────────────────────────────────────────────────────────
// Questionnaire submit + save — per-traveller record model.
// saveQuestionnaire(familyId) creates ONE Creator record per traveller in
// the given unit (Primary Applicant, Spouse, Children, Others).
// submitQuestionnaire(familyId) is per-unit and only marks the step complete
// once every unit has been submitted.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { toast, showLoader, hideLoader, fail } from "../lib/ui.js";
import { saveDraft } from "../core/drafts.js";
import { showStep } from "../core/navigation.js";
import { scheduleDocumentChecklistRefresh } from "./documents.js";
import {
  validateQuestionnaireForCreator, isQuestionnaireChild, rerenderQuestionnaire,
  showQuestionnaireValidationSection, deriveQuestionnaireUnits, qState,
} from "../core/questionnaire.js";

// ── Choice-value maps (verified against live Visitor_Visa_Questionnaire_Sales1) ──
const purposeMap = {
  "family": "To meet Family Member / Relative", "family-func": "To attend family function",
  "tourism": "Tourism (customized itinerary)", "tourism-group": "Tourism (Group itinerary)",
  "business": "Business visit (Conference/Seminar/Meeting/Exhibition/Trade Fair/Site Visits/Receiving Training)",
  "friend": "To meet Friend", "convocation": "To attend convocation",
  "transit": "Transit", "medical": "Medical Treatment", "other": "Other (Please Specify)"
};
const functionTypeMap = { wedding:"Wedding", engagement:"Engagement", reception:"Reception", anniversary:"Anniversary", birthday:"Birthday", housewarming:"Housewarming" };
const maritalStatusMap = { single:"Single(Never Married)", married:"Married", divorced:"Divorced", widowed:"Widowed", separated:"Separated" };
const inviterRelationMap = { direct:"Directly related to me", spouse:"Related to my spouse" };
const inviterMap = {
  father:"Father ", mother:"Mother", brother:"Brother", sister:"Sister",
  son:"Son", daughter:"Daughter", uncle:"Uncle", aunt:"Aunt", cousin:"Cousin",
  grandson:"Grandson", granddaughter:"Granddaughter", husband:"Husband", wife:"Wife", grandparents:"Grandparents"
};
const inviterStatusMap = { citizen:"Citizen", pr:"Permanent Resident", work:"Work Visa Holder", student:"Student Visa Holder" };
const sponsorMap = {
  parent:"Parent (Father / Mother)", spouse:"Spouse (Husband / Wife)", sibling:"Sibling (Brother / Sister)",
  extended:"Extended Relative (Uncle,Aunt,Cousin)", employer:"Current Employee", event:"Event Organizers"
};
const fundsRangeMap = { "4-7l":"4 -7 Lakh INR", "7-10l":"7-10 Lakh INR", "10-15l":"10-15 Lakh INR", "15-20l":"15-20 Lakh INR", "20l-plus":"20 Lakh+ INR" };
const occMapPrimary = {
  "occ-employed":"Employed (Job)", "occ-freelancer":"Self employed (Freelancer)", "occ-business":"Business Owner",
  "occ-homemaker":"Homemaker", "occ-pensioner":"Retired with pension", "occ-retired-nopension":"Retired without pension",
  "occ-student":"Student", "occ-unemployed":"Unemployed", "occ-other":"Other (Please Specify)"
};
const occMapSpouse = {
  "occ-employed":"Employed (Job)", "occ-freelancer":"Self employed (Freelancer)", "occ-business":"Business Owner",
  "occ-pensioner":"Retired with Pension", "occ-student":"Student", "occ-homemaker":"Homemaker",
  "occ-retired-nopension":"Retired without Pension", "occ-other":"Other (Please Specify)"
};
// Unified biz type map (covers both bizType and spouseBizType keys)
const bizTypeMap = {
  sole:"Sole Proprietorship (Sole owner)", partnership:"Partnership",
  pvtltd:"Public, Private, or an LLP", pvtllp:"Public, Private, or an LLP"
};
const assetMap = {
  "asset-house":"House", "asset-shop":"Shop", "asset-office":"Office", "asset-building":"Building",
  "asset-flat":"Apartment", "asset-factory":"Factory", "asset-shed":"Shed", "asset-warehouse":"Warehouse",
  "asset-plot":"Plot", "asset-land":"Land", "asset-none":"None", "asset-other":"Other (Please Specify)"
};
const investMap = {
  "inv-stocks":"Stock Market", "inv-bank":"Bank Savings", "inv-fd":"FD (Fix deposits)", "inv-mf":"Mutual Funds",
  "inv-ppf":"PPF (Public Provident Fund)", "inv-epf":"EPF (Employee's Provident Fund)", "inv-bonds":"Bonds",
  "inv-gold":"Gold", "inv-postal":"Postal Certificate/Savings", "inv-none":"I do not have any investments",
  "inv-other":"Other (Please Specify)"
};
const tiesMap = {
  "housing":"Position in Housing society (Chairman/Secretory)",
  "social":"Holding position in social community (Samaj, Group etc.)",
  "bizassoc":"Holding position in business or trade association",
  "coop":"Holding position in Credit or Co-operative society",
  "vol":"Voluntary position in Hospital, Educational Institute, NGO",
  "religious":"Holding position in religious group, trust or temple",
  "service":"Holding position in service club like Lions Club, Jaycees, Rotary Club etc.",
  "member":"Active membership in any of the above",
  "none":"I don't have any position or membership in any of the above"
};
const doingOccMap = { preschool:"Student", school:"Student", college:"Student", infant:"" };
const doingLabelMap = { preschool:"Preschool / Nursery", school:"School Student", college:"College Student", infant:"Not Enrolled (Infant)" };

const mapMulti = (multiAnswers, map) =>
  Object.entries(map)
    .filter(([key]) => Boolean((multiAnswers || {})[key]))
    .map(([, value]) => String(value).trim());

const yesNo = (value) => value === "yes" ? "Yes" : value === "no" ? "No" : "";

const toZohoDate = (isoDate) => {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
  return `${day}-${month}-${d.getFullYear()}`;
};

// ── submitSingleRecord ─────────────────────────────────────────────────────
// Tries SDK v2 then SDK v1. Returns the Creator record ID string on success.
async function submitSingleRecord(recordData) {
  const formName = CONFIG.creator.formLinkNames.questionnaire;
  let lastError = null;

  if (window.ZOHO?.CREATOR?.DATA?.addRecords) {
    try {
      const res = await ZOHO.CREATOR.DATA.addRecords({
        app_name: CONFIG.creator.appLinkName,
        form_name: formName,
        payload: { data: recordData }
      });
      console.log("[Winny] SDK v2 questionnaire response:", JSON.stringify(res));
      if (Number(res?.code) === 3000 && res?.data?.ID) return res.data.ID;
      throw new Error(`Creator rejected record (${res?.code}): ${res?.message || JSON.stringify(res)}`);
    } catch (err) {
      lastError = err;
      console.error("[Winny] SDK v2 questionnaire save failed:", err);
    }
  }

  if (window.ZOHO?.CREATOR?.API?.addRecord) {
    try {
      const res = await ZOHO.CREATOR.API.addRecord({
        accountOwnerName: CONFIG.creator.appOwner,
        appLinkName: CONFIG.creator.appLinkName,
        formLinkName: formName,
        data: { data: recordData }
      });
      console.log("[Winny] SDK v1 questionnaire response:", JSON.stringify(res));
      if (Number(res?.code) === 3000 && res?.data?.ID) return res.data.ID;
      throw new Error(`Creator rejected record (${res?.code}): ${res?.message || JSON.stringify(res)}`);
    } catch (err) {
      lastError = err;
      console.error("[Winny] SDK v1 questionnaire save failed:", err);
    }
  }

  if (!window.ZOHO?.CREATOR?.DATA?.addRecords && !window.ZOHO?.CREATOR?.API?.addRecord) {
    throw new Error("Zoho Creator connection is unavailable. The questionnaire was saved only as a local draft and was not submitted.");
  }

  throw lastError || new Error("Zoho Creator did not create the questionnaire record.");
}

// ── saveQuestionnaire ──────────────────────────────────────────────────────
// Builds and submits one Creator record per traveller in the given unit.
// Returns an array of { travellerId, creatorRecordId }.
async function saveQuestionnaire(familyId) {
  if (!applicationData.deal.crmDealId) {
    throw new Error("CRM Deal ID is missing. Questionnaire cannot be linked to the correct Deal.");
  }
  saveDraft(false);

  const units = deriveQuestionnaireUnits();
  const unit = units.find(u => u.familyId === familyId) || units[0];
  if (!unit) throw new Error("No questionnaire unit found for familyId: " + familyId);

  const q    = applicationData.questionnaire;
  const fin  = q.finance || {};
  const hist = q.history || {};
  const ties = q.ties    || {};
  const isCorporate = String(applicationData.deal.applicationType || "").toLowerCase() === "corporate";
  const companyName = (q.common || {}).companyName || "";
  const gstNumber   = (q.common || {}).gstNumber   || "";

  const selectedPurposeKeys = Array.isArray(q.purpose) ? q.purpose : [];
  const hasFamilyPurpose    = selectedPurposeKeys.includes("family");
  const hasInviterPurpose   = selectedPurposeKeys.some(p => ["family","friend","family-func","convocation","business"].includes(p));

  const applyingCountries    = (q.applyingCountries || "").split(",").map(s => s.trim()).filter(Boolean);
  const questionnaireHasCanada = applyingCountries.some(c => c.toLowerCase() === "canada");
  const allTravelDateEntries = Object.values(q.travelDates || {}).filter(d => d && d.entry);
  const firstEntry           = allTravelDateEntries[0]?.entry || "";
  const lastExit             = allTravelDateEntries[allTravelDateEntries.length - 1]?.exit || "";
  const firstEntryZoho       = toZohoDate(firstEntry);
  const lastExitZoho         = toZohoDate(lastExit);
  const hasPreplanned        = q.arrangements === "yes";

  const inviterValues = hasFamilyPurpose
    ? (Array.isArray(q.inviter) ? q.inviter : []).map(k => inviterMap[k]).filter(Boolean)
    : [];

  // Q_Token: use the primary applicant's token for all records in this unit
  const unitPrimary = unit.travellers.find(t => t.type === "Primary Applicant") || unit.travellers[0] || {};
  const qToken = unitPrimary.qToken || (applicationData.deal.travellers || []).find(t => t.qToken)?.qToken || "";

  // Companion slots — list other unit members for context on primary record
  const allUnitTravellers = unit.travellers;
  const unitCompanions = allUnitTravellers.filter(t => t.id !== unitPrimary.id);
  const travellerSlots = [];
  const sp = allUnitTravellers.find(t => t.type === "Spouse");
  if (sp) travellerSlots.push({ trav: sp, relation: "Spouse" });
  allUnitTravellers.filter(isQuestionnaireChild).forEach((c, i) =>
    travellerSlots.push({ trav: c, relation: `Child ${i+1}` })
  );
  unitCompanions.filter(t => !travellerSlots.some(s => s.trav.id === t.id)).forEach(t => {
    if (travellerSlots.length < 4) travellerSlots.push({ trav: t, relation: "" });
  });
  const slotName     = i => travellerSlots[i] ? `${travellerSlots[i].trav.firstName||""} ${travellerSlots[i].trav.lastName||""}`.trim() : "";
  const slotRelation = i => travellerSlots[i] ? travellerSlots[i].relation : "";
  const companionCount = allUnitTravellers.filter(t => t.id !== unitPrimary.id).length;
  const totalCountVal  = companionCount === 0 ? "None" : String(Math.min(companionCount, 4));

  // ── Common fields shared across every per-traveller record ──────────────
  const primaryTravellerName = `${unitPrimary.firstName || ""} ${unitPrimary.lastName || ""}`.trim()
    || `${applicationData.customer.firstName || ""} ${applicationData.customer.lastName || ""}`.trim();
  const commonFields = {
    Client_Name: primaryTravellerName,
    CRM_ID:  applicationData.deal.crmDealId || "",
    Q_Token: qToken,
    Family_Group: familyId,
    Primary_Traveller_ID: unitPrimary.crmId || "",

    Applying_for_Country1: applyingCountries,
    Applying_for_Country:  applyingCountries[0] || "",
    What_is_the_purpose_of_your_visit: selectedPurposeKeys.map(p => purposeMap[p] || p),
    Please_describe_your_exact_purpose_of_visit: selectedPurposeKeys.includes("other") ? (q.purposeOther || "") : "",
    Do_you_have_specific_travel_plans_or_a_pre_planned_itinerary: hasPreplanned ? "Yes" : "No",
    Marital_Status: maritalStatusMap[q.maritalStatus] || "",
    Approx_Travel_Start_Date: firstEntryZoho,
    Approx_Travel_End_Date:   lastExitZoho,
    When_do_you_intend_to_travel:      !hasPreplanned ? firstEntryZoho : "",
    What_is_your_intended_travel_date:  hasPreplanned ? firstEntryZoho : "",
    Total_number_of_people_traveling_with_you: totalCountVal,

    ...(inviterValues.length ? { Who_is_inviting_you: inviterValues } : {}),
    Please_indicate_the_type_of_function_you_will_attend:
      selectedPurposeKeys.includes("family-func") ? (functionTypeMap[q.functionType] || "") : "",
    What_is_the_inviter_s_immigration_status:
      hasInviterPurpose ? (inviterStatusMap[q.inviterStatus] || "") : "",
    Do_you_have_or_will_you_have_invitation_letter_for_your_visit:
      hasInviterPurpose ? (q.invitationLetter === "yes" ? "Yes" : "No") : "",
    Is_the_inviter_related_to_you_directly_or_through_your_spouse:
      hasFamilyPurpose ? (inviterRelationMap[q.inviterRelation] || "") : "",

    // Corporate fields (empty string for non-corporate — Creator ignores blank values)
    ...(isCorporate && companyName ? { Company_Name: companyName } : {}),
    ...(isCorporate && gstNumber   ? {
      GST_Registration_Number: gstNumber,
      Description: `GST / Registration Number: ${gstNumber}`,
    } : {}),
  };

  // ── Build one record per traveller in this unit ─────────────────────────
  const results = [];

  for (const traveller of unit.travellers) {
    const tId      = traveller.id;
    const tFin     = fin[tId]  || {};
    const tHist    = hist[tId] || {};
    const tTiesM   = (ties[tId] || {}).multiAnswers || {};
    const tFinM    = tFin.multiAnswers || {};
    const isChild  = isQuestionnaireChild(traveller);
    const isPrimary = traveller.type === "Primary Applicant";
    const isSpouse  = traveller.type === "Spouse";

    const knownTypes = new Set(["Primary Applicant", "Spouse", "Child", "Friend", "Colleague", "Parent", "Other"]);
    const travellerType =
      isPrimary ? "Primary Applicant" :
      isSpouse  ? "Spouse" :
      isChild   ? "Child" :
      (knownTypes.has(traveller.type) ? traveller.type : "Other");

    const travellerName = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim();

    let perTravellerFields = {};

    if (isChild) {
      // Children: occupation from doing, skip finance/assets/investments/ties
      const childInfo = (q.childrenInfo || {})[tId] || {};
      const doing = childInfo.doing || "";
      perTravellerFields = {
        What_is_your_current_occupation: doingOccMap[doing] ? [doingOccMap[doing]] : [],
        Please_provide_more_information_about_selection: doingLabelMap[doing] || "",
        Own_Travel_History: yesNo(tHist.prevTravel),
        Do_you_currently_hold_valid_USA_Visa: questionnaireHasCanada ? yesNo(tHist.usaVisa) : "",
        Do_you_have_any_previous_visa_refusals: yesNo(tHist.refusal),
        Own_Entry_Refusal: yesNo(tHist.border),
        Provide_details_in_Refused_data: [
          tHist.refusal === "yes" && tHist.refusalDetail ? `Visa refusal: ${tHist.refusalDetail}` : "",
          tHist.border  === "yes" && tHist.borderDetail  ? `Border/immigration: ${tHist.borderDetail}` : "",
        ].filter(Boolean).join(" | "),
        Own_Criminal_Record: yesNo(tHist.criminalRecord),
        Provide_details_in_Criminal_Record: tHist.criminalRecord === "yes" ? (tHist.criminalDetail || "") : "",
      };

    } else if (isPrimary) {
      const fundingSelections = Array.isArray(tFin.funding) ? tFin.funding : (tFin.funding ? [tFin.funding] : []);
      const hasSponsor        = fundingSelections.includes("sponsor");
      const isBusinessOwner   = Boolean(tFinM["occ-business"]);
      const hasOtherOcc       = Boolean(tFinM["occ-other"]);
      const needsItr          = ["occ-employed","occ-freelancer","occ-pensioner","occ-business"].some(k => Boolean(tFinM[k]));
      const hasOtherAsset     = Boolean(tFinM["asset-other"]);
      const hasOtherInvest    = Boolean(tFinM["inv-other"]);

      perTravellerFields = {
        // Funding
        How_will_you_be_funding_your_trip: fundingSelections.map(v =>
          ({ sponsor:"Some one else will pay for me (sponsor or 3rd party)", inviter:"My Inviter", self:"Self-funded" })[v]
        ).filter(Boolean),
        Who_is_the_Financial_Sponsor: hasSponsor ? (sponsorMap[tFin.sponsorType] || "") : "",
        How_much_liquid_funds_available_to_you_to_support_your_trip: fundsRangeMap[tFin.fundsRange] || "",

        // Occupation
        What_is_your_current_occupation: mapMulti(tFinM, occMapPrimary),
        Please_provide_more_information_about_selection: hasOtherOcc ? (tFin.moreInfo || "") : "",
        Do_your_ITRs_from_the_last_two_years_reflect_your_current_occupation: needsItr
          ? (tFin.itr === "yes" ? "Yes" : tFin.itr === "notsure" ? "Not sure" : tFin.itr === "nofile" ? "I do not file ITR" : tFin.itr === "no" ? "No" : "")
          : "",
        What_type_of_business_do_you_own: isBusinessOwner ? (bizTypeMap[tFin.bizType] || "") : "",

        // Assets + investments
        Please_select_the_types_of_immovable_property_you_own_in_India: mapMulti(tFinM, assetMap),
        Please_provide_which_type_of_other_assets_do_you_own: hasOtherAsset ? (tFin.otherAssetDesc || "") : "",
        Please_select_what_kind_of_liquid_investment_you_hold: mapMulti(tFinM, investMap),
        Please_provide_which_type_of_other_investments_do_you_have: hasOtherInvest ? (tFin.otherInvestment || "") : "",

        // Ties
        Business_Data: mapMulti(tTiesM, tiesMap),

        // History
        Own_Travel_History: yesNo(tHist.prevTravel),
        Do_you_currently_hold_valid_USA_Visa: questionnaireHasCanada ? yesNo(tHist.usaVisa) : "",
        Do_you_have_any_previous_visa_refusals: yesNo(tHist.refusal),
        Own_Entry_Refusal: yesNo(tHist.border),
        Provide_details_in_Refused_data: [
          tHist.refusal === "yes" && tHist.refusalDetail ? `Visa refusal: ${tHist.refusalDetail}` : "",
          tHist.border  === "yes" && tHist.borderDetail  ? `Border/immigration: ${tHist.borderDetail}` : "",
        ].filter(Boolean).join(" | "),
        Own_Criminal_Record: yesNo(tHist.criminalRecord),
        Provide_details_in_Criminal_Record: tHist.criminalRecord === "yes" ? (tHist.criminalDetail || "") : "",

        // Companion context (primary record only)
        Traveller_1: slotName(0), Traveller_1_Relation: slotRelation(0),
        Traveller_2: slotName(1), Traveller_2_Relation: slotRelation(1),
        Traveller_3: slotName(2), Traveller_3_Relation: slotRelation(2),
        Traveller_4: slotName(3), Traveller_4_Relation: slotRelation(3),
      };

    } else if (isSpouse) {
      const isBusinessOwner = Boolean(tFinM["occ-business"]);
      const hasOtherOcc     = Boolean(tFinM["occ-other"]);
      const needsItr        = ["occ-employed","occ-freelancer","occ-pensioner","occ-business","occ-other"].some(k => Boolean(tFinM[k]));

      perTravellerFields = {
        // Spouse-specific occupation fields (for Deluge/reporting backward compat)
        Please_select_employment_source_of_income_of_your_spouse: mapMulti(tFinM, occMapSpouse),
        Please_select_your_spouse_s_ownership_type_in_business: isBusinessOwner ? (bizTypeMap[tFin.spouseBizType] || bizTypeMap[tFin.bizType] || "") : "",
        Do_your_spouse_s_ITRs_from_the_last_two_years_reflect_their_occupation: needsItr
          ? (tFin.itr === "yes" ? "Yes" : tFin.itr === "notsure" ? "Not sure" : tFin.itr === "nofile" ? "I do not file ITR" : tFin.itr === "no" ? "No" : "")
          : "",
        Please_describe_your_spouse_s_other_source_of_income_employment_which_is_not_listed_above: hasOtherOcc ? (tFin.otherIncomeDesc || "") : "",

        // Also populate primary occupation field for uniform per-traveller reporting
        What_is_your_current_occupation: mapMulti(tFinM, occMapSpouse),

        // Spouse history
        Has_your_spouse_ever_visited_any_country_other_than_their_country_of_nationality: yesNo(tHist.prevTravel),
        Does_your_spouse_hold_a_currently_valid_USA_Visa: questionnaireHasCanada ? yesNo(tHist.usaVisa) : "",
        Has_your_spouse_received_previous_visa_refusals: yesNo(tHist.refusal),
        "For_any_country_has_your_spouse_ever_been_refused_entry_at_the_border_deported_stayed_beyond_valid": yesNo(tHist.border),
        "Has_your_spouse_ever_had_any_criminal_convictions_driving_offences_outstanding_criminal_proceeding": yesNo(tHist.criminalRecord),
        Provide_details_in_Refused_data: [
          tHist.refusal === "yes" && tHist.refusalDetail ? `Visa refusal: ${tHist.refusalDetail}` : "",
          tHist.border  === "yes" && tHist.borderDetail  ? `Border/immigration: ${tHist.borderDetail}` : "",
        ].filter(Boolean).join(" | "),
        Provide_details_in_Criminal_Record: tHist.criminalRecord === "yes" ? (tHist.criminalDetail || "") : "",

        // Also set primary history fields so each record is self-contained
        Own_Travel_History: yesNo(tHist.prevTravel),
        Do_you_currently_hold_valid_USA_Visa: questionnaireHasCanada ? yesNo(tHist.usaVisa) : "",
      };

    } else {
      // Other companion types: minimal — just common trip data + whatever history they have
      perTravellerFields = {
        Own_Travel_History: yesNo(tHist.prevTravel),
        Do_you_currently_hold_valid_USA_Visa: questionnaireHasCanada ? yesNo(tHist.usaVisa) : "",
        Do_you_have_any_previous_visa_refusals: yesNo(tHist.refusal),
        Own_Entry_Refusal: yesNo(tHist.border),
        Provide_details_in_Refused_data: [
          tHist.refusal === "yes" && tHist.refusalDetail ? `Visa refusal: ${tHist.refusalDetail}` : "",
          tHist.border  === "yes" && tHist.borderDetail  ? `Border/immigration: ${tHist.borderDetail}` : "",
        ].filter(Boolean).join(" | "),
        Own_Criminal_Record: yesNo(tHist.criminalRecord),
        Provide_details_in_Criminal_Record: tHist.criminalRecord === "yes" ? (tHist.criminalDetail || "") : "",
      };
    }

    const recordData = {
      ...commonFields,
      Traveller_Type: travellerType,
      ...perTravellerFields,
    };

    console.log(`[Winny] Saving questionnaire record for ${travellerType} (${travellerName})`, JSON.stringify(recordData));

    const creatorRecordId = await submitSingleRecord(recordData);
    results.push({ travellerId: tId, creatorRecordId });
  }

  return results;
}

// ── submitQuestionnaire ────────────────────────────────────────────────────
// Per-unit submit. Marks step complete only when all units have been saved.
async function submitQuestionnaire(familyId = "family-1") {
  if (applicationData.stepStatus.questionnaireCompleted) {
    toast("This questionnaire has already been submitted and is locked.");
    rerenderQuestionnaire();
    return false;
  }

  const submittedUnits = applicationData.questionnaire.submittedUnits || {};
  if (submittedUnits[familyId]) {
    toast("This family's questionnaire has already been submitted.");
    rerenderQuestionnaire();
    return false;
  }

  if (state.submittingQuestionnaire) {
    toast("Questionnaire submission is already in progress.");
    return false;
  }

  state.submittingQuestionnaire = true;

  const validationError = validateQuestionnaireForCreator();
  if (validationError) {
    state.submittingQuestionnaire = false;
    showQuestionnaireValidationSection();
    return fail(validationError);
  }

  if (!applicationData.deal.crmDealId) {
    state.submittingQuestionnaire = false;
    return fail("No CRM Deal ID found. Please open the correct application or save the deal again before submitting the questionnaire.");
  }

  showLoader("Saving questionnaire…");

  try {
    const travellerResults = await saveQuestionnaire(familyId);

    // Persist unit completion
    if (!applicationData.questionnaire.submittedUnits) {
      applicationData.questionnaire.submittedUnits = {};
    }
    applicationData.questionnaire.submittedUnits[familyId] = true;

    // Mirror into qState so renderUnitOverviewHTML shows the done badge immediately
    qState.unitCompletions[familyId] = true;

    // Store record IDs
    if (!applicationData.questionnaire.creatorRecordIds) {
      applicationData.questionnaire.creatorRecordIds = {};
    }
    applicationData.questionnaire.creatorRecordIds[familyId] = travellerResults.map(r => r.creatorRecordId);

    // Backward-compat: set creatorRecordId to the primary applicant's record
    const primaryResult = travellerResults.find(r =>
      (applicationData.deal.travellers || []).find(t => t.id === r.travellerId && t.type === "Primary Applicant")
    ) || travellerResults[0];
    if (primaryResult) {
      applicationData.questionnaire.creatorRecordId = primaryResult.creatorRecordId;
    }

    // Mark that at least one unit has been submitted (unlocks Documents step)
    applicationData.stepStatus.anyQuestionnaireSubmitted = true;

    // Check if all units are now done
    const allUnits = deriveQuestionnaireUnits();
    const allDone  = allUnits.every(u => applicationData.questionnaire.submittedUnits[u.familyId]);

    if (allDone) {
      applicationData.questionnaire.countriesText = applicationData.questionnaire.applyingCountries || applicationData.deal.destination || "";
      applicationData.stepStatus.questionnaireCompleted = true;
      state.documents.items = [];
      state.documents.loaded = false;
      state.documents.loadedForDealId = null;
      saveDraft(false);
      toast("Questionnaire submitted ✓ CIF unlocked.");
      showStep(3);
      scheduleDocumentChecklistRefresh();
    } else {
      const remaining = allUnits.filter(u => !applicationData.questionnaire.submittedUnits[u.familyId]).length;
      saveDraft(false);
      toast(`Questionnaire submitted ✓ Document checklist unlocked. ${remaining} group${remaining === 1 ? "" : "s"} remaining.`);
      // Reset document list so it reloads fresh when user navigates to Documents
      state.documents.items = [];
      state.documents.loaded = false;
      state.documents.loadedForDealId = null;
      // Return to unit overview so the next unit can be started
      qState.viewMode = "auto";
      rerenderQuestionnaire();
    }

    return true;
  } catch (error) {
    console.error("[Winny] Questionnaire submit failed:", error);
    // Roll back optimistic state
    if (applicationData.questionnaire.submittedUnits) {
      delete applicationData.questionnaire.submittedUnits[familyId];
    }
    if (qState.unitCompletions) {
      delete qState.unitCompletions[familyId];
    }
    toast(`Questionnaire save failed: ${error.message || error}`);
    return false;
  } finally {
    state.submittingQuestionnaire = false;
    hideLoader();
  }
}

// ── checkExternalQuestionnaireSubmission ──────────────────────────────────
// Queries Creator directly for questionnaire records submitted via the
// external pre-fill link (bypassing the portal's submitQuestionnaire flow).
// Returns true if it changed applicationData (caller should requestRender).

function hasCreatorQueryApi() {
  return Boolean(
    window.ZOHO?.CREATOR?.DATA?.getRecords ||
    window.ZOHO?.CREATOR?.API?.invokeUrl ||
    window.ZOHO?.CREATOR?.API?.getRecords
  );
}

async function waitForCreatorApi(maxMs = 8000) {
  if (hasCreatorQueryApi()) return true;
  // Also attempt SDK init if ZOHO.CREATOR exists but wasn't init'd yet
  if (window.ZOHO?.CREATOR?.init) {
    try { await window.ZOHO.CREATOR.init(); } catch (_) {}
    if (hasCreatorQueryApi()) return true;
  }
  const step = 500;
  let waited = 0;
  while (waited < maxMs) {
    await new Promise(r => setTimeout(r, step));
    waited += step;
    if (window.ZOHO?.CREATOR?.init && !hasCreatorQueryApi()) {
      try { await window.ZOHO.CREATOR.init(); } catch (_) {}
    }
    if (hasCreatorQueryApi()) {
      console.log(`[Winny] Creator SDK became available after ${waited}ms`);
      return true;
    }
  }
  console.warn(`[Winny] Creator SDK still unavailable after ${maxMs}ms — skipping external questionnaire check`);
  return false;
}

async function checkExternalQuestionnaireSubmission(dealId) {
  if (applicationData.stepStatus.questionnaireCompleted) return false;
  if (!dealId) return false;

  // Wait for Creator SDK to initialise (widget SDK handshake can be slow)
  if (!await waitForCreatorApi()) return false;

  // Visitor_Visa_Questionnaire_Sales_Report1 includes both portal and external submissions.
  const reportName = "Visitor_Visa_Questionnaire_Sales_Report1";
  let records = [];

  try {
    // 1. SDK v2 getRecords (may or may not be available in all widget contexts)
    if (window.ZOHO?.CREATOR?.DATA?.getRecords) {
      const res = await ZOHO.CREATOR.DATA.getRecords({
        app_name: CONFIG.creator.appLinkName,
        report_name: reportName,
        criteria: `CRM_ID == "${dealId}"`
      });
      if (Number(res?.code) === 3000 && Array.isArray(res?.data)) records = res.data;
    }

    // 2. Creator REST API via invokeUrl — the proven transport used for CRM calls
    if (!records.length && window.ZOHO?.CREATOR?.API?.invokeUrl) {
      const criteria = encodeURIComponent(`CRM_ID == "${dealId}"`);
      const url = `https://creator.zoho.in/api/v2/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/report/${reportName}?criteria=${criteria}`;
      const res = await ZOHO.CREATOR.API.invokeUrl({
        url,
        type: "GET",
        connectionName: CONFIG.creatorConnectionName
      });
      const body = typeof res?.data === "string"
        ? (JSON.parse(res.data) || {})
        : (res?.data || res || {});
      if (Array.isArray(body?.data)) records = body.data;
    }

    // 3. SDK v1 getRecords with criteria
    if (!records.length && window.ZOHO?.CREATOR?.API?.getRecords) {
      const res = await ZOHO.CREATOR.API.getRecords({
        accountOwnerName: CONFIG.creator.appOwner,
        appLinkName: CONFIG.creator.appLinkName,
        reportLinkName: reportName,
        criteria: `CRM_ID == "${dealId}"`,
        fromIndex: 1,
        toIndex: 200
      });
      if (Array.isArray(res?.data)) records = res.data;
    }
  } catch (err) {
    console.warn("[Winny] checkExternalQuestionnaireSubmission: Creator query failed:", err);
    return false;
  }

  if (!applicationData.questionnaire.submittedUnits) {
    applicationData.questionnaire.submittedUnits = {};
  }

  const allUnits = deriveQuestionnaireUnits();
  let changed = false;

  function applyRecord(r, familyIdHint) {
    let fg = familyIdHint || String(r.Family_Group || r.family_group || "").trim();

    if (!fg) {
      // Try matching by Primary_Traveller_ID (CRM traveller record ID)
      const ptId = String(r.Primary_Traveller_ID || "").trim();
      if (ptId) {
        const matched = (applicationData.deal.travellers || []).find(t => t.crmId && String(t.crmId) === ptId);
        if (matched) fg = matched.familyId || matched.id || "";
      }
    }

    if (!fg) {
      // Try matching by Client_Name / Traveller_Name
      const recordName = String(r.Client_Name || r.Traveller_Name || "").trim().toLowerCase();
      if (recordName) {
        const matched = (applicationData.deal.travellers || []).find(t => {
          const tName = `${t.firstName || ""} ${t.lastName || ""}`.trim().toLowerCase();
          return tName && (tName === recordName || recordName.includes(tName) || tName.includes(recordName));
        });
        if (matched) fg = matched.familyId || matched.id || "";
      }
    }

    if (!fg) {
      // Final fallback: first unsubmitted unit
      const firstOpen = allUnits.find(u =>
        !applicationData.questionnaire.submittedUnits[u.familyId] &&
        !(u.primaryTraveller?.id && applicationData.questionnaire.submittedUnits[u.primaryTraveller.id])
      );
      fg = firstOpen?.familyId || "family-1";
    }

    if (fg && !applicationData.questionnaire.submittedUnits[fg]) {
      applicationData.questionnaire.submittedUnits[fg] = true;
      if (qState.unitCompletions) qState.unitCompletions[fg] = true;
      changed = true;
    }
  }

  if (records.length) {
    console.log(`[Winny] Found ${records.length} questionnaire record(s) by CRM_ID for deal ${dealId}`);
    records.forEach(r => applyRecord(r, null));
  }

  // For units still pending, try further lookups — Q_Token then Traveller_Name / Client_Name.
  // This catches records where CRM_ID wasn't saved (admin-entered or URL pre-fill field not configured).
  async function creatorQuery(criteria) {
    if (window.ZOHO?.CREATOR?.DATA?.getRecords) {
      const res = await ZOHO.CREATOR.DATA.getRecords({
        app_name: CONFIG.creator.appLinkName,
        report_name: reportName,
        criteria
      });
      console.log(`[Winny] creatorQuery SDK v2 criteria="${criteria}" code=${res?.code} count=${res?.data?.length}`);
      if (Number(res?.code) === 3000 && Array.isArray(res?.data) && res.data.length) return res.data;
    }
    if (window.ZOHO?.CREATOR?.API?.invokeUrl) {
      const url = `https://creator.zoho.in/api/v2/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/report/${reportName}?criteria=${encodeURIComponent(criteria)}`;
      const res = await ZOHO.CREATOR.API.invokeUrl({ url, type: "GET", connectionName: CONFIG.creatorConnectionName });
      const body = typeof res?.data === "string" ? (JSON.parse(res.data) || {}) : (res?.data || res || {});
      console.log(`[Winny] creatorQuery invokeUrl criteria="${criteria}" count=${body?.data?.length}`);
      if (Array.isArray(body?.data) && body.data.length) return body.data;
    }
    if (window.ZOHO?.CREATOR?.API?.getRecords) {
      const res = await ZOHO.CREATOR.API.getRecords({
        accountOwnerName: CONFIG.creator.appOwner,
        appLinkName: CONFIG.creator.appLinkName,
        reportLinkName: reportName,
        criteria,
        fromIndex: 1,
        toIndex: 10
      });
      console.log(`[Winny] creatorQuery SDK v1 criteria="${criteria}" count=${res?.data?.length}`);
      if (Array.isArray(res?.data) && res.data.length) return res.data;
    }
    return [];
  }

  const pendingUnits = allUnits.filter(u => !applicationData.questionnaire.submittedUnits[u.familyId]);
  console.log(`[Winny] ${pendingUnits.length} unit(s) still pending external check`);
  for (const unit of pendingUnits) {
    // 1. Q_Token lookup (traveller filled via link)
    const token = unit.travellers.find(t => t.qToken)?.qToken;
    if (token) {
      try {
        const rows = await creatorQuery(`Q_Token == "${token}"`);
        if (rows.length) {
          console.log(`[Winny] Found questionnaire record by Q_Token for unit ${unit.familyId}`);
          applyRecord(rows[0], unit.familyId);
          continue;
        }
      } catch (e) {
        console.warn(`[Winny] Q_Token lookup failed for unit ${unit.familyId}:`, e);
      }
    }

    // 2. Primary_Traveller_ID lookup (portal-saved records carry the CRM traveller record ID)
    const primary = unit.primaryTraveller;
    const travCrmId = primary?.crmId || "";
    if (travCrmId) {
      try {
        const rows = await creatorQuery(`Primary_Traveller_ID == "${travCrmId}"`);
        if (rows.length) {
          console.log(`[Winny] Found questionnaire record by Primary_Traveller_ID for unit ${unit.familyId}`);
          applyRecord(rows[0], unit.familyId);
          continue;
        }
      } catch (e) {
        console.warn(`[Winny] Primary_Traveller_ID lookup failed for unit ${unit.familyId}:`, e);
      }
    }

    // 3. Client_Name lookup (admin-entered records that lack Primary_Traveller_ID)
    const tName = `${primary?.firstName || ""} ${primary?.lastName || ""}`.trim();
    console.log(`[Winny] Checking unit ${unit.familyId} by name "${tName}"`);
    if (tName) {
      try {
        // Scope to this deal first; fall back to name-only if no match (admin records may lack CRM_ID)
        let rows = dealId ? await creatorQuery(`CRM_ID == "${dealId}" && Client_Name == "${tName}"`) : [];
        if (!rows.length) rows = await creatorQuery(`Client_Name == "${tName}"`);
        if (rows.length) {
          console.log(`[Winny] Found questionnaire record by name "${tName}" for unit ${unit.familyId}`);
          applyRecord(rows[0], unit.familyId);
        } else {
          console.warn(`[Winny] No questionnaire record found by name "${tName}" for unit ${unit.familyId}`);
        }
      } catch (e) {
        console.warn(`[Winny] Name lookup failed for unit ${unit.familyId}:`, e);
      }
    }
  }

  if (changed || !applicationData.stepStatus.anyQuestionnaireSubmitted) {
    applicationData.stepStatus.anyQuestionnaireSubmitted = true;
    changed = true;
  }

  const allDone = allUnits.length === 0 ||
    allUnits.every(u => applicationData.questionnaire.submittedUnits[u.familyId]);

  if (allDone && !applicationData.stepStatus.questionnaireCompleted) {
    applicationData.stepStatus.questionnaireCompleted = true;
    const firstWithId = records.find(r => r.ID);
    if (firstWithId && !applicationData.questionnaire.creatorRecordId) {
      applicationData.questionnaire.creatorRecordId = String(firstWithId.ID);
    }
    changed = true;
  }

  if (changed) saveDraft(false);
  return changed;
}

// ── fetchQCreatorRecord ────────────────────────────────────────────────────
// Fetches all questionnaire records for the deal, then returns the best match
// for the given unit key (familyId/id). Falls back to name matching so external
// pre-fill submissions (which may have a different Family_Group value) are found.
// After finding the right record, fetches it again by ID against the form (not
// the report) so ALL form fields are returned, not just the report's columns.
async function fetchQCreatorRecord(dealId, unitKey) {
  if (!dealId) return null;
  const reportName = "Visitor_Visa_Questionnaire_Sales_Report1";
  const formName   = CONFIG.creator.formLinkNames.questionnaire;
  let allRecords = [];

  try {
    // SDK v2: res = { code: 3000, data: [...records] }
    if (window.ZOHO?.CREATOR?.DATA?.getRecords) {
      const res = await ZOHO.CREATOR.DATA.getRecords({
        app_name: CONFIG.creator.appLinkName,
        report_name: reportName,
        criteria: `CRM_ID == "${dealId}"`,
        sort_by: "Added_Time",
        sort_order: "desc",
        page: 1,
        page_size: 50
      });
      if (Number(res?.code) === 3000 && Array.isArray(res?.data)) allRecords = res.data;
    }

    // invokeUrl: res.data is JSON string or { code, data: [...records] }
    if (!allRecords.length && window.ZOHO?.CREATOR?.API?.invokeUrl) {
      const url = `https://creator.zoho.in/api/v2/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/report/${reportName}?criteria=${encodeURIComponent(`CRM_ID == "${dealId}"`)}&sort_by=Added_Time&sort_order=desc&page=1&page_size=50`;
      const res = await ZOHO.CREATOR.API.invokeUrl({ url, type: "GET", connectionName: CONFIG.creatorConnectionName });
      const body = typeof res?.data === "string" ? (JSON.parse(res.data) || {}) : (res?.data || res || {});
      if (Array.isArray(body?.data)) allRecords = body.data;
    }
  } catch (err) {
    console.warn("[Winny] fetchQCreatorRecord: Creator query failed:", err);
  }

  if (!allRecords.length) return null;

  // Find best-matching record (report gives us the ID; then we re-fetch by ID for full fields)
  let matched = null;

  // 1. Exact Family_Group match
  matched = allRecords.find(r => String(r.Family_Group || "").trim() === unitKey) || null;

  // 2. Name match — look up the traveller for this unit and match by Client_Name
  if (!matched && unitKey) {
    const traveller = (applicationData.deal.travellers || []).find(
      t => (t.id || t.familyId || "family-1") === unitKey
    );
    if (traveller) {
      const tFirst = (traveller.firstName || "").trim().toLowerCase();
      const tLast  = (traveller.lastName  || "").trim().toLowerCase();
      matched = allRecords.find(r => {
        const rName = String(r.Client_Name || "").trim().toLowerCase();
        return rName && tFirst && (rName.includes(tFirst) || (tLast && rName.includes(tLast)));
      }) || null;
    }
  }

  // 3. Single record — use it regardless
  if (!matched && allRecords.length === 1) matched = allRecords[0];

  // 4. For "family-1" default units, use the record with empty/missing Family_Group
  if (!matched && (!unitKey || unitKey === "family-1")) {
    matched = allRecords.find(r => !String(r.Family_Group || "").trim()) || null;
  }

  if (!matched) return null;

  // Re-fetch by record ID with field_config=all to get every form field.
  // Default field_config is "quick_view" which only returns visible columns.
  const recordId = String(matched.ID || matched.id || "").trim();
  if (!recordId) return matched;

  try {
    // SDK v2 getRecordById — report_name + field_config:"all" returns every field
    if (window.ZOHO?.CREATOR?.DATA?.getRecordById) {
      const res = await ZOHO.CREATOR.DATA.getRecordById({
        app_name: CONFIG.creator.appLinkName,
        report_name: reportName,
        id: recordId,
        field_config: "all"
      });
      if (Number(res?.code) === 3000 && res?.data && typeof res.data === "object") {
        console.log(`[Winny] fetchQCreatorRecord: full record via getRecordById (${Object.keys(res.data).length} fields)`);
        return res.data;
      }
    }

    // invokeUrl fallback: REST API with field_config=all
    if (window.ZOHO?.CREATOR?.API?.invokeUrl) {
      const url = `https://creator.zoho.in/api/v2/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/report/${reportName}/${recordId}?field_config=all`;
      const res = await ZOHO.CREATOR.API.invokeUrl({ url, type: "GET", connectionName: CONFIG.creatorConnectionName });
      const body = typeof res?.data === "string" ? (JSON.parse(res.data) || {}) : (res?.data || res || {});
      const rec = body?.data;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        console.log(`[Winny] fetchQCreatorRecord: full record via invokeUrl (${Object.keys(rec).length} fields)`);
        return rec;
      }
    }
  } catch (err) {
    console.warn("[Winny] fetchQCreatorRecord: by-ID fetch failed, falling back to list record:", err);
  }

  return matched;
}

export { submitQuestionnaire, saveQuestionnaire, checkExternalQuestionnaireSubmission, fetchQCreatorRecord };
