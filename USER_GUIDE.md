# SafeTrack — Church Donation Vault
## Application Overview, User Manual & Handover Guide

---

## 1. What SafeTrack Is

**SafeTrack** is a local-first church donation counting, auditing, and reporting application. It is designed for church tellers, envelope stewards, treasurers, and administrators to:

- Maintain a **Giver Registry** with envelope numbers, joint/spouse names, addresses, and digital giving IDs (e-Transfer & PushPay).
- Record weekly **Donation Batches** (cash, cheques, and e-transfers) with multi-fund splits and internal account tracking.
- Enforce **Dual-Teller Controls** so non-administrators must count and sign off in pairs.
- Perform a **Blind Cash & Cheque Audit** before locking a batch.
- Generate, print, download as PDF, and email three standardized reports:
  1. **Accounting Summary Report**
  2. **Envelope Steward's Report** (including newly created envelopes)
  3. **Bank Deposit Slip** (with teller/admin signature lines)
- Back up and restore the entire vault as a single portable JSON file.

---

## 2. Important Architecture & Data Storage Notes

Before operating or moving SafeTrack to another computer, understand how data is stored:

1. **Browser-Local Database (IndexedDB via Dexie.js):**
   - All records (`users`, `givers`, `batches`, `donations`, `funds`, `internalAccounts`, `settings`) are stored locally inside the browser's IndexedDB (`SafeTrackDB`) on the computer being used.
   - **Data does not automatically sync across computers or browsers.**
   - **Clearing browser site data/cache will erase the database** unless you have a backup.
2. **Backend Server (`server.ts`):**
   - An Express server runs on port `3000` to serve the application and handle **SMTP email delivery** (`POST /api/send-email`) for sending PDF reports.
3. **Golden Rule — Back Up Regularly:**
   - Always use **Admin / Backup → Generate Backup** after finishing a counting session and save the `.json` file to a secure drive or cloud folder.

---

## 3. User Roles & Security Model

### Roles
| Role | Capabilities |
| :--- | :--- |
| **Administrator** | Full access. Can log in alone, manage users (`/admin/users`), unlock finalized batches for adjustments, configure settings, and run backups/restores. |
| **Teller** | Counts batches, creates/edits open batches, performs audits, and generates/emails reports. **Requires a second user logged in.** |
| **Treasurer** | Same operational access as Teller (intended for financial oversight/reporting). **Requires a second user logged in.** |
| **Envelope** | Same operational access as Teller (intended for envelope stewards). **Requires a second user logged in.** |

### First-Time Setup
- When SafeTrack is opened on a fresh database with zero users, it automatically displays the **Initial Setup** screen.
- The first account created is automatically assigned the **Administrator** role.

### Dual-Teller Login & Shared-Laptop Security
- If a **Teller**, **Treasurer**, or **Envelope** user logs in first, SafeTrack immediately prompts for a **Second Teller** to sign in with a different username and password before unlocking the vault.
- **No Saved Passwords:** Login forms explicitly disable browser autocomplete/remember-password behavior so multiple tellers can safely share one laptop.
- **Changing Passwords:** Any currently logged-in user (or pair of tellers) can change their password at any time by clicking **Change Passwords** at the bottom of the left sidebar.
- **Locking the Vault:** Clicking **Lock Vault** in the sidebar immediately logs out both active users.

---

## 4. Initial Configuration (Admin Settings)

Navigate to **Admin / Backup** in the sidebar to configure the system before your first Sunday count:

1. **System Configuration**
   - **Next Auto-Increment Envelope #:** Sets the starting envelope number assigned when registering new givers (defaults to `100`).
2. **Banking & Organization Details**
   - **Bank Details:** Upload Bank Logo (250×150px recommended), Account Of, Branch #, and Account #. These appear on the **Bank Deposit Slip**.
   - **Organization Details:** Upload Church Logo and enter 3 lines of Church Address. These appear on reports and deposit slips.
3. **Email & SMTP Configuration**
   - Configure `SMTP Host`, `SMTP Port` (`465` for SSL or `587` for STARTTLS), `SMTP Username`, `SMTP Password`, and `From Email Address`.
   - Set comma-separated default recipients for:
     - **Accounting Report Recipients**
     - **Envelope Report Recipients**
     - **Bank Deposit Slip Recipients**
4. **Fund Designation Management**
   - Default system funds included on initialization: `General`, `Benevolent`, `Missions`, `Building`, `Capital`, `Interns`, and `Internal`.
   - Add custom funds or toggle any fund active/inactive (inactive funds are hidden from new batch entries without affecting historical reports).
5. **Internal Accounts Management**
   - Add internal account codes (e.g., ministry sub-accounts or pass-through codes). When a donation is allocated to the **`Internal`** fund, tellers select or type an Internal Account code.
6. **User Management** *(Administrators only)*
   - Navigate to **User Management** in the sidebar to add, edit, change roles, reset passwords, or delete teller/steward accounts.

---

## 5. Step-by-Step Operational Workflow

### Step A: Managing the Giver Registry
Go to **Giver Registry** in the sidebar:
- **Search:** Filter givers by Name, Joint/Spouse Name, Envelope #, or e-Transfer ID.
- **Register New Giver:** Click **Register New Giver**. The next envelope number is assigned automatically. You can record:
  - Primary Name & Joint/Spouse Name
  - Primary & Secondary Email
  - Mailing Address (3 lines)
  - Primary & Secondary e-Transfer IDs (email or phone) and PushPay ID
- **Edit Giver:** Hover over any giver card and click the pencil icon to update their details.
- **Bulk Export / Import (CSV):** Under **Admin / Backup → Giver Registry Management**, you can **Export CSV** to edit givers in Excel/Google Sheets, and **Import CSV** to reload them.
  > **Warning:** Importing a CSV **replaces** the entire existing Giver Registry. Required CSV columns are `Envelope Number` and `Name`.

---

### Step B: Entering a Batch (`New Batch`)
Go to **New Batch** in the sidebar:

1. **Set Batch Date:** Confirm or adjust the **Batch Date** at the top of the grid.
2. **Enter Each Donation Row:**
   - **Giver Lookup:** Type an envelope number, name, spouse name, or e-Transfer ID and select the matching giver.
     - **Special System Givers:**
       - Type `Loose Giving` or `0` for loose plate cash/offerings (Envelope `#0`).
       - Type `Internal` or `1` for internal transfers (Envelope `#1`, automatically defaults allocation to the `Internal` fund).
     - **Quick-Register New Giver:** If a donor does not exist yet, type their full name and click **`Create "<Name>"`** in the dropdown. A quick modal assigns the next envelope number and lets you optionally enter an address from their cheque. Newly created givers are tracked on the batch and highlighted on the Envelope Steward's Report.
   - **Amount:** Enter the total donation amount.
   - **Method:** Select `Cheque`, `Cash`, or `E-Transfer`:
     - **Cheque:** Enter the **Chq #** (required).
     - **Cash:** Click the **Banknote icon** to open the **Cash Counter** and enter the exact quantity of each bill/coin (`$100, $50, $20, $10, $5, $2, $1, $0.25, $0.10, $0.05`). The cash count total must equal the row's donation amount.
   - **Allocations (Splits):** Defaults to `General` for the full amount. Click the Allocations button to split a donation across multiple funds. The **Remaining** balance must reach `$0.00` before confirming. If a split uses the `Internal` fund, select or enter an **Internal Account Code**.
3. **Add Rows / Auto-Save:**
   - Clicking **Add New Row (Auto-Saves Batch)** — or pressing `Tab` from the Allocations button on the last completed row — validates and saves the batch automatically as an `Open` batch so work is never lost.
4. **Save & Exit:**
   - Click **Save & Exit** (or **Update & Exit** when editing) to save all rows and open **Batch History**.

---

### Step C: Auditing & Finalizing a Batch (`Batch History`)
Go to **Batch History** in the sidebar:

1. **Select a Batch:** Click a batch card in the scrollable left column (`Yellow = Open`, `Green = Finalized`).
2. **Perform the Physical Audit** *(for Open batches)*:
   - **Cash Audit:** Count all physical cash in the batch together and enter the total quantity of each bill and coin (`$100` down to `$0.05`). Both the **total dollar value** and the **exact denomination counts** must match what was entered on the individual donation rows.
   - **Cheque Audit:** Enter the **Physical Cheques** count and **Total Amount**. Both must match the system totals.
3. **Finalize & Lock:**
   - Once both Cash Audit and Cheque Audit show **Balanced**, the status button turns green (**Finalize Batch**).
   - Click **Finalize Batch** → **Confirm & Lock**.
   - The batch is permanently locked (`Finalized`), and the names of the currently logged-in teller(s) are attached to the batch record.

### Step D: Admin Adjustments on a Finalized Batch
If an error is discovered after a batch is locked:
1. An **Administrator** opens **Batch History**, selects the finalized batch, and clicks **Unlock**.
2. Click **Edit Batch** to adjust rows, amounts, or allocations, then click **Update & Exit**.
3. Re-complete the audit and click **Finalize Batch** again.
4. **Teller Provenance Preserved:** SafeTrack keeps the **original teller names** attached to the batch and appends the Administrator's name as an additional sign-off (displayed as `Admin / Adj` on the Deposit Slip).

---

### Step E: Reports & Emailing
In **Batch History**, select a batch and use the **Reports** bar:
- **Accounting:** Displays Fund Distribution totals, Internal Account totals, and Teller sign-offs.
- **Envelope:** Lists every regular giver's donation sorted by Envelope #, payment method/cheque #, fund splits, batch fund summary, and a **New Envelopes Created** table so the Envelope Steward can add new donors to your tax-receipting software.
- **Deposit Slip** *(Finalized batches only)*: Displays Bank & Church info, cash denomination breakdown, itemized cheque list, grand total, and signature lines for the tellers (and Admin if adjusted).

Inside any report, you can **Print**, **Download PDF**, or **Email Report**. On finalized batches, **Email All Reports** sends all three PDFs automatically to their configured recipient lists.

---

## 6. Technical & Developer Reference (For Ongoing Maintenance)

### Project Structure
- `App.tsx` — Root router (`HashRouter`) and auth/setup gating.
- `server.ts` — Express server (port `3000`) serving Vite middleware in dev, `dist/` in production, and `POST /api/send-email` via `nodemailer` + `multer`.
- `services/db.ts` — Dexie (`SafeTrackDB`) schema (v1–v7), default fund seeding, JSON export/import, and CSV giver export/import.
- `contexts/AuthContext.tsx` — Primary/secondary teller login, SHA-256 password hashing (`utils/auth.ts`), and session persistence.
- `services/email.ts` — Client helper calling `/api/send-email` with generated PDF blobs.
- `services/geminiService.ts` — Optional AI Financial Assistant insight on the Dashboard (uses `@google/genai` with `process.env.API_KEY`; gracefully falls back to an offline message if no key is configured).
- `components/` — Feature modules:
  - `InitialSetup.tsx`, `Login.tsx`, `ChangePasswordModal.tsx`, `UserManagement.tsx`
  - `Layout.tsx`, `Sidebar.tsx`, `Dashboard.tsx`
  - `GiverRegistry.tsx`, `BatchEntry.tsx`, `BatchHistory.tsx`, `Settings.tsx`
  - `AccountingReport.tsx`, `EnvelopeReport.tsx`, `DepositSlip.tsx`

### Common Commands
```bash
# Install dependencies
npm install

# Run development server (Express + Vite on http://localhost:3000)
npm run dev

# Build frontend for production (outputs to dist/)
npm run build

# Start production server
npm start
```
*(See `DEPLOY.md` and `deploy.sh` for VPS/PM2 and cloud platform hosting instructions.)*

---

## 7. Handover Checklist (Passing SafeTrack to a Colleague)

When handing SafeTrack over to another person or moving it to a new laptop:

1. **Export a Full Vault Backup:** Log in as Administrator → **Admin / Backup** → **Generate Backup** → download the `.json` file.
2. **Transfer the Code / App Access:** Share the repository (or hosted URL) with your colleague.
3. **Import the Backup on the New Computer:**
   - Open SafeTrack on the colleague's browser/laptop.
   - Complete the temporary Initial Setup (or log in if already set up), then go to **Admin / Backup → Restore Vault** and upload the `.json` backup file.
   - All givers, batches, donations, funds, settings, logos, and user accounts will be restored identically.
4. **Update Passwords & SMTP Credentials:**
   - Have the new Administrator and tellers update their passwords via **Change Passwords** or **User Management**.
   - Verify **Email & SMTP Configuration** and default report recipient emails in **Admin / Backup**.
5. **Confirm Printing & Email:** Open a finalized batch in **Batch History** and test **Download PDF** and **Email All Reports** to confirm everything works in the new environment.
