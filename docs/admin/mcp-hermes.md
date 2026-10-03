# Connect Hermes and bots to PolicyManager

First activate the API using the [MCP runbook](../runbooks/mcp.md). Keep access tokens and API keys in the client secret environment, outside chat prompts and version control.

Configure a remote server in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  policymanager:
    url: "${POLICYMANAGER_MCP_URL}"
    headers:
      Authorization: "Bearer ${POLICYMANAGER_ACCESS_TOKEN}"
    timeout: 150
    connect_timeout: 30
    supports_parallel_tool_calls: false
    tools:
      exclude:
        - auth_change_password
        - users_create
        - users_reset_password
        - api_clients_create
        - api_clients_rotate
      resources: false
      prompts: false
```

Set `POLICYMANAGER_MCP_URL=https://<api-host>/api/mcp` and obtain `POLICYMANAGER_ACCESS_TOKEN` through ordinary PolicyManager login or the existing SSO session outside model tools. Hermes resolves `${ENV_VAR}` in URLs and headers; its [official MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) describes configuration, environment substitution, tool filters and `/reload-mcp`. Start a new Hermes session or reload MCP after changing credentials or roles. Tools appear with a prefix such as `mcp_policymanager_documents_list`.

The example hides credential-bearing actions from model discovery because their inputs/results can enter conversation history. Authorized tools remain on the server for private clients; change the filter deliberately if needed. A client filter narrows model exposure; PolicyManager RBAC remains the security boundary. For a narrowly scoped bot, prefer a `tools.include` list of approved workflows. Keep parallel calls disabled for dependent document actions. Increase Hermes timeout if the server tool timeout is increased.

No custom preflight option is necessary: authenticated HEAD/GET returning 405 is expected for this POST-only transport. The current [Hermes transport implementation](https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool_transport.py) accepts that response before its SDK connection. This repository tests an official SDK client; the Hermes CLI itself was unavailable in the implementation environment, so operator acceptance includes a real Hermes connection.

## Read-only EMR/AI bot

An administrator with `api.manage` creates an API client through the existing UI/REST management workflow. Copy the one-time `clientId.secret` to a protected environment variable. Persisted client secrets remain Argon2 hashes.

```yaml
mcp_servers:
  policymanager_reader:
    url: "${POLICYMANAGER_MCP_URL}"
    headers:
      X-Api-Key: "${POLICYMANAGER_API_KEY}"
    timeout: 150
    tools:
      include: [health_check, public_documents_list, public_documents_get,
                public_documents_search, public_documents_content,
                public_documents_download, public_documents_versions]
      resources: false
      prompts: false
```

Grant only the required `documents:read`, `content:read`, and/or `download` scopes and category allow-list. Search needs both document and content scopes. Public v1 serves published, accessible content; API credentials cannot upload, approve, edit, distribute or manage users. Revocation, scope changes and category restrictions apply on the next request.

## Acting users and shared messaging bots

One JWT connection represents one PolicyManager user. A dedicated automation account acts as itself and has its own roles and audit identity. For a shared Slack/Telegram/other gateway acting for humans, the bot host must authenticate each human, select that person's JWT outside the model, and isolate credentials, client sessions and conversation results. A single administrator JWT would make every action an administrator action. `X-User-Id`, Hermes profile names and actor fields cannot grant or replace PolicyManager identity.

Local/SSO login and refresh stay outside MCP. A client credential broker may call existing `/api/auth/refresh`, retain the refresh token securely, update the access-token header and reconnect. Static Hermes header configuration does not itself implement PolicyManager refresh or MCP OAuth discovery. Finish mandatory temporary-password changes privately before normal bot use. Disabled or locked users and expired tokens fail with 401.

## Verify and remove access

Run [the smoke command](../runbooks/mcp.md#smoke-and-acceptance) with the same environment used by the client. In Hermes ask for your accessible policies, then perform a disposable draft workflow with an appropriately permitted account. Confirm the displayed identity and audit record before enabling a messaging gateway. Review filenames/download support in the bot host; uploads require a trusted attachment encoder and binary exports require an attachment decoder.

To disconnect, disable/remove the Hermes server entry and reload. Revoke API clients or disable the automation user to remove server access. A changed user password alone does not invalidate an already-issued JWT under the existing auth contract; disabling/locking the account takes effect on the next request. Turn off `MCP_ENABLED` and restart the API to stop all MCP entry points.
