# Public source boundary

This repository starts from a reviewed source snapshot with fresh Git history.
The earlier private repository remains archived separately. It is not a source
for public merges: importing its branches would reintroduce private history.

Examples and tests use fictional customers and reserved example domains.
Runtime inventory, customer records, contacts, pricing, provider responses,
credentials, notification destinations, and invoice sender details remain in
the operator's own database or deployment configuration.

The existing MIT license is retained. Publishing the code does not open the
operator's running application. Public registration is disabled; all accounts
are trusted operators who can access the whole register. This is not a tenant
isolation or per-customer access model.

Migrations are deliberately byte-identical to the private source snapshot.
The historical display-name migration contains two public hostname references.
They identify legacy labels, not credentials or exported records. Keeping the
applied SQL unchanged preserves migration integrity for existing databases.

Review new public assets and fixtures for private data. Keep `.env`, database
exports, provider responses, and local agent configuration out of Git. Run the
history secret scan and quality checks before publishing a release.
