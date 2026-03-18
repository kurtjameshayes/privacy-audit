# Policy Advisor Feature

## Upstream API

`POST /api/compliance/suggest-policy` on the upstream Web Gather API accepts:

**SuggestPolicyRequest** (all required):

- `policy_text` — current policy text to revise
- `gap_analysis_text` — the gap finding describing the compliance gap
- `gap_analysis_match` — status string (e.g. `missing`, `conflict`, `partial`)
- `statute_text` — the statute text the policy must comply with

**SuggestPolicyResponse:**

- `suggested_policy_text` — full revised policy text
- `modifications_description` — plain-language summary of changes
- `analyzed_at` — ISO8601 timestamp

## Data Mapping: GapItem to Request

Each gap item from a run detail contains the fields we need:

- `policy_text` ← `gap.policy_chunk_text`
- `gap_analysis_text` ← `gap.conflict_description`
- `gap_analysis_match` ← `gap.status` (`missing`, `conflict`, `partial`, etc.)
- `statute_text` ← `gap.statute_chunk_text`

## Changes

### 1. Backend proxy route — `backend/app.py`

Add a new Flask route `POST /api/compliance/suggest-policy` that:

- Accepts `{ policy_text, gap_analysis_text, gap_analysis_match, statute_text }`
- Validates all four required fields
- Calls `forward_post("/api/compliance/suggest-policy", body)`
- Returns the upstream response

Insert after the existing `/api/compliance/risk-assessment` route (~line 1089).

### 2. New page component — `frontend/src/pages/AdvisorPage.tsx` (new file)

**Menu item:** "Policy Advisor" with description "AI-suggested rewrites to close gaps" and the `Lightbulb` icon from lucide-react.

**Page layout (single column, step-by-step flow):**

- **Step 1 — Select a Gap Analysis Run:** Fetch runs from `/api/compliance/runs?types=gap_analysis` on mount. Display a list of gap analysis runs (company name, date, summary badges). Clicking one loads its detail via `/api/compliance/runs/{run_id}`.
- **Step 2 — Select a Gap Item:** Once a run is loaded, display its non-addressed gap items (status = `missing`, `partial`, `conflict`). Each gap card shows requirement summary, status badge, jurisdiction. User clicks one to select it.
- **Step 3 — Generate Suggestion:** With a gap item selected, show a preview of the mapped fields (policy text snippet, statute text snippet, gap finding). A "Generate Suggestion" button calls `POST /api/compliance/suggest-policy` with the mapped payload.
- **Step 4 — Display Result:** Show the response:
  - `modifications_description` in a highlighted summary card
  - `suggested_policy_text` in a styled text block (with a copy button)
  - `analyzed_at` timestamp

### 3. Navigation and routing

**`frontend/src/components/Layout.tsx`:** Add entry to `navItems` array (insert after "Compliance Analysis"):

```
{ to: "/advisor", label: "Policy Advisor", desc: "AI-suggested rewrites to close gaps", icon: Lightbulb }
```

Also add `Lightbulb` to the lucide-react imports.

**`frontend/src/App.tsx`:** Add route and import:

```
import AdvisorPage from "./pages/AdvisorPage";
...
<Route path="advisor" element={<AdvisorPage />} />
```

### 4. TypeScript types — `frontend/src/types/api.ts`

Add interfaces:

```typescript
export interface SuggestPolicyRequest {
  policy_text: string;
  gap_analysis_text: string;
  gap_analysis_match: string;
  statute_text: string;
}

export interface SuggestPolicyResponse {
  suggested_policy_text?: string;
  modifications_description?: string;
  analyzed_at?: string;
}
```
