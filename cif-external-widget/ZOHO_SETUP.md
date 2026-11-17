# Zoho Creator Setup — CIF External Widget

The external CIF widget uses a **dedicated** form and two Deluge workflows,
completely separate from `Portal_CRM_Request`.

---

## Step 1 — Create the form `CIF_External_Request`

In Zoho Creator → your app (`hiren-patel`) → Forms → New Form.

**Form name (link name):** `CIF_External_Request`

| Field Label         | Field API Name  | Field Type        | Notes                                 |
|---------------------|-----------------|-------------------|---------------------------------------|
| Request Type        | Request_Type    | Single Line       | "Get CIF Prefill Data" or "Submit CIF External" |
| Status              | Status          | Single Line       | Workflow writes: "Pending" / "Success" / "Failed" |
| CRM Deal ID         | CRM_Deal_ID     | Single Line       | Deal ID from the portal URL param     |
| Payload             | Payload         | Multi Line        | JSON sent by the widget               |
| CRM Response        | CRM_Response    | Multi Line        | JSON written back by Deluge           |
| Error Message       | Error_Message   | Single Line       | Written by Deluge on failure          |

---

## Step 2 — Create the report `CIF_External_Request_Report`

In Zoho Creator → Reports → New Report from `CIF_External_Request`.

- **Report link name:** `CIF_External_Request_Report`
- Include all fields (the widget uses `getRecordById` to poll by ID)
- Enable **Publish** (required for PUBLISH SDK access)

---

## Step 3 — Publish the form and report

For each (form & report):
1. Go to **Share → Publish**
2. Enable "Allow public access via private link"
3. Copy the generated private link

Paste each private link into `widget.html`:
```js
var FORM_PRIVATE_LINK   = "PASTE_FORM_PRIVATE_LINK_HERE";
var REPORT_PRIVATE_LINK = "PASTE_REPORT_PRIVATE_LINK_HERE";
```

---

## Step 4 — Workflow 1: `Get CIF Prefill Data`

**Trigger:** On Add, when `Request_Type == "Get CIF Prefill Data"`

```deluge
// Parse inputs
payloadMap  = Payload.toLong().toMap();   // or JSON.parse equivalent
travellerId = payloadMap.get("Traveller_ID");
cifType     = payloadMap.get("CIF_Type");

// Look up the CRM Deal
dealRecords = zoho.crm.getRecordById("Deals", CRM_Deal_ID.toLong());

// --- Build prefill data ---
// Extract traveller info (name, email, DOB) from the CRM deal
// Find the matching traveller in the deal's Travellers submodule
travellerName = "";
prefillF1     = Map();
prefillF2     = Map();
prefillF3     = Map();

travellers = dealRecords.get("Travellers");
for each t in travellers {
  if (t.get("local_id") == travellerId || t.get("ID") == travellerId) {
    travellerName = t.get("Full_Name") + "";
    // Pre-fill passport number, DOB, name from CRM traveller record
    prefillF1.put("Your_name_as_printed_in_your_passport.first_name", t.get("First_Name") + "");
    prefillF1.put("Your_name_as_printed_in_your_passport.last_name",  t.get("Last_Name")  + "");
    prefillF1.put("Date_of_Birth",   t.get("Date_of_Birth") + "");
    prefillF1.put("Provide_Email_address", t.get("Email") + "");
  }
}

// Build the response JSON
response = Map();
response.put("travellerName", travellerName);
prefill  = Map();
prefill.put("f1", prefillF1);
prefill.put("f2", prefillF2);
prefill.put("f3", prefillF3);
response.put("prefill", prefill);

// Write back to the record
zoho.creator.updateRecord(
  "hpatel_winnyedu",
  "hiren-patel",
  "CIF_External_Request",
  ID,
  { "Status": "Success", "CRM_Response": response.toString() },
  "creatorconnection"
);
```

---

## Step 5 — Workflow 2: `Submit CIF External`

**Trigger:** On Add, when `Request_Type == "Submit CIF External"`

```deluge
// Parse inputs
payloadMap  = Payload.toLong().toMap();
travellerId = payloadMap.get("Traveller_ID");
f1Data      = payloadMap.get("f1");
f2Data      = payloadMap.get("f2");
f3Data      = payloadMap.get("f3");

// Save to UK_CIF_1 (Form 1 fields)
cif1Record = Map();
cif1Record.put("CRM_Deal_ID",  CRM_Deal_ID);
cif1Record.put("Traveller_ID", travellerId);
// Map f1Data fields → UK_CIF_1 fields
// (the field API names in f1Data match UK_CIF_1 field link names exactly)
for each key in f1Data.keys() {
  cif1Record.put(key, f1Data.get(key));
}
r1 = zoho.creator.addRecord("hpatel_winnyedu", "hiren-patel", "UK_CIF_1", cif1Record, "creatorconnection");
cif1Id = r1.get("ID");

// Save to UK_CIF_2 (Form 2 fields)
cif2Record = Map();
cif2Record.put("CRM_Deal_ID",  CRM_Deal_ID);
cif2Record.put("Traveller_ID", travellerId);
cif2Record.put("UK_CIF_1_ID",  cif1Id);  // link to form 1
for each key in f2Data.keys() {
  cif2Record.put(key, f2Data.get(key));
}
r2 = zoho.creator.addRecord("hpatel_winnyedu", "hiren-patel", "UK_CIF_2", cif2Record, "creatorconnection");
cif2Id = r2.get("ID");

// Save to UK_CIF_3 (Form 3 fields)
cif3Record = Map();
cif3Record.put("CRM_Deal_ID",  CRM_Deal_ID);
cif3Record.put("Traveller_ID", travellerId);
cif3Record.put("UK_CIF_1_ID",  cif1Id);
cif3Record.put("UK_CIF_2_ID",  cif2Id);  // link to form 2
for each key in f3Data.keys() {
  cif3Record.put(key, f3Data.get(key));
}
r3 = zoho.creator.addRecord("hpatel_winnyedu", "hiren-patel", "UK_CIF_3", cif3Record, "creatorconnection");

// Mark success
zoho.creator.updateRecord(
  "hpatel_winnyedu",
  "hiren-patel",
  "CIF_External_Request",
  ID,
  { "Status": "Success", "CRM_Response": "{\"cif1Id\":\"" + cif1Id + "\",\"cif2Id\":\"" + cif2Id + "\",\"cif3Id\":\"" + r3.get("ID") + "\"}" },
  "creatorconnection"
);
```

> **Note on subforms:** The widget sends subform arrays (siblings, previous passports,
> travel history etc.) inside `payload.subforms`. Add a loop in the workflow to save
> each subform array to the matching Creator subform field — e.g.
> `Siblings` subform → `cif2Record.put("Siblings", subformsMap.get("siblings"))`.

---

## Step 6 — Error handling in both workflows

Wrap the main logic in a try/catch and on error write:
```deluge
zoho.creator.updateRecord(
  "hpatel_winnyedu", "hiren-patel", "CIF_External_Request", ID,
  { "Status": "Failed", "Error_Message": e.toString() },
  "creatorconnection"
);
```

---

## Step 7 — Run npm run pack:cif and upload the zip

After pasting the private links:
```bash
npm run pack:cif
# → cif-external-widget.zip
```

Upload `cif-external-widget.zip` to Zoho Creator → Widgets → New Widget.

The hosted widget URL becomes the link the consultant shares with the traveller:
```
https://creatorapp.zoho.in/hpatel_winnyedu/hiren-patel/#Widget:CIF_External
  ?CRM_Deal_ID=<deal_id>&Traveller_ID=<local_traveller_id>
```
