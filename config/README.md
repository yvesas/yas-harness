Declarative configuration: personas, channels, connectors.

Versioned in Git. No secrets here - use environment variables.

## `connectors.json`

Copy `connectors.example.json` to `connectors.json` and keep only the connectors
you actually use. It is **gitignored**, because it names your client ids.

Each key is a **connector id** — the `connectorId` a connection carries. So
`confluence` and `jira` get separate entries even though they share one
Atlassian OAuth app: they are different connectors reaching different APIs with
the same credential.

**The client secret is not in this file.** `clientSecretEnv` names the
environment variable that holds it; the value lives in `.env`. A `clientSecret`
field is refused — by the console's editor, and it would never have been read
anyway.

A missing `connectors.json` is fine. The connection layer then runs without
OAuth, which is what a deployment that connects nothing wants.

**The example is loaded by a test**, so it cannot drift into something the
harness would reject — which it had, in two ways at once, until somebody tried
to follow the instructions.
