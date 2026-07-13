# Importing documents

Bring existing policies, job descriptions, and curriculums into PolicyManager in
one step. You need the **document.write** permission; open **Import** in the left
navigation (`/library/import`).

## Import options

### 1. With a CSV manifest (recommended)

A manifest lets you set the title, category, document number, owner, tags, and more
for each file.

1. Click **Download sample manifest** to get a correctly-formatted template.
2. Fill in one row per document. **Title is required**; everything else is optional.
   - **fileName** — the exact name of the file you will upload for that row.
   - **category** — a folder path like `Policies & Procedures/Clinical`. Missing
     folders are created for you (existing ones are reused).
   - **tags** — separate several tags with `;` or `|` (for example `CARF;safety`).
   - **owner** — the person's email; if blank or unrecognized, you become the owner.
   - **accessLevel** — `public`, `restricted`, or `confidential`.
   - **reviewCadence** — `none`, `quarterly`, `annual`, or `custom`.
3. On the **CSV manifest** tab, choose your filled-in manifest, then choose all the
   files it references.
4. The preview shows the detected columns and row count, and warns if the required
   `title` column is missing.
5. Click **Run import**.

### 2. Files only (no manifest)

On the **Files only** tab, choose one or more files and click **Run import**. Each
file becomes a document titled from its file name. Use this for a quick bulk load
when you do not need to set categories or numbers up front.

### 3. ZIP archive

On the **ZIP archive** tab, choose one or more `.zip` files and click **Run import**.
PolicyManager expands each archive and imports supported documents inside it. Folder
paths inside the ZIP become categories. For example,
`Policies/Clinical/Seclusion.pdf` imports the file into the `Policies/Clinical`
category path.

ZIP safety rules:

- macOS metadata folders/files and hidden files are ignored.
- Unsafe paths such as `../file.pdf` are rejected and shown as errors in the report.
- Unsupported ZIP entries are reported as errors.
- Each extracted file must be 50 MB or smaller.

### 4. Folder upload or drag/drop

On the **Folder** tab, choose a folder from your browser file picker. You can also
drop files or folders into the import area. Browser folder paths are preserved in the
report and converted into categories.

If your browser does not support folder selection or folder drops, select multiple
files on the **Files only** tab instead.

## The import report

After running, you get a report with a line for every row:

- **Created** — a new document (and its first version) was added. Click **View
  document** to open it.
- **Duplicate** — skipped because a matching document already exists (same document
  number, the same file, or the same title + file name). Click **View existing** to
  see it.
- **Error** — the row could not be imported; the message explains why (for example,
  a referenced file was not uploaded, the title was blank, a ZIP entry was unsafe,
  or an archive entry had an unsupported file type). Other rows are unaffected.

Summary tiles show the totals. Re-running the same import is safe: already-imported
documents are detected as duplicates and skipped, so nothing is created twice.

Past imports appear under **Recent imports**; click **View report** to reopen any of
them.

## Limits

- Maximum 200 imported files/report rows per request after ZIP expansion.
- Maximum 50 MB per uploaded file or extracted ZIP entry.
- ZIP archives have a 500 MB total uncompressed limit.
