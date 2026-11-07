# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Cockpit is pre-1.0. Security fixes land on the latest release. If you run from a
source checkout, update to the latest `main` before reporting a problem that may
already be fixed.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository:

1. Open the **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, operating system, a minimal reproduction, and
   the impact you observed.

If private reporting is unavailable, open a public issue that asks for a private
contact channel and do not include exploit details.

## What to expect

- Acknowledgement within 72 hours.
- An initial assessment within 7 days.
- A coordinated disclosure timeline based on severity and exploitability.
- Credit in the release notes if you want it.

Please give us a reasonable window to ship a fix before publishing details.

## Scope

In scope:

- the recording proxy, redaction, and stored data;
- authentication and pairing, including device tokens and remote access;
- the REST API and WebSocket feed;
- path handling for forks, snapshots, and plugins;
- the desktop and mobile clients;
- supply-chain issues in the release workflow.

Out of scope:

- a local user with full access to the machine reading the SQLite database;
- provider-side logging or retention;
- vulnerabilities in a model provider or an agent you run;
- social engineering;
- denial of service from a local process with the same OS account;
- missing TLS when the daemon is intentionally exposed without a proxy.

## Security model

Read [docs/security.md](docs/security.md) for the full model, including the
loopback trust boundary, pairing, redaction limits, plugin isolation, and the
fact that the database is not encrypted at rest.

## Safe harbor

We will not pursue legal action for good-faith research that follows this
policy, stays within your own systems, and avoids privacy violations,
destruction of data, and interruption of service.
