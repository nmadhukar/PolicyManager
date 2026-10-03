# Use PolicyManager from chat

Your administrator connects Hermes or your clinic's bot to PolicyManager. The connection uses your existing permissions. Ask it to identify your account before actions. Sign in and refresh access outside chat; do not paste passwords, access tokens or API keys into a conversation.

Try these requests:

- “Find the published infection prevention policy and give me its current version.”
- “Create a draft titled Emergency Procedures with annual review cadence.”
- “Upload this PDF as a new version of that draft, with change summary Annual update.”
- “Show my review tasks; open the policy assigned to this task.”
- “Record my review with these notes and show the next review date.”
- “Publish this reviewed version and distribute it to the selected staff.”
- “Show my acknowledgments, open this document, then record my acknowledgment after I have read it.”

The client should show the selected document/version and intended changes before significant actions. Server permission and access checks apply to every call. A chat client cannot approve on your behalf unless your account has approval permission; it cannot complete another person's acknowledgment. Read-only integration bots only retrieve published policies.

An attachment upload creates a new immutable document version. Native HTML saves and restoration of an older version also create new versions. Deleting a document soft-deletes it and preserves history; an authorized user can restore it. Archive/retire keeps the document accessible outside active views. Version download links expire; request a fresh authorized link when needed. Office editing still uses the clinic's existing editor integration.

Acknowledgment requires server evidence that you opened the assigned version. Ask for the view link, follow it and read the document before acknowledging. A client must not auto-acknowledge merely because it requested a link. Publishing another version creates fresh acknowledgment assignments; your earlier evidence remains historical.

If chat reports **uncertain outcome**, the action may have finished even though its result could not be delivered. Ask to inspect the document, versions, task or audit history before repeating. Permission errors require your administrator; expired-session errors require sign-in outside chat. Large files/batches may need splitting or operator-adjusted limits. Bot hosts must support encoding attachments and saving returned PDF/ZIP bytes; raw base64 is not a readable document.

Administrators configure access with [the Hermes guide](../admin/mcp-hermes.md). Developers can inspect exact tool names and arguments in [the API contract](../api/mcp.md).
