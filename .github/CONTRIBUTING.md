# Contributing to PunditPay

Thanks for your interest in contributing! **PunditPay** was built for the
**Tether Developers Cup** and is released under the **Apache-2.0** license.

## Getting started

1. Fork this repository and clone your fork:
   ```bash
   git clone https://github.com/edycutjong/punditpay.git
   cd punditpay
   ```
2. Install dependencies (Node.js **>= 20**):
   ```bash
   npm install
   ```
3. Run the test suite:
   ```bash
   npm test
   ```
4. Try it out — see the **Quick start** section in the [README](../README.md).

## Making changes

- Keep the test suite green — `npm test` is enforced in CI.
- Match the existing code style; run `npm run lint` before pushing.
- Keep each pull request focused on one logical change.
- Update the README/docs when you change behavior.
- **Never commit** secrets, wallet seeds, `.env` files, or model blobs — see
  [`.gitignore`](../.gitignore).

## Submitting a pull request

1. Create a feature branch off `main`.
2. Make sure the full gate passes: `npm run ci` (or at least `npm test` +
   `npm run lint`).
3. Open a pull request using the template — describe **what** changed, **why**,
   and **how you verified it**.

## Reporting issues

- Bugs and feature requests: please use the **issue templates**.
- Security vulnerabilities: see [SECURITY.md](SECURITY.md) — do **not** open a
  public issue.

By contributing, you agree that your contributions will be licensed under the
Apache-2.0 license.
