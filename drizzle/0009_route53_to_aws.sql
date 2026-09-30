-- Custom SQL migration file, put your code below! --
-- The route53 connector was unified into a broader "aws" connector (DNS +
-- registry + CloudFront + SES). connectorId is plain text with no FK, so move
-- existing rows over and backfill the new service-toggle config defaults. The
-- AWS secret schema is a superset of route53's, so encrypted secrets stay valid.
UPDATE "connections" SET "connector_id" = 'aws' WHERE "connector_id" = 'route53';
--> statement-breakpoint
UPDATE "assets"
SET "connector_id" = 'aws',
    "config" = "config" || '{"pullDns":true,"pullRegistry":true,"pullWeb":true,"pullSes":true,"sesRegion":"eu-central-1"}'::jsonb,
    "target" = '*'
WHERE "connector_id" = 'route53';
