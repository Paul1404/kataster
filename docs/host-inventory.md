# Hostinventar aus Stalwart und GitOps

Der Connector `managed-host` empfängt alle 15 Minuten einen vollständigen,
validierten Bericht eines Hosts. Er ersetzt keine Mailsoftware und greift nicht
in Mailfluss, Backups oder Website-Releases ein. Der mitgelieferte Pythonexporter
liest ausschließlich ausgewählte Accountfelder, rootless Podman-Metadaten und
die Zusammenfassung des letzten erfolgreichen B2-Backups. Er führt kein Backup
aus und liest keine Mailinhalte oder Accountzugangsdaten aus der API.

## Einrichtung

`scripts/host-inventory/exporter.py` wird als `/usr/local/libexec/kataster-inventory.py`
installiert. Die beiden gleichnamigen systemd-Dateien kommen nach
`/etc/systemd/system/`. Die private Konfiguration `/etc/kataster-exporter.json`
hat Modus 0600. Sie enthält `hostname`, `endpoint` (HTTPS MCP), `token`,
`stalwartSecretFile`, `backupStatusFile`, `excludedAccounts` und `sites`.
Ein Siteeintrag hat `user` und optional `domain`. Die Stalwartdatei referenziert
einen vorhandenen lesenden lokalen API-Schlüssel. Keine Schlüssel in Git ablegen.

Einen eigenen zufälligen Exportertoken außerhalb des Chats erzeugen. Nur dessen
SHA-256 über `register_host_token` registrieren. Der registrierte Token erhält
`host:<hostname>` und darf ausschließlich `sync_host_inventory` für diesen
Host aufrufen. Er hat weder Kundenlesezugriff noch Rechte zur Preisänderung,
Rechnungserstellung oder zum Registrieren weiterer Zugänge. Der Agententoken
mit Schreibrecht bleibt unabhängig davon erhalten.

Vor dem Aktivieren `--collect-only` privat ausführen und Hostidentität, Anzahl
der Postfächer sowie Container mit dem laufenden Betrieb vergleichen. Danach
einen echten Export durchführen und über MCP unabhängig zurücklesen. Erst bei
Erfolg `kataster-inventory.timer` aktivieren. Der Export braucht root nur für
lokale Inventarlesevorgänge und das Wechseln zu den Website-Benutzern; er bietet
keinen eingehenden Verwaltungszugang an. Fehler dürfen nie als leere erfolgreiche
Inventarliste übertragen werden. Der Export schreibt nur Zähler in sein Journal.

## Datenvertrag und Historie

`HostSnapshotSchema` in `src/server/host-inventory/schema.ts` ist der strikte
Laufzeitvertrag. Unbekannte Felder, doppelte Identitäten, ältere als 30 Minuten
alte Eingaben und mehr als fünf Minuten zukünftige Uhren werden abgewiesen.
Ein Hostbericht darf nur neuere Beobachtungen ersetzen. Der Abgleich läuft unter
einer Host-Sperre in einer Datenbanktransaktion. Der Worker prüft die Frische des
letzten Berichts; er gibt gecachte Daten nicht als frisch entdeckte Objekte aus.

Vorhandene Mailbox-CIs werden anhand der Adresse von Mailcow zu Stalwart
übernommen. IDs und manuelle Eigentümer bleiben erhalten. Der Anbieterwechsel
und Statusänderungen werden protokolliert. Neue Container haben stabile
Identitäten aus Host, Site und Containername. Nicht mehr gemeldete Objekte aus
dieser Quelle werden außer Betrieb genommen, niemals gelöscht. Der alte Betrieb
wird erst nach bestätigtem Export über `retire_infrastructure` stillgelegt.
Historische Kosten werden dabei nicht gelöscht oder rückwirkend auf null gesetzt.

## Kosten

`hostMonthlyCents` ist der belegte wiederkehrende EUR-Monatspreis.
`backupMonthlyCents` ist eine EUR-Speicherschätzung. Beide optionalen Werte
werden nur übernommen, wenn vorhanden. Fehlende Beträge werden nicht als null
interpretiert. B2 wird im Poolnamen als Speicherschätzung gekennzeichnet und
mit `estimated: true` gespeichert. Die Werte beschreiben monatlichen Betrieb,
keinen Zahlungsnachweis und keine Gründungs-EÜR. Bei einem Mischhost verteilt
der Pool Kosten auf Container und die unmittelbar zugehörigen Postfächer.

Die B2-Basis ist das erwartete gespeicherte Volumen, keine Multiplikation der
Anzahl täglicher Vollbackups: restic dedupliziert. Zum 25.10.2026 nennt Backblaze
6,95 USD je TB und 30 Tage, mit 10 GB freiem Speicher. Zusätzlicher Speicher,
Versionen, Downloadüberschreitungen, Wechselkurs und Steuern können die Rechnung
ändern. Quellen: https://www.backblaze.com/cloud-storage/pricing und
https://stalw.art/docs/ref/object/account/ .
