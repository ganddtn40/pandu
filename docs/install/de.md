# Pandu installieren

Pandu ist ein lokaler Flugschreiber und Kontrollturm für KI-Coding-Agenten. Es
läuft auf deinem Computer, zeichnet auf, was deine Agenten tun, und speichert
alle Flüge, Einstellungen und gekoppelten Geräte auf deiner Maschine. Es gibt
kein Konto, keine Cloud-Synchronisierung und keine Telemetrie.

Diese Anleitung behandelt die Windows-Desktop-App, den Android-Begleiter und
die installierbare Web-App (PWA). Alle Befehle können kopiert werden.

**Inhalt**

- [Was du brauchst](#was-du-brauchst)
- [Windows-Desktop-App](#windows-desktop-app)
- [Android-Begleiter](#android-begleiter)
- [Web-App (PWA)](#web-app-pwa)
- [Kommandozeilenwerkzeug](#kommandozeilenwerkzeug)
- [Fehlerbehebung](#fehlerbehebung)

## Was du brauchst

| Teil | Voraussetzungen |
| --- | --- |
| Windows-App | Windows 10 oder 11, 64 Bit. Microsoft Edge WebView2 (in aktuellem Windows enthalten; der Installer kann es herunterladen). |
| Android-Begleiter | Android 10 oder neuer. Ein Netzwerkweg vom Telefon zum Computer: `tailscale serve` oder ein anderer HTTPS-Tunnel. |
| PWA | Aktuelles Chrome, Edge, Safari oder Firefox. Die Seite muss über HTTPS ausgeliefert werden. |
| Computer mit Pandu | Windows, macOS oder Linux für Daemon und CLI. Die Desktop-Hülle ist in dieser Version nur für Windows. |

Für den empfohlenen Windows-Installer brauchst du **keine**
Administratorrechte und **kein** Konto.

## Windows-Desktop-App

### Datei auswählen

Lade die Dateien von derselben GitHub-Release-Seite. Mische keine Dateien aus
verschiedenen Releases.

| Datei | Verwenden, wenn |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Empfohlen.** Installation pro Benutzer, keine Administratorabfrage. |
| `Pandu_0.2.0_x64_en-US.msi` | Du Software für eine Organisation bereitstellst. Installation pro Computer; Administratorrechte nötig. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Du gar keinen Installer willst. Entpacken und starten. |

Die Versionsnummer ändert sich mit jedem Release. Nimm das neueste stabile
Release, sofern die Release-Hinweise nichts anderes sagen.

### Download zuerst prüfen

Jedes Release enthält `SHA256SUMS`. Lade die Datei neben den Installer und öffne
PowerShell in diesem Ordner:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Die beiden Hashes müssen exakt übereinstimmen. Wenn nicht, lösche die Datei und
lade sie erneut. Starte niemals eine Datei mit falschem Hash, auch wenn die
Seite offiziell aussieht.

### Installieren (empfohlen, pro Benutzer)

1. Doppelklicke auf `Pandu_0.2.0_x64-setup.exe`.
2. Wenn Windows **Windows protected your PC** zeigt, wähle **More info** und
   dann **Run anyway**. Tu das nur, wenn die Datei von der offiziellen
   Release-Seite stammt und der SHA-256 geprüft wurde. Release-Builds sind
   unsigniert, sofern die Hinweise kein Authenticode-Zertifikat nennen.
3. Folge dem Installer. Er installiert für dein Konto und fragt nicht nach
   Administratorrechten.
4. Fehlt WebView2, lädt der Installer Microsofts Evergreen-Bootstrapper. Das ist
   der einzige Moment, in dem er Internet braucht.
5. Starte Pandu über das Startmenü.

Der Installer legt keinen Autostart-Eintrag an. Autostart ist **standardmäßig
aus**.

### Erster Start

Das Pandu-Fenster öffnet sich und startet den lokalen Daemon. Der Daemon hört
auf einem freien Loopback-Port und ist damit nur von deinem Computer erreichbar.
Die Oberfläche ist in der App enthalten; Pandu lädt keine entfernten
Webinhalte.

- **Das Fenster zu schließen beendet Pandu nicht.** Pandu läuft im
  Infobereich weiter und zeichnet weiter auf. Über das Tray-Symbol öffnest du
  es wieder.
- **Beenden ist ausdrücklich.** Rechtsklick auf das Tray-Symbol, dann **Quit
  Pandu**.
- **Autostart.** Aktiviere **Start Pandu with Windows** im Tray-Menü, wenn
  Pandu bei der Anmeldung starten soll. Deaktivieren entfernt den Eintrag.
- **Deine Daten** liegen in `%USERPROFILE%\.pandu`. Die Datenbank ist
  `%USERPROFILE%\.pandu\v2\pandu.db`; Einstellungen, Snapshots und Backups
  liegen im selben Baum.

### Deep Links

Pandu registriert das URL-Schema `pandu://`. Ein Link wie
`pandu://flights/<flight-id>` öffnet die Desktop-App bei diesem Flug. Links
werden geprüft: unbekannte Pfade und unsichere Segmente werden ignoriert. Pandu
öffnet niemals beliebige entfernte Seiten aus einem Link.

### MSI für verwaltete Bereitstellung

Das MSI ist eine Installation pro Computer für IT-Abteilungen, die bereits
Gruppenrichtlinien, Intune oder einen anderen Paketmanager nutzen.

- Administratorrechte erforderlich.
- Installation für alle Benutzer des Computers.
- Benutzerdaten bleiben im jeweiligen `%USERPROFILE%\.pandu`.
- Die NSIS-Frage zum Löschen der Daten gilt nicht für das MSI. Nach dem
  Deinstallieren des MSI lösche `%USERPROFILE%\.pandu` nur dann manuell, wenn
  du auch Flüge und Einstellungen entfernen willst.

### Portable Version

1. Entpacke `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` in einen Ordner
   deiner Wahl.
2. Starte `Pandu.exe`. Kein Installer, keine Administratorrechte.
3. WebView2 muss installiert sein. Aktuelles Windows enthält es; startet Pandu
   nicht, installiere die Evergreen Runtime von
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. Zum Entfernen beende Pandu über das Tray, lösche den Ordner und lösche
   `%USERPROFILE%\.pandu` nur, wenn du auch deine Daten entfernen willst.

### Deinstallieren

1. Beende Pandu über das Tray.
2. Öffne **Einstellungen > Apps > Installierte Apps**, suche **Pandu** und
   wähle **Deinstallieren**.
3. Der Deinstaller fragt, ob `%USERPROFILE%\.pandu` gelöscht werden soll. Die
   Voreinstellung ist **Nein**. Wähle **Nein**, um Flüge, Einstellungen,
   Snapshots, Backups und gekoppelte Geräte zu behalten. Wähle **Ja** nur, wenn
   du sie endgültig löschen willst.
4. Stille Deinstallationen behalten die Daten immer.

## Android-Begleiter

Der Begleiter ist ein kleines, begrenztes Dashboard für das Telefon. Er kann
Flüge beobachten und Genehmigungsanfragen beantworten, aber keine Agenten
starten oder Einstellungen ändern. Er ist optional.

**Experimentell:** Der Android-Begleiter wurde noch nicht auf einem Emulator und
einem echten Telefon geprüft. Die APK wird erst nach Abschluss der Prüfung an
Releases angehängt; baue sie aus dem Quellcode, wenn du sie testen möchtest.

Kurzfassung:

1. Öffne am Computer **Settings > Remote access** und aktiviere den
   Fernzugriff. Wähle den Tailscale-Modus und führe den von Pandu angezeigten
   Befehl `tailscale serve` aus.
2. Baue die APK aus dem Quellcode (experimentell); siehe
   [android.md](android.md).
3. Erlaube deinem Browser oder Dateimanager die Installation unbekannter Apps
   und öffne die APK.
4. Öffne Pandu auf dem Telefon und scanne den QR-Code vom Computer.
5. Bestätige das Gerät am Computer. Neue Geräte starten nur mit **Status**.

Die vollständige Anleitung mit Berechtigungen, Akku-Einstellungen,
Benachrichtigungskanälen und `apksigner`-Prüfung steht in
[android.md](android.md).

## Web-App (PWA)

Die PWA ist dasselbe entfernte Dashboard, installiert aus dem Browser. Sie
braucht eine HTTPS-URL, die deinen Computer erreicht, normalerweise über
`tailscale serve`.

Kurzfassung:

1. Aktiviere den Fernzugriff am Computer und starte `tailscale serve`.
2. Öffne die HTTPS-URL auf dem Telefon oder einem anderen Computer.
3. Wähle im Browsermenü **App installieren** oder **Zum Startbildschirm
   hinzufügen**.
4. Koppel das Gerät mit dem am Computer angezeigten Code.

Die vollständige Anleitung mit Cache-Regeln und Einschränkungen steht in
[pwa.md](pwa.md).

## Kommandozeilenwerkzeug

Die `pandu`-CLI ist von der Desktop-App getrennt. Installiere sie, wenn du den
Daemon selbst starten, `pandu run -- <agent>` verwenden oder Diagnosen
ausführen willst.

1. Lade `pandu-cli-x86_64-pc-windows-msvc.zip` und `SHA256SUMS`.
2. Prüfe das Archiv mit `Get-FileHash`, wie oben.
3. Entpacke es. Das Zip enthält einen Ordner
   `pandu-cli-x86_64-pc-windows-msvc` mit `pandu.exe`.
4. Lege den Ordner in den `PATH` oder starte `pandu.exe` mit vollem Pfad.

Das Release enthält außerdem `pandu-cli-installer.ps1`, das die CLI für den
aktuellen Benutzer installiert. Lies das Skript vor dem Ausführen, wenn du genau
wissen willst, wohin es schreibt.

Nützliche erste Befehle:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` prüft Datenbank, Adapter, Log-Watcher und einen laufenden Daemon.
`pandu pair` gibt einen kurzlebigen Kopplungscode und die entfernte URL für das
Telefon aus.

## Fehlerbehebung

Wenn etwas nicht funktioniert, lies [troubleshooting.md](troubleshooting.md).
Dort geht es um SmartScreen, WebView2, Portkonflikte, Firewall-Abfragen,
Kopplungsfehler, Benachrichtigungsprobleme und das Zurücksetzen von Pandu ohne
Datenverlust.

### Kurzübersicht

- **SmartScreen:** SHA-256 prüfen, dann **More info > Run anyway** nur für
  Dateien aus dem offiziellen Release.
- **WebView2 fehlt:** Evergreen Runtime von Microsoft installieren und Pandu
  neu starten.
- **APK lässt sich nicht installieren:** **Install unknown apps** nur für den
  verwendeten Browser oder Dateimanager erlauben und erneut versuchen.
- **Android-Benachrichtigungen verzögert:** WorkManager prüft höchstens alle 15
  Minuten. Akku auf **Unrestricted** stellen und den benötigten Kanal nicht
  stummschalten.
- **PWA lässt sich nicht installieren:** prüfen, ob die Seite HTTPS nutzt, und
  Chrome, Edge oder Safari verwenden.

## Datenschutz in einem Absatz

Pandu zeichnet lokal auf. Die Desktop-App spricht nur mit dem Daemon auf
Loopback. Fernzugriff ist standardmäßig aus und kann nur am Computer aktiviert
werden. Die Update-Prüfung ist eine HTTPS-Anfrage an GitHub, höchstens einmal
alle 24 Stunden, und kann deaktiviert werden. Es gibt keine Telemetrie, keine
Cloud-Synchronisierung und keine Hintergrund-Uploads. Die vollständige
Erklärung steht in [privacy.md](../privacy.md).
