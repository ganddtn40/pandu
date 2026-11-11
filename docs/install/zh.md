# 安装 Pandu

Pandu 是面向 AI 编程代理的本地飞行记录器与控制塔。它运行在你的电脑上，记录
代理的行为，并把所有飞行记录、设置和已配对设备保存在本机。没有账号、没有
云同步，也没有遥测。

本指南涵盖 Windows 桌面应用、Android 伴侣应用和可安装的 Web 应用（PWA）。
所有命令都可以直接复制。

**目录**

- [你需要什么](#你需要什么)
- [Windows 桌面应用](#windows-桌面应用)
- [Android 伴侣应用](#android-伴侣应用)
- [Web 应用（PWA）](#web-应用pwa)
- [命令行工具](#命令行工具)
- [故障排除](#故障排除)

## 你需要什么

| 部分 | 要求 |
| --- | --- |
| Windows 应用 | Windows 10 或 11，64 位。Microsoft Edge WebView2（当前 Windows 已包含；安装程序可下载）。 |
| Android 伴侣 | Android 10 或更高版本。手机到电脑的网络路径：`tailscale serve` 或其他 HTTPS 隧道。 |
| PWA | 最新版 Chrome、Edge、Safari 或 Firefox。页面必须通过 HTTPS 提供。 |
| 运行 Pandu 的电脑 | 守护进程和 CLI 支持 Windows、macOS、Linux。本版本的桌面外壳仅支持 Windows。 |

推荐的 Windows 安装程序**不需要**管理员权限，也**不需要**任何账号。

## Windows 桌面应用

### 选择文件

从同一个 GitHub 发布页面下载。不要混用不同版本的文件。

| 文件 | 适用场景 |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **推荐。** 按用户安装，不弹出管理员提示。 |
| `Pandu_0.2.0_x64_en-US.msi` | 为组织部署软件。按机器安装，需要管理员权限。 |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | 完全不想用安装程序。解压后运行。 |

版本号会随每次发布变化。除非发布说明另有说明，请使用最新的稳定版。

### 先校验下载

每个发布都包含 `SHA256SUMS`。把它下载到安装程序旁边，然后在那个文件夹打开
PowerShell：

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

两个哈希必须完全一致。如果不一致，删除文件并重新下载。即使页面看起来很官方，
也不要运行哈希不匹配的文件。

### 安装（推荐，按用户）

1. 双击 `Pandu_0.2.0_x64-setup.exe`。
2. 如果 Windows 显示 **Windows protected your PC**，选择 **More info**，然后
   点击 **Run anyway**。仅当文件来自官方发布页面且 SHA-256 已匹配时才这样做。
   除非发布说明提到 Authenticode 证书，否则发布版本未签名。
3. 按安装程序提示操作。它为你当前账户安装，不会要求管理员权限。
4. 如果缺少 WebView2，安装程序会下载 Microsoft 的 Evergreen 引导程序。这是
   安装程序唯一需要联网的时刻。
5. 从开始菜单启动 Pandu。

安装程序不会添加开机启动项。自动启动**默认关闭**。

### 首次运行

Pandu 窗口打开并启动本地守护进程。守护进程监听一个空闲的环回端口，因此只能
从你的电脑访问。UI 已打包在应用内；Pandu 不会加载远程网页内容。

- **关闭窗口不会退出。** Pandu 会留在通知区域继续记录。使用托盘图标重新
  打开。
- **退出是显式操作。** 右键点击托盘图标，选择 **Quit Pandu**。
- **自动启动。** 如果希望登录时启动，在托盘菜单勾选 **Start Pandu with
  Windows**。取消勾选即可关闭。
- **你的数据**位于 `%USERPROFILE%\.pandu`。数据库是
  `%USERPROFILE%\.pandu\v2\pandu.db`；设置、快照和备份也在同一目录树中。

### 深层链接

Pandu 注册 `pandu://` URL 协议。像 `pandu://flights/<flight-id>` 这样的链接
会在桌面应用中打开对应飞行记录。链接会被校验：未知路径和不安全的片段会被
忽略。Pandu 绝不会从链接打开任意远程页面。

### 用于托管部署的 MSI

MSI 是按机器安装，面向已经使用组策略、Intune 或其他包管理器的 IT 部门。

- 需要管理员权限。
- 为电脑上的所有用户安装。
- 用户数据仍保存在每个用户的 `%USERPROFILE%\.pandu`。
- NSIS 的删除数据询问不适用于 MSI。卸载 MSI 后，只有在你也想删除飞行记录和
  设置时，才手动删除 `%USERPROFILE%\.pandu`。

### 便携版

1. 把 `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` 解压到你控制的文件夹。
2. 运行 `Pandu.exe`。不需要安装程序，也不需要管理员权限。
3. 必须已安装 WebView2。当前 Windows 已包含；如果 Pandu 无法启动，请从
   <https://developer.microsoft.com/microsoft-edge/webview2/> 安装 Evergreen
   Runtime。
4. 删除时，先从托盘退出，删除文件夹，然后只有在你也想删除数据时才删除
   `%USERPROFILE%\.pandu`。

### 卸载

1. 从托盘退出 Pandu。
2. 打开 **设置 > 应用 > 已安装的应用**，找到 **Pandu**，选择 **卸载**。
3. 卸载程序会询问是否删除 `%USERPROFILE%\.pandu`。默认是 **否**。选择
   **否** 可保留飞行记录、设置、快照、备份和已配对设备。只有确定要永久删除
   时才选择 **是**。
4. 静默卸载始终保留数据文件夹。

## Android 伴侣应用

伴侣应用是手机上的小型受限面板。它可以查看飞行记录并回答审批请求，但不能
启动代理或更改设置。它是可选的。

简要步骤：

1. 在电脑上打开 **Settings > Remote access**，启用远程访问。选择 Tailscale
   模式，运行 Pandu 显示的 `tailscale serve` 命令。
2. 从同一个发布页面下载已签名的 APK。
3. 允许浏览器或文件管理器安装未知来源应用，然后打开 APK。
4. 在手机上打开 Pandu，扫描电脑上的二维码。
5. 在电脑上批准设备。新设备只拥有 **Status** 权限。

完整指南（包括权限、电池设置、通知渠道和 `apksigner` 校验）见
[android.md](android.md)。

## Web 应用（PWA）

PWA 是同一个远程面板，从浏览器安装。它需要一个能访问你电脑的 HTTPS URL，
通常由 `tailscale serve` 提供。

简要步骤：

1. 在电脑上启用远程访问并启动 `tailscale serve`。
2. 在手机或另一台电脑上打开 HTTPS URL。
3. 使用浏览器菜单选择 **安装应用** 或 **添加到主屏幕**。
4. 用电脑上显示的代码配对设备。

完整指南（包括缓存规则和限制）见 [pwa.md](pwa.md)。

## 命令行工具

`pandu` CLI 与桌面应用是分开的。如果你要自己运行守护进程、使用
`pandu run -- <agent>` 或运行诊断，请安装它。

1. 下载 `pandu-cli-x86_64-pc-windows-msvc.zip` 和 `SHA256SUMS`。
2. 如上所述用 `Get-FileHash` 校验压缩包。
3. 解压。zip 包含 `pandu-cli-x86_64-pc-windows-msvc` 文件夹和 `pandu.exe`。
4. 把该文件夹加入 `PATH`，或用完整路径运行 `pandu.exe`。

发布还包含 `pandu-cli-installer.ps1`，为当前用户安装 CLI。如果你想确切知道
它写入哪里，请先阅读脚本再运行。

有用的首批命令：

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` 检查数据库、适配器、日志监视器和正在运行的守护进程。
`pandu pair` 打印短期配对码和手机使用的远程 URL。

## 故障排除

如果出现问题，请阅读 [troubleshooting.md](troubleshooting.md)。它涵盖
SmartScreen、WebView2、端口冲突、防火墙提示、配对失败、通知问题，以及如何
在不丢失数据的情况下重置 Pandu。

### 快速总结

- **SmartScreen：** 校验 SHA-256，然后仅对官方发布文件选择
  **More info > Run anyway**。
- **缺少 WebView2：** 安装 Microsoft Evergreen Runtime，然后重启 Pandu。
- **无法安装 APK：** 只为你使用的浏览器或文件管理器允许
  **安装未知应用**，然后重试。
- **Android 通知延迟：** WorkManager 最多每 15 分钟检查一次。把电池设为
  **Unrestricted**，并且不要静音你需要的通知渠道。
- **PWA 无法安装：** 确认页面使用 HTTPS，并使用 Chrome、Edge 或 Safari。

## 隐私（一段话）

Pandu 在本地记录。桌面应用只与环回地址上的守护进程通信。远程访问默认关闭，
且只能从电脑上启用。更新检查是最多每 24 小时一次发往 GitHub 的 HTTPS 请求，
可以关闭。没有遥测、没有云同步、没有后台上传。完整说明见
[privacy.md](../privacy.md)。
