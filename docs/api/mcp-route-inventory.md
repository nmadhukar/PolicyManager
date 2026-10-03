# REST operation coverage for MCP

Date: 2026-10-03

Status: implemented; approved 107-tool registry and nine protocol exclusions.

All 116 operations declared in the 24 existing NestJS controllers are accounted for: 100 user JWT operations, six scoped read-only public API operations, one shared health operation and nine approved exclusions. The baseline contains 51 GET operations and 65 mutations. Existing server guards, ACLs, ownership and scopes remain authoritative. JWT users discover only eligible internal tools; API clients discover only eligible public v1 reads and health.

See the [operational API contract](mcp.md), [full argument schemas](mcp-tools.json), [accepted design](../superpowers/specs/2026-10-03-mcp-hermes-design.md), and [delivery evidence](../../.ai/tasks/MCP_INTEGRATION.md). Registry names are stable integration contracts. Automated tests compare method/path and permission/scope metadata against every real controller, including Swagger-excluded routes.

Authentication bootstrap, browser OIDC, and signed OnlyOffice protocols remain outside model-visible actions by approved scope. User editor configuration, native HTML/Office version actions and password change remain mapped. Swagger-generated infrastructure and the new MCP transport surface are separate from this REST baseline.

| REST operation | MCP tool or approved exclusion | Payload contract | Source |
| --- | --- | --- | --- |
| `GET /api/api-clients` | `api_clients_list` | JSON/empty response | [apps/api/src/api-clients/api-clients.controller.ts:28](../../apps/api/src/api-clients/api-clients.controller.ts#L28) |
| `POST /api/api-clients` | `api_clients_create` | JSON/empty response | [apps/api/src/api-clients/api-clients.controller.ts:34](../../apps/api/src/api-clients/api-clients.controller.ts#L34) |
| `PATCH /api/api-clients/:id` | `api_clients_update` | JSON/empty response | [apps/api/src/api-clients/api-clients.controller.ts:44](../../apps/api/src/api-clients/api-clients.controller.ts#L44) |
| `POST /api/api-clients/:id/revoke` | `api_clients_revoke` | JSON/empty response | [apps/api/src/api-clients/api-clients.controller.ts:55](../../apps/api/src/api-clients/api-clients.controller.ts#L55) |
| `POST /api/api-clients/:id/rotate-secret` | `api_clients_rotate` | JSON/empty response | [apps/api/src/api-clients/api-clients.controller.ts:66](../../apps/api/src/api-clients/api-clients.controller.ts#L66) |
| `GET /api/acknowledgments` | `acknowledgments_mine` | JSON/empty response | [apps/api/src/attestation/acknowledgments.controller.ts:23](../../apps/api/src/attestation/acknowledgments.controller.ts#L23) |
| `POST /api/acknowledgments/:id/acknowledge` | `acknowledgments_acknowledge` | JSON/empty response | [apps/api/src/attestation/acknowledgments.controller.ts:29](../../apps/api/src/attestation/acknowledgments.controller.ts#L29) |
| `POST /api/documents/:id/approve` | `document_signoff_approve` | JSON/empty response | [apps/api/src/attestation/document-signoff.controller.ts:50](../../apps/api/src/attestation/document-signoff.controller.ts#L50) |
| `GET /api/documents/:id/attestations` | `document_signoff_attestations` | JSON/empty response | [apps/api/src/attestation/document-signoff.controller.ts:65](../../apps/api/src/attestation/document-signoff.controller.ts#L65) |
| `GET /api/documents/:id/cover-page` | `document_signoff_cover_page_pdf` | PDF/ZIP response | [apps/api/src/attestation/document-signoff.controller.ts:77](../../apps/api/src/attestation/document-signoff.controller.ts#L77) |
| `GET /api/documents/:id/export` | `document_signoff_export_pdf` | PDF/ZIP response | [apps/api/src/attestation/document-signoff.controller.ts:93](../../apps/api/src/attestation/document-signoff.controller.ts#L93) |
| `POST /api/documents/:id/acknowledgments` | `document_signoff_distribute` | JSON/empty response | [apps/api/src/attestation/document-signoff.controller.ts:109](../../apps/api/src/attestation/document-signoff.controller.ts#L109) |
| `GET /api/documents/:id/acknowledgments` | `document_signoff_acknowledgment_status` | JSON/empty response | [apps/api/src/attestation/document-signoff.controller.ts:121](../../apps/api/src/attestation/document-signoff.controller.ts#L121) |
| `GET /api/audit` | `audit_list` | JSON/empty response | [apps/api/src/audit/audit.controller.ts:23](../../apps/api/src/audit/audit.controller.ts#L23) |
| `POST /api/auth/login` | Excluded: Credential bootstrap; sign in outside model-visible tools | Protocol-specific | [apps/api/src/auth/auth.controller.ts:41](../../apps/api/src/auth/auth.controller.ts#L41) |
| `POST /api/auth/refresh` | Excluded: Credential bootstrap; refresh outside model-visible tools | Protocol-specific | [apps/api/src/auth/auth.controller.ts:68](../../apps/api/src/auth/auth.controller.ts#L68) |
| `POST /api/auth/logout` | Excluded: Credential bootstrap; revoke refresh credentials outside model-visible tools | Protocol-specific | [apps/api/src/auth/auth.controller.ts:76](../../apps/api/src/auth/auth.controller.ts#L76) |
| `POST /api/auth/forgot-password` | Excluded: Credential recovery outside model-visible tools | Protocol-specific | [apps/api/src/auth/auth.controller.ts:83](../../apps/api/src/auth/auth.controller.ts#L83) |
| `POST /api/auth/reset-password` | Excluded: Credential recovery outside model-visible tools | Protocol-specific | [apps/api/src/auth/auth.controller.ts:94](../../apps/api/src/auth/auth.controller.ts#L94) |
| `POST /api/auth/change-password` | `auth_change_password` | JSON/empty response | [apps/api/src/auth/auth.controller.ts:109](../../apps/api/src/auth/auth.controller.ts#L109) |
| `GET /api/auth/me` | `auth_me` | JSON/empty response | [apps/api/src/auth/auth.controller.ts:118](../../apps/api/src/auth/auth.controller.ts#L118) |
| `GET /api/auth/oidc/azure` | Excluded: Browser OIDC redirect protocol | Protocol-specific | [apps/api/src/auth/auth.controller.ts:131](../../apps/api/src/auth/auth.controller.ts#L131) |
| `GET /api/auth/oidc/azure/callback` | Excluded: Browser OIDC callback protocol | Protocol-specific | [apps/api/src/auth/auth.controller.ts:150](../../apps/api/src/auth/auth.controller.ts#L150) |
| `GET /api/documents/:id/acl` | `document_acl_list` | JSON/empty response | [apps/api/src/documents/document-acl.controller.ts:35](../../apps/api/src/documents/document-acl.controller.ts#L35) |
| `POST /api/documents/:id/acl` | `document_acl_add` | JSON/empty response | [apps/api/src/documents/document-acl.controller.ts:41](../../apps/api/src/documents/document-acl.controller.ts#L41) |
| `DELETE /api/documents/:id/acl/:aclId` | `document_acl_remove` | JSON/empty response | [apps/api/src/documents/document-acl.controller.ts:52](../../apps/api/src/documents/document-acl.controller.ts#L52) |
| `GET /api/documents/:documentId/versions/:versionId/annotations` | `document_annotations_list` | JSON/empty response | [apps/api/src/documents/document-annotations.controller.ts:20](../../apps/api/src/documents/document-annotations.controller.ts#L20) |
| `POST /api/documents/:documentId/versions/:versionId/annotations` | `document_annotations_create` | JSON/empty response | [apps/api/src/documents/document-annotations.controller.ts:32](../../apps/api/src/documents/document-annotations.controller.ts#L32) |
| `POST /api/documents/:documentId/versions/:versionId/annotations/:annotationId/resolve` | `document_annotations_resolve` | JSON/empty response | [apps/api/src/documents/document-annotations.controller.ts:47](../../apps/api/src/documents/document-annotations.controller.ts#L47) |
| `POST /api/documents/:documentId/versions/:versionId/annotations/:annotationId/reopen` | `document_annotations_reopen` | JSON/empty response | [apps/api/src/documents/document-annotations.controller.ts:61](../../apps/api/src/documents/document-annotations.controller.ts#L61) |
| `DELETE /api/documents/:documentId/versions/:versionId/annotations/:annotationId` | `document_annotations_soft_delete` | JSON/empty response | [apps/api/src/documents/document-annotations.controller.ts:75](../../apps/api/src/documents/document-annotations.controller.ts#L75) |
| `GET /api/document-categories` | `document_categories_tree` | JSON/empty response | [apps/api/src/documents/document-categories.controller.ts:21](../../apps/api/src/documents/document-categories.controller.ts#L21) |
| `POST /api/document-categories` | `document_categories_create` | JSON/empty response | [apps/api/src/documents/document-categories.controller.ts:28](../../apps/api/src/documents/document-categories.controller.ts#L28) |
| `GET /api/documents/:id/versions/:fromVersionId/compare/:toVersionId` | `document_compare_compare` | JSON/empty response | [apps/api/src/documents/document-compare.controller.ts:20](../../apps/api/src/documents/document-compare.controller.ts#L20) |
| `GET /api/documents/:id/versions/:fromVersionId/compare/:toVersionId/export` | `document_compare_export` | PDF/ZIP response | [apps/api/src/documents/document-compare.controller.ts:32](../../apps/api/src/documents/document-compare.controller.ts#L32) |
| `GET /api/documents` | `documents_list` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:87](../../apps/api/src/documents/documents.controller.ts#L87) |
| `POST /api/documents/extraction/reindex` | `documents_reindex_extraction` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:106](../../apps/api/src/documents/documents.controller.ts#L106) |
| `GET /api/documents/:id` | `documents_get` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:116](../../apps/api/src/documents/documents.controller.ts#L116) |
| `POST /api/documents/:id/extraction/retry` | `documents_retry_extraction` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:123](../../apps/api/src/documents/documents.controller.ts#L123) |
| `POST /api/documents` | `documents_create` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:137](../../apps/api/src/documents/documents.controller.ts#L137) |
| `POST /api/documents/bulk-review-schedule` | `documents_bulk_review_schedule` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:148](../../apps/api/src/documents/documents.controller.ts#L148) |
| `PATCH /api/documents/:id/review-schedule` | `documents_update_review_schedule` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:162](../../apps/api/src/documents/documents.controller.ts#L162) |
| `PATCH /api/documents/:id` | `documents_update` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:174](../../apps/api/src/documents/documents.controller.ts#L174) |
| `POST /api/documents/:id/versions` | `documents_add_version` | Multipart | [apps/api/src/documents/documents.controller.ts:186](../../apps/api/src/documents/documents.controller.ts#L186) |
| `GET /api/documents/:id/versions/:versionId/download` | `documents_download` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:229](../../apps/api/src/documents/documents.controller.ts#L229) |
| `GET /api/documents/:id/versions/:versionId/view-url` | `documents_view_url` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:241](../../apps/api/src/documents/documents.controller.ts#L241) |
| `POST /api/documents/:id/versions/:versionId/rendition` | `documents_regenerate_rendition` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:255](../../apps/api/src/documents/documents.controller.ts#L255) |
| `GET /api/documents/:id/versions/:versionId/html` | `documents_version_html` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:268](../../apps/api/src/documents/documents.controller.ts#L268) |
| `POST /api/documents/:id/versions/html` | `documents_add_html_version` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:280](../../apps/api/src/documents/documents.controller.ts#L280) |
| `GET /api/documents/:id/editor-config` | `documents_editor_config` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:294](../../apps/api/src/documents/documents.controller.ts#L294) |
| `POST /api/documents/:id/versions/:versionId/restore` | `documents_restore_version` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:307](../../apps/api/src/documents/documents.controller.ts#L307) |
| `DELETE /api/documents/:id` | `documents_soft_delete` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:321](../../apps/api/src/documents/documents.controller.ts#L321) |
| `POST /api/documents/:id/restore` | `documents_restore` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:334](../../apps/api/src/documents/documents.controller.ts#L334) |
| `POST /api/documents/:id/archive` | `documents_archive` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:346](../../apps/api/src/documents/documents.controller.ts#L346) |
| `POST /api/documents/:id/unarchive` | `documents_unarchive` | JSON/empty response | [apps/api/src/documents/documents.controller.ts:358](../../apps/api/src/documents/documents.controller.ts#L358) |
| `GET /api/documents/:id/versions/:versionId/content` | Excluded: OnlyOffice source protocol; purpose-scoped signed token | Protocol-specific | [apps/api/src/documents/documents-editor.controller.ts:42](../../apps/api/src/documents/documents-editor.controller.ts#L42) |
| `POST /api/documents/:id/editor-callback` | Excluded: OnlyOffice save protocol; signed callback and scoped token | Protocol-specific | [apps/api/src/documents/documents-editor.controller.ts:69](../../apps/api/src/documents/documents-editor.controller.ts#L69) |
| `GET /api/documents/:id/evidence-binders` | `evidence_binder_history` | JSON/empty response | [apps/api/src/evidence/evidence-binder.controller.ts:21](../../apps/api/src/evidence/evidence-binder.controller.ts#L21) |
| `POST /api/documents/:id/evidence-binders/export` | `evidence_binder_export` | PDF/ZIP response | [apps/api/src/evidence/evidence-binder.controller.ts:27](../../apps/api/src/evidence/evidence-binder.controller.ts#L27) |
| `GET /health` | `health_check` | JSON/empty response | [apps/api/src/health/health.controller.ts:7](../../apps/api/src/health/health.controller.ts#L7) |
| `POST /api/imports` | `imports_import_manifest` | Multipart | [apps/api/src/imports/imports.controller.ts:56](../../apps/api/src/imports/imports.controller.ts#L56) |
| `POST /api/imports/bulk` | `imports_import_bulk` | Multipart | [apps/api/src/imports/imports.controller.ts:97](../../apps/api/src/imports/imports.controller.ts#L97) |
| `GET /api/imports` | `imports_list` | JSON/empty response | [apps/api/src/imports/imports.controller.ts:136](../../apps/api/src/imports/imports.controller.ts#L136) |
| `GET /api/imports/:id` | `imports_get` | JSON/empty response | [apps/api/src/imports/imports.controller.ts:145](../../apps/api/src/imports/imports.controller.ts#L145) |
| `GET /api/notifications` | `notifications_list` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:21](../../apps/api/src/notifications/notifications.controller.ts#L21) |
| `GET /api/notifications/unread-count` | `notifications_unread_count` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:27](../../apps/api/src/notifications/notifications.controller.ts#L27) |
| `GET /api/notifications/preferences` | `notifications_preferences` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:33](../../apps/api/src/notifications/notifications.controller.ts#L33) |
| `PATCH /api/notifications/preferences` | `notifications_update_preferences` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:39](../../apps/api/src/notifications/notifications.controller.ts#L39) |
| `PATCH /api/notifications/:id/read` | `notifications_mark_read` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:49](../../apps/api/src/notifications/notifications.controller.ts#L49) |
| `PATCH /api/notifications/read-all` | `notifications_read_all` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:55](../../apps/api/src/notifications/notifications.controller.ts#L55) |
| `DELETE /api/notifications/:id` | `notifications_dismiss` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:61](../../apps/api/src/notifications/notifications.controller.ts#L61) |
| `POST /api/notifications/digest/run` | `notifications_run_digest` | JSON/empty response | [apps/api/src/notifications/notifications.controller.ts:67](../../apps/api/src/notifications/notifications.controller.ts#L67) |
| `GET /api/v1/documents` | `public_documents_list` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:27](../../apps/api/src/public-api/public-documents.controller.ts#L27) |
| `GET /api/v1/search` | `public_documents_search` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:38](../../apps/api/src/public-api/public-documents.controller.ts#L38) |
| `GET /api/v1/documents/:id` | `public_documents_get` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:49](../../apps/api/src/public-api/public-documents.controller.ts#L49) |
| `GET /api/v1/documents/:id/content` | `public_documents_content` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:60](../../apps/api/src/public-api/public-documents.controller.ts#L60) |
| `GET /api/v1/documents/:id/download` | `public_documents_download` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:71](../../apps/api/src/public-api/public-documents.controller.ts#L71) |
| `GET /api/v1/documents/:id/versions` | `public_documents_versions` | JSON/empty response | [apps/api/src/public-api/public-documents.controller.ts:82](../../apps/api/src/public-api/public-documents.controller.ts#L82) |
| `GET /api/rag/status` | `rag_chat_status` | JSON/empty response | [apps/api/src/rag/chat/rag-chat.controller.ts:43](../../apps/api/src/rag/chat/rag-chat.controller.ts#L43) |
| `POST /api/rag/reindex` | `rag_chat_reindex` | JSON/empty response | [apps/api/src/rag/chat/rag-chat.controller.ts:49](../../apps/api/src/rag/chat/rag-chat.controller.ts#L49) |
| `POST /api/rag/chat` | `rag_chat_chat` | JSON/empty response | [apps/api/src/rag/chat/rag-chat.controller.ts:58](../../apps/api/src/rag/chat/rag-chat.controller.ts#L58) |
| `GET /api/rag/conversations` | `rag_chat_list_conversations` | JSON/empty response | [apps/api/src/rag/chat/rag-chat.controller.ts:69](../../apps/api/src/rag/chat/rag-chat.controller.ts#L69) |
| `GET /api/rag/conversations/:id` | `rag_chat_get_conversation` | JSON/empty response | [apps/api/src/rag/chat/rag-chat.controller.ts:88](../../apps/api/src/rag/chat/rag-chat.controller.ts#L88) |
| `GET /api/documents/:id/reviewers` | `reviewers_list` | JSON/empty response | [apps/api/src/review/reviewers.controller.ts:25](../../apps/api/src/review/reviewers.controller.ts#L25) |
| `POST /api/documents/:id/reviewers` | `reviewers_assign` | JSON/empty response | [apps/api/src/review/reviewers.controller.ts:31](../../apps/api/src/review/reviewers.controller.ts#L31) |
| `DELETE /api/documents/:id/reviewers/:userId` | `reviewers_unassign` | JSON/empty response | [apps/api/src/review/reviewers.controller.ts:42](../../apps/api/src/review/reviewers.controller.ts#L42) |
| `GET /api/reviews` | `reviews_list` | JSON/empty response | [apps/api/src/review/reviews.controller.ts:33](../../apps/api/src/review/reviews.controller.ts#L33) |
| `GET /api/reviews/compliance-summary` | `reviews_compliance` | JSON/empty response | [apps/api/src/review/reviews.controller.ts:41](../../apps/api/src/review/reviews.controller.ts#L41) |
| `POST /api/reviews/run-sweep` | `reviews_run_sweep` | JSON/empty response | [apps/api/src/review/reviews.controller.ts:48](../../apps/api/src/review/reviews.controller.ts#L48) |
| `GET /api/reviews/tasks/:taskId` | `reviews_get_task` | JSON/empty response | [apps/api/src/review/reviews.controller.ts:58](../../apps/api/src/review/reviews.controller.ts#L58) |
| `POST /api/reviews/:taskId/complete` | `reviews_complete` | JSON/empty response | [apps/api/src/review/reviews.controller.ts:64](../../apps/api/src/review/reviews.controller.ts#L64) |
| `GET /api/saved-searches` | `saved_searches_list` | JSON/empty response | [apps/api/src/search/saved-searches.controller.ts:18](../../apps/api/src/search/saved-searches.controller.ts#L18) |
| `POST /api/saved-searches` | `saved_searches_create` | JSON/empty response | [apps/api/src/search/saved-searches.controller.ts:24](../../apps/api/src/search/saved-searches.controller.ts#L24) |
| `PATCH /api/saved-searches/:id` | `saved_searches_update` | JSON/empty response | [apps/api/src/search/saved-searches.controller.ts:34](../../apps/api/src/search/saved-searches.controller.ts#L34) |
| `POST /api/saved-searches/:id/run` | `saved_searches_run` | JSON/empty response | [apps/api/src/search/saved-searches.controller.ts:45](../../apps/api/src/search/saved-searches.controller.ts#L45) |
| `DELETE /api/saved-searches/:id` | `saved_searches_remove` | JSON/empty response | [apps/api/src/search/saved-searches.controller.ts:51](../../apps/api/src/search/saved-searches.controller.ts#L51) |
| `GET /api/smtp/config` | `smtp_get_config` | JSON/empty response | [apps/api/src/smtp/smtp.controller.ts:28](../../apps/api/src/smtp/smtp.controller.ts#L28) |
| `PUT /api/smtp/config` | `smtp_update_config` | JSON/empty response | [apps/api/src/smtp/smtp.controller.ts:34](../../apps/api/src/smtp/smtp.controller.ts#L34) |
| `POST /api/smtp/test` | `smtp_test` | JSON/empty response | [apps/api/src/smtp/smtp.controller.ts:48](../../apps/api/src/smtp/smtp.controller.ts#L48) |
| `GET /api/smtp/notifications` | `smtp_notifications` | JSON/empty response | [apps/api/src/smtp/smtp.controller.ts:58](../../apps/api/src/smtp/smtp.controller.ts#L58) |
| `GET /api/storage/config` | `storage_admin_config` | JSON/empty response | [apps/api/src/storage-admin/storage-admin.controller.ts:24](../../apps/api/src/storage-admin/storage-admin.controller.ts#L24) |
| `GET /api/storage/buckets` | `storage_admin_list_buckets` | JSON/empty response | [apps/api/src/storage-admin/storage-admin.controller.ts:30](../../apps/api/src/storage-admin/storage-admin.controller.ts#L30) |
| `POST /api/storage/buckets` | `storage_admin_create_bucket` | JSON/empty response | [apps/api/src/storage-admin/storage-admin.controller.ts:36](../../apps/api/src/storage-admin/storage-admin.controller.ts#L36) |
| `GET /api/storage/prefixes` | `storage_admin_list_prefixes` | JSON/empty response | [apps/api/src/storage-admin/storage-admin.controller.ts:42](../../apps/api/src/storage-admin/storage-admin.controller.ts#L42) |
| `POST /api/storage/prefixes` | `storage_admin_create_prefix` | JSON/empty response | [apps/api/src/storage-admin/storage-admin.controller.ts:48](../../apps/api/src/storage-admin/storage-admin.controller.ts#L48) |
| `GET /api/roles` | `roles_list` | JSON/empty response | [apps/api/src/users/roles.controller.ts:20](../../apps/api/src/users/roles.controller.ts#L20) |
| `GET /api/users` | `users_list` | JSON/empty response | [apps/api/src/users/users.controller.ts:37](../../apps/api/src/users/users.controller.ts#L37) |
| `GET /api/users/:id` | `users_get` | JSON/empty response | [apps/api/src/users/users.controller.ts:43](../../apps/api/src/users/users.controller.ts#L43) |
| `POST /api/users` | `users_create` | JSON/empty response | [apps/api/src/users/users.controller.ts:49](../../apps/api/src/users/users.controller.ts#L49) |
| `PATCH /api/users/:id` | `users_update` | JSON/empty response | [apps/api/src/users/users.controller.ts:55](../../apps/api/src/users/users.controller.ts#L55) |
| `POST /api/users/:id/disable` | `users_disable` | JSON/empty response | [apps/api/src/users/users.controller.ts:61](../../apps/api/src/users/users.controller.ts#L61) |
| `POST /api/users/:id/enable` | `users_enable` | JSON/empty response | [apps/api/src/users/users.controller.ts:67](../../apps/api/src/users/users.controller.ts#L67) |
| `POST /api/users/:id/lock` | `users_lock` | JSON/empty response | [apps/api/src/users/users.controller.ts:73](../../apps/api/src/users/users.controller.ts#L73) |
| `POST /api/users/:id/unlock` | `users_unlock` | JSON/empty response | [apps/api/src/users/users.controller.ts:79](../../apps/api/src/users/users.controller.ts#L79) |
| `POST /api/users/:id/reset-password` | `users_reset_password` | JSON/empty response | [apps/api/src/users/users.controller.ts:85](../../apps/api/src/users/users.controller.ts#L85) |
| `POST /api/users/:id/roles` | `users_assign_roles` | JSON/empty response | [apps/api/src/users/users.controller.ts:93](../../apps/api/src/users/users.controller.ts#L93) |
