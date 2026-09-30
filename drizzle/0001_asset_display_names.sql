UPDATE "assets" AS "a"
SET "name" = "ca"."name" || ' / PostgreSQL'
FROM "custom_apps" AS "ca"
WHERE "a"."custom_app_id" = "ca"."id"
  AND "a"."asset_key" IN ('db', 'database')
  AND "a"."name" NOT LIKE '% / PostgreSQL';
--> statement-breakpoint
UPDATE "assets" AS "a"
SET "name" = "ca"."name" || ' / Redis'
FROM "custom_apps" AS "ca"
WHERE "a"."custom_app_id" = "ca"."id"
  AND "a"."asset_key" = 'redis'
  AND "a"."name" NOT LIKE '% / Redis';
--> statement-breakpoint
UPDATE "assets" AS "a"
SET "name" = "ca"."name" || ' / Runtime'
FROM "custom_apps" AS "ca"
WHERE "a"."custom_app_id" = "ca"."id"
  AND "a"."asset_key" = 'system'
  AND "a"."name" NOT LIKE '% / Runtime';
--> statement-breakpoint
UPDATE "assets" AS "a"
SET "name" = "ca"."name" || ' / Object Storage'
FROM "custom_apps" AS "ca"
WHERE "a"."custom_app_id" = "ca"."id"
  AND "a"."asset_key" = 'bucket'
  AND "a"."name" NOT LIKE '% / Object Storage';
--> statement-breakpoint
UPDATE "assets" AS "a"
SET "name" = "ca"."name" || ' / ' || CASE
  WHEN "a"."name" ILIKE '%application%' THEN 'Application'
  ELSE 'API'
END
FROM "custom_apps" AS "ca"
WHERE "a"."custom_app_id" = "ca"."id"
  AND "a"."asset_key" IN ('api', 'app')
  AND "a"."name" NOT LIKE "ca"."name" || ' / %';
--> statement-breakpoint
UPDATE "assets"
SET "name" = 'AWS / Route 53 / Hosted Zones'
WHERE "connector_id" = 'route53'
  AND "target" = '*'
  AND "name" IN ('AWS Route 53 - All hosted zones', 'All hosted zones');
--> statement-breakpoint
UPDATE "assets"
SET "name" = 'pdcd.net / Mail'
WHERE "connector_id" = 'mailcow'
  AND "target" = 'mail.pdcd.net'
  AND "name" = 'mail.pdcd.net';
--> statement-breakpoint
UPDATE "assets"
SET "name" = 'schlossmuehle-untereuerheim.de / Website'
WHERE "connector_id" = 'http'
  AND "target" = 'https://schlossmuehle-untereuerheim.de'
  AND "name" = 'schlossmuehle-untereuerheim.de';
--> statement-breakpoint
UPDATE "assets"
SET "name" = "target" || ' / WordPress'
WHERE "connector_id" = 'wordpress'
  AND "name" = "target";
