# Using the Document Library

The Library is where your clinic's controlled documents — policies & procedures,
job descriptions, and IOP/PHP curriculums — live in one versioned, searchable
place. Open it from **Library** in the left navigation.

## Finding a document

- **Search:** type in the search box at the top. It matches the document title,
  number, description, and searchable text extracted from the current version.
- **Filters:** narrow the list by **Category**, **Owner**, **Status**, **Access
  level**, **Tag**, and a **Next review** date range (after / before).
- **Active filters** appear as chips under the filters. Click a chip's ✕ to
  remove that filter, or **Clear all** to reset.
- **Sort:** click the **Title**, **Status**, or **Next review** column headers to
  sort; click again to reverse the order.
- **Pages:** use **Previous / Next** at the bottom to move through results.

Click any row to open the document.

## Creating a document

You need the *document.write* permission (Manager, Compliance Officer, or Admin).

1. Click **New document**.
2. Enter a **Title** — this is required.
3. Optionally set a document number, category, description, tags, access level,
   review cadence, and next review date.
   - If the category does not exist yet, click **New category**, enter the name,
     optionally choose a parent category, and save it. The new category is
     selected immediately.
4. Click **Create document**. You'll land on the new document's page, ready to
   upload its first file.

## Uploading a version

A document's content is stored as **versions**. Every upload is kept forever —
uploading a new file never erases the previous one.

1. Open the document.
2. Under **Version history**, choose a file and (optionally) add a **change
   summary** describing what changed.
3. Click **Upload**. The new file becomes the current version; earlier versions
   remain in the history as evidence.

Supported files include PDF, Word (`.docx`), Excel, PowerPoint, images, and
text/markdown. Text extraction runs in the background. Scanned PDFs and images
can become searchable when OCR is enabled by an administrator.

## Version history & downloading

- The **Version history** table lists every version, newest first, with its
  file, size, who uploaded it, when, and the change summary. The current version
  is badged **Current**.
- Each row shows whether search text is queued, processing, ready, skipped, or
  failed. Versions marked **OCR** used optical character recognition.
- Click **Download** on any version to open it. Downloads use a secure,
  short-lived link — the underlying storage is never public.

## Review annotations

When viewing a document version, assigned reviewers and users with annotation
rights can add comments anchored to a page. Open annotations show in the viewer
panel and as highlights over the document preview. Reviewers can resolve or
reopen comments, and authors or compliance staff can delete comments. Deleting
an annotation removes it from normal views but keeps an audit record.

If your assignment or access changes while the viewer is open, resolve/reopen/delete
actions show an error in the annotation panel instead of silently failing.

Approval and review screens show a warning when the current version still has
open annotations. The warning does not block sign-off; it gives the signer the
current issue count before they approve or complete the review.

## Review scheduling

Users with review management access see the **Review Schedule** panel on the
document page.

For one document:

1. Open the document.
2. In **Review Schedule**, click **Edit schedule**.
3. Choose **Quarterly**, **Annual**, **Custom**, or **None**.
4. Set the **Next review date** when the cadence is not **None**.
5. Click **Save schedule**.

For many documents:

1. Open **Library**.
2. Narrow the list with filters such as **Category**, **Tag**, **Owner**,
   **Status**, or the due-date quick filters.
3. Either select individual rows, or leave rows unselected and use the filtered
   result set.
4. In **Bulk review cadence**, choose the cadence and next review date.
5. Click **Schedule selected** or **Schedule filtered**, then confirm.

The next review sweep creates reviewer tasks when a scheduled document comes due.
If no reviewer is assigned, the review falls to the document owner.

## Editing details & tags

With *document.write* you can:

- Click **Edit** in the **Details** panel to change the title, number, category,
  status, access level, review cadence, and dates.
- Click **New category** from the category field when a missing category needs
  to be added while editing a document.
- Use the **Tags** panel to add a tag (type and press Enter) or remove one (click
  its ✕). Tags power quick filtering back in the library.

## Understanding status

Documents move through: **Draft → In review → Approved → Published**, and can be
**Archived** or **Retired**. The status shows as a colored badge on the row and
the document page.
