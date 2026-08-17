// ─────────────────────────────────────────────────────────────────────────
// Runtime singletons — the mutable globals the original widget kept at module
// scope (applicationData, state). Exported as STABLE references and mutated in
// place so verbatim-ported logic can keep referencing them directly.
//
// blankApplication() and the state literal are copied VERBATIM (source 1925-2030).
// The original reassigned `applicationData = ...` in 6 places; those become
// replaceApplicationData(...) here — clear + assign — which is behaviour-identical
// but keeps the imported binding stable across modules.
// ─────────────────────────────────────────────────────────────────────────

export const blankApplication = () => ({
      applicationId: "",
      currentStep: 1,
      customer: {
        firstName: "", lastName: "", email: "", mobile: "",
        nationality:"", coordinatorName: "", coordinatorRelation: "",
        coordinator: null,
        mailingStreet: "", mailingCity: "", mailingState: "", mailingZip: "", mailingCountry:""
      },
      deal: {
        crmDealId: "", crmContactId: "", dealName: "", dealSavedToCRM: false,
        destination: "", goal: "", serviceTypeKey: "",
        serviceCountries: {},
        travellers: [],   // ← empty until deal saved; primary applicant seeded on save
        selectedServices: [], serviceBasket: [], selectedAddons: [],
        termsAccepted: false, signature: "",
        usaDateBooking: false,
        premiumVisaInterview: false,
        agreementHtml: "",
        agreementTemplateName: ""
      },
      payment: {
        status: "Pending", method: "", baseCost: 0, taxes: 0, addons: 0,
        grandTotal: 0, paymentMode: "Full", payableNow: 0, paidAmount: 0,
balanceAmount: 0, crmBalanceAmount: null,
        paymentLinkId: "", paymentLinkUrl: "", paidAt: ""
      },
      questionnaire: {
        // Section 1 - Trip
        applyingCountries:   "",   // multiselect → Applying_for_Country
        purpose:             [],   // What_is_the_purpose_of_your_visit — multi-select, array of keyspurpose:             "",   // What_is_the_purpose_of_your_visit
        purposeOther:        "",   // Please_describe_your_exact_purpose_of_visit
        functionType:        "",   // Please_indicate_the_type_of_function_you_will_attend
        maritalStatus:       "",   // Marital_Status
        arrangements:        "",   // Do_you_have_specific_travel_plans_or_a_pre_planned_itinerary
        travelDates:         {},   // {countryName: {entry, exit}}
        // Section 2 - Inviter
        inviter:             [],   // Who_is_inviting_you — multi-select, array of keys
        inviterRelation:     "",   // Is_the_inviter_related_to_you_directly_or_through_your_spouse
        inviterStatus:       "",   // What_is_the_inviter_s_immigration_status
        invitationLetter:    "",   // Do_you_have_or_will_you_have_invitation_letter_for_your_visit
        // Section 3 - Finance (per adult, keyed by traveller id)
        finance:             {},   // {travellerId: {funding, sponsorType, fundsRange, multiAnswers:{occ-*, asset-*, inv-*}, bizType, moreInfo, itr, otherAssetDesc, otherInvestment, spouseBizType, otherIncomeDesc}}
        // Section 4 - Ties
        ties:                {},   // {travellerId: [selected ties]}
        // Section 5 - Children (up to 3, mapped to fixed Child 1/2/3 slots at save time)
        childrenInfo:        {},   // {travellerId: {doing}}
        // Section 6 - Travel history (per traveller, mapped to Own/Spouse/Child N slots at save time)
        history:             {}    // {travellerId: {prevTravel, usaVisa, refusal, refusalDetail, border, borderDetail, criminalRecord, criminalDetail}}
      },
       // 29-Jul-2026: Data is separated by traveller and destination CIF instance.
      // cifData[travellerId].instances[instanceId].f1/f2/f3/f4
      cifData: {},
      // New multi-country Creator record IDs.
      // cifRecords[travellerId][instanceId]
      cifRecords: {},
      // Retained temporarily to migrate IDs from previously saved UK CIF records.
      // Creator CIF record IDs, persisted in localStorage
      cifSaveState: {},
      review: {},
      stepStatus: {
        dealCompleted: false, questionnaireCompleted: false,
        cifCompleted: false, submitted: false
      },
      crmSync: {
  loggedInEmail: "",
  requestId: "",
  lastSyncAt: "",
lastError: "",
applicationDetailsSynced: false,
applicationIds: []
},
      lastSavedAt: ""
    });

// Stable singleton — never reassigned; mutated in place via replaceApplicationData.
export const applicationData = blankApplication();

export const state = {
      isZohoReady: false,
      pendingConfirmCallback: null,
      activeView: "dashboard",
      portalApplications: [],
      localApplicationDrafts: [],
      applicationsLoading: true,
      applicationSelectionLoading: false,
      dealSubStep: 1,
      activeCifCategory: null,
      activeGenericCifCategory: null,
      activeCifTraveller: null,
      activeCifInstance: null,
      activeCifStage: null,
      cifSavedTravellerIds: new Set(),
      cifSaving: null,
      cifMetadata: {},
      cifMetadataLoading: {},
      cifMetadataErrors: {},
      autosaveTimer: null,
      activeGoal: null,          // which goal tile is open
      pendingPackageId: null,    // package selected but not yet basketed
      pendingAssignedTo: [],     // traveller IDs assigned to pending package
      refreshingCurrentDeal: false,
      documents: {
        items: [],               // [{id, name, requirement, status, reviewComments, travellerId, travellerName}]
        loading: false,
        loaded: false,
        loadedForDealId: null,
        uploadingId: null,       // Document record ID currently mid-upload, for per-row spinner
        viewingId: null          // Document record ID currently mid-view-fetch, for per-row spinner
      }
    };

// Replaces the original `applicationData = <newObj>` reassignments with an
// in-place swap that preserves the exported reference.
export function replaceApplicationData(source) {
  Object.keys(applicationData).forEach((k) => { delete applicationData[k]; });
  Object.assign(applicationData, source);
  return applicationData;
}
