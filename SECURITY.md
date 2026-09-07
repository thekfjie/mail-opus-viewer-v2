# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories.
Do not include production credentials, mailbox contents, access tokens, private
service addresses, or personal data in a public issue.

Include the affected version, reproduction steps, expected impact, and any
suggested remediation. Reports will be reviewed as soon as practical.

## Operational Guidance

- Keep `.env`, databases, backups, logs, and generated artifacts outside Git.
- Use independent high-entropy values for session signing and credential encryption.
- Restrict the admin interface and internal APIs at the network boundary.
- Run the service behind TLS and rotate any credential that may have been exposed.
