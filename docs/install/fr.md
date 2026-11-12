# Installer Pandu

Pandu est un enregistreur de vol local et une tour de contrôle pour les agents
de codage IA. Il s'exécute sur votre ordinateur, enregistre ce que font vos
agents et conserve tous les vols, réglages et appareils associés sur votre
machine. Il n'y a ni compte, ni synchronisation cloud, ni télémétrie.

Ce guide couvre l'application de bureau Windows, le compagnon Android et
l'application web installable (PWA). Chaque commande peut être copiée.

**Sommaire**

- [Ce qu'il vous faut](#ce-quil-vous-faut)
- [Application de bureau Windows](#application-de-bureau-windows)
- [Compagnon Android](#compagnon-android)
- [Application web (PWA)](#application-web-pwa)
- [Outil en ligne de commande](#outil-en-ligne-de-commande)
- [Dépannage](#dépannage)

## Ce qu'il vous faut

| Élément | Configuration requise |
| --- | --- |
| Application Windows | Windows 10 ou 11, 64 bits. Microsoft Edge WebView2 (inclus dans Windows actuel ; l'installateur peut le télécharger). |
| Compagnon Android | Android 10 ou plus récent. Un chemin réseau du téléphone vers l'ordinateur : `tailscale serve` ou un autre tunnel HTTPS. |
| PWA | Chrome, Edge, Safari ou Firefox à jour. La page doit être servie en HTTPS. |
| Ordinateur avec Pandu | Windows, macOS ou Linux pour le daemon et la CLI. Le shell de bureau est réservé à Windows dans cette version. |

Vous n'avez **pas** besoin de droits administrateur pour l'installateur Windows
recommandé, et vous n'avez **pas** besoin de compte.

## Application de bureau Windows

### Choisir le fichier

Téléchargez-les depuis la même page de publication GitHub. Ne mélangez pas les
fichiers de versions différentes.

| Fichier | À utiliser quand |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Recommandé.** Installation par utilisateur, sans invite administrateur. |
| `Pandu_0.2.0_x64_en-US.msi` | Vous déployez des logiciels pour une organisation. Installation par machine ; droits administrateur requis. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Vous ne voulez aucun installateur. Décompressez et exécutez. |

Le numéro de version change à chaque publication. Utilisez la dernière version
stable, sauf indication contraire dans les notes.

### Vérifier le téléchargement

Chaque version inclut `SHA256SUMS`. Téléchargez-le à côté de l'installateur,
puis ouvrez PowerShell dans ce dossier :

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Les deux empreintes doivent être identiques. Sinon, supprimez le fichier et
retéléchargez-le. N'exécutez jamais un fichier dont l'empreinte ne correspond
pas, même si la page semble officielle.

### Installer (recommandé, par utilisateur)

1. Double-cliquez sur `Pandu_0.2.0_x64-setup.exe`.
2. Si Windows affiche **Windows protected your PC**, choisissez **More info**,
   puis **Run anyway**. Ne le faites que si le fichier vient de la page de
   publication officielle et que son SHA-256 correspond. Les versions publiées
   ne sont pas signées, sauf mention d'un certificat Authenticode dans les
   notes.
3. Suivez l'installateur. Il installe pour votre compte et ne demande pas de
   droits administrateur.
4. Si WebView2 manque, l'installateur télécharge le bootstrapper Evergreen de
   Microsoft. C'est le seul moment où il a besoin d'Internet.
5. Lancez Pandu depuis le menu Démarrer.

L'installateur n'ajoute pas d'entrée de démarrage. Le démarrage automatique est
**désactivé par défaut**.

### Premier lancement

La fenêtre Pandu s'ouvre et démarre le daemon local. Le daemon écoute sur un
port loopback libre ; il n'est donc accessible que depuis votre ordinateur.
L'interface est intégrée à l'application ; Pandu ne charge aucun contenu web
distant.

- **Fermer la fenêtre ne quitte pas.** Pandu reste dans la zone de
  notification pour continuer à enregistrer. Utilisez l'icône de la barre
  d'état pour le rouvrir.
- **Quitter est explicite.** Clic droit sur l'icône, puis **Quit Pandu**.
- **Démarrage automatique.** Cochez **Start Pandu with Windows** dans le menu
  de la barre d'état pour le lancer à l'ouverture de session. Décochez pour le
  désactiver.
- **Vos données** sont dans `%USERPROFILE%\.pandu`. La base est
  `%USERPROFILE%\.pandu\v2\pandu.db` ; les réglages, instantanés et sauvegardes
  sont dans la même arborescence.

### Liens profonds

Pandu enregistre le schéma `pandu://`. Un lien comme
`pandu://flights/<flight-id>` ouvre l'application sur ce vol. Les liens sont
validés : les chemins inconnus et les segments dangereux sont ignorés. Pandu
n'ouvre jamais de page distante arbitraire depuis un lien.

### MSI pour un déploiement géré

Le MSI est une installation par machine destinée aux services informatiques
qui utilisent déjà une stratégie de groupe, Intune ou un autre gestionnaire de
paquets.

- Droits administrateur requis.
- Installation pour tous les utilisateurs de la machine.
- Les données restent dans le `%USERPROFILE%\.pandu` de chaque utilisateur.
- La question NSIS sur la suppression des données ne s'applique pas au MSI.
  Après désinstallation du MSI, supprimez `%USERPROFILE%\.pandu` manuellement
  uniquement si vous voulez aussi effacer vols et réglages.

### Version portable

1. Décompressez `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` dans un
   dossier que vous contrôlez.
2. Lancez `Pandu.exe`. Aucun installateur ni droit administrateur.
3. WebView2 doit déjà être installé. Windows actuel l'inclut ; si Pandu ne
   démarre pas, installez Evergreen Runtime depuis
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. Pour le supprimer, quittez depuis la barre d'état, supprimez le dossier,
   puis supprimez `%USERPROFILE%\.pandu` seulement si vous voulez aussi vos
   données.

### Désinstaller

1. Quittez Pandu depuis la barre d'état.
2. Ouvrez **Paramètres > Applications > Applications installées**, cherchez
   **Pandu** et choisissez **Désinstaller**.
3. Le désinstallateur demande si `%USERPROFILE%\.pandu` doit être supprimé. La
   valeur par défaut est **Non**. Choisissez **Non** pour conserver vols,
   réglages, instantanés, sauvegardes et appareils associés. Choisissez **Oui**
   seulement si vous voulez tout effacer définitivement.
4. Les désinstallations silencieuses conservent toujours les données.

## Compagnon Android

Le compagnon est un petit tableau de bord limité pour le téléphone. Il peut
suivre les vols et répondre aux demandes d'approbation, mais il ne peut pas
démarrer d'agent ni modifier les réglages. Il est facultatif.

**Expérimental :** le compagnon Android n'a pas encore été vérifié sur un
émulateur et un téléphone physique. L'APK n'est pas joint aux versions tant que
ce n'est pas fait ; compilez-le depuis les sources pour l'essayer.

En bref :

1. Sur l'ordinateur, ouvrez **Settings > Remote access** et activez l'accès à
   distance. Choisissez le mode Tailscale et exécutez la commande
   `tailscale serve` affichée par Pandu.
2. Compilez l'APK depuis les sources (expérimental) ; voir
   [android.md](android.md).
3. Autorisez votre navigateur ou gestionnaire de fichiers à installer des
   applications inconnues, puis ouvrez l'APK.
4. Ouvrez Pandu sur le téléphone et scannez le QR code de l'ordinateur.
5. Approuvez l'appareil sur l'ordinateur. Les nouveaux appareils commencent
   avec **Status** uniquement.

Le guide complet, avec permissions, batterie, canaux de notification et
vérification `apksigner`, se trouve dans [android.md](android.md).

## Application web (PWA)

La PWA est le même tableau de bord distant, installé depuis le navigateur. Elle
nécessite une URL HTTPS qui atteint votre ordinateur, généralement via
`tailscale serve`.

En bref :

1. Activez l'accès à distance sur l'ordinateur et lancez `tailscale serve`.
2. Ouvrez l'URL HTTPS sur le téléphone ou un autre ordinateur.
3. Utilisez le menu du navigateur et choisissez **Installer l'application** ou
   **Ajouter à l'écran d'accueil**.
4. Associez l'appareil avec le code affiché sur l'ordinateur.

Le guide complet, avec les règles de cache et les limites, se trouve dans
[pwa.md](pwa.md).

## Outil en ligne de commande

La CLI `pandu` est distincte de l'application de bureau. Installez-la si vous
voulez lancer le daemon vous-même, utiliser `pandu run -- <agent>` ou exécuter
des diagnostics.

1. Téléchargez `pandu-cli-x86_64-pc-windows-msvc.zip` et `SHA256SUMS`.
2. Vérifiez l'archive avec `Get-FileHash`, comme ci-dessus.
3. Décompressez-la. Le zip contient un dossier
   `pandu-cli-x86_64-pc-windows-msvc` avec `pandu.exe`.
4. Ajoutez ce dossier au `PATH`, ou lancez `pandu.exe` par son chemin complet.

La publication inclut aussi `pandu-cli-installer.ps1`, qui installe la CLI pour
l'utilisateur courant. Lisez le script avant de l'exécuter si vous voulez savoir
exactement où il écrit.

Premières commandes utiles :

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` vérifie la base, les adaptateurs, la surveillance des journaux et
un daemon en cours d'exécution. `pandu pair` affiche un code d'association de
courte durée et l'URL distante pour le téléphone.

## Dépannage

Si quelque chose ne fonctionne pas, lisez
[troubleshooting.md](troubleshooting.md). Il couvre SmartScreen, WebView2, les
conflits de port, les invites du pare-feu, les échecs d'association, les
problèmes de notification et la réinitialisation de Pandu sans perte de
données.

### Résumé rapide

- **SmartScreen :** vérifiez le SHA-256, puis **More info > Run anyway**
  uniquement pour un fichier de la publication officielle.
- **WebView2 manquant :** installez Evergreen Runtime de Microsoft, puis
  redémarrez Pandu.
- **APK impossible à installer :** autorisez **Install unknown apps** seulement
  pour le navigateur ou gestionnaire de fichiers utilisé, puis réessayez.
- **Notifications Android en retard :** WorkManager vérifie au maximum toutes
  les 15 minutes. Réglez la batterie sur **Unrestricted** et ne coupez pas le
  canal dont vous avez besoin.
- **PWA impossible à installer :** vérifiez que la page est en HTTPS et utilisez
  Chrome, Edge ou Safari.

## Confidentialité en un paragraphe

Pandu enregistre localement. L'application de bureau ne parle qu'au daemon en
loopback. L'accès à distance est désactivé par défaut et ne peut être activé
que depuis l'ordinateur. La vérification des mises à jour est une requête HTTPS
vers GitHub au plus une fois toutes les 24 heures et peut être désactivée. Il
n'y a ni télémétrie, ni synchronisation cloud, ni envoi en arrière-plan. Voir
[privacy.md](../privacy.md) pour la déclaration complète.
