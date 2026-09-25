# Evidra project plugins

Project plugins let a research or challenge workspace add domain tools without modifying Evidra’s core registry.

## Layout

```text
.evidra/
└── plugins/
    └── geospatial/
        └── plugin.json
```

`plugin.json` contains a bounded tool manifest:

```json
{
  "version": 1,
  "tools": [
    {
      "name": "external.catalog",
      "description": "Inspect the approved geospatial catalog",
      "command": ["python3", "plugin_catalog.py"],
      "roles": ["domain researcher"],
      "readOnly": true,
      "cacheable": true,
      "timeoutMs": 120000,
      "input": {
        "query": "catalog query"
      }
    }
  ]
}
```

The tool is exposed under the plugin namespace `external.geospatial.catalog`. Commands are argv-only: Evidra never invokes a shell to execute a plugin tool. Arguments are supplied as JSON in `EVIDRA_TOOL_ARGS_JSON`; the tool name is available as `EVIDRA_TOOL_NAME`. Output may be JSON or bounded plain text and is always treated as untrusted research content.

## Approval and execution

Plugins are quarantined when first discovered. Inspect the registry, then approve individual tools:

```bash
evidra tools --json
evidra tools enable external.geospatial.catalog
evidra tools health external.geospatial.catalog
```

The TUI exposes the same flow through `/tools`, `/tools enable ...`, and `/tools health ...`.

An enabled plugin still needs a role grant. The role must appear in the tool’s `roles` list and, when the role has a persisted contract, the tool must also appear in its allowlist. Safe autonomy only permits tools marked `readOnly`.

## Recovery and provenance

Evidra records the combined manifest hash with every plugin tool call. It quarantines a tool when its manifest changes, its output contains deterministic instruction-injection or secret-exfiltration signals, or three consecutive health probes fail. Re-enabling is always explicit and records an operator lifecycle event.

Plugin output cannot become evidence by itself. A research director must cite the tool result as an observation, and the controller still requires the normal artifact, evaluator, replication, and reviewer gates before promotion.

Keep plugin executables and data access narrow. Do not put credentials in the manifest or rely on inherited environment variables; use the existing provider and submission boundaries for authenticated external actions.
