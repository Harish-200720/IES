# Security policy

This is a private internal application repository. Do not create public issues containing invoice data, OCR text, extracted fields, credentials, architecture secrets or customer identifiers.

## Reporting

Report suspected vulnerabilities through the organisation's approved private security channel and notify the repository owner. Include reproduction steps using synthetic data only.

## Repository rules

- No production invoices, screenshots, database dumps, OCR output, ground truth, model weights or prompts containing customer data.
- No credentials in commits, issues, workflow logs or pull-request descriptions.
- Use environment variables or the approved external secret manager.
- Require 2FA, least-privilege access, protected branches and reviewed pull requests.
- Enable GitHub secret scanning and push protection for the private repository.
- Rotate any credential immediately if it ever enters Git history; deleting a later commit is not sufficient.

## Third-party processing

Invoices are sent to the Gemini API for extraction. Before processing real supplier or bank data, confirm that the plan's data-use and retention terms, the processing region and your organisation's policy permit it. Keep `GEMINI_API_KEY` in a secret manager or an untracked `.env`, restrict processor egress to the Gemini endpoint where possible, and rotate the key immediately if it ever enters Git history.
