# PRO DJ LINK Monitor — 非官方项目

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/PROcrush/pro-dj-link-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/PROcrush/pro-dj-link-monitor/actions/workflows/ci.yml)

一款面向 macOS 和 Windows 的开源 PRO DJ LINK 监听器，用于监看 DJ
播放状态、波形，并为时间码导向的 VJ 工作流提供桥接。

> 这是一个独立、非官方的互操作项目，与 AlphaTheta Corporation、Pioneer
> Corporation/Pioneer DJ、TC Supply 或 Resolume B.V. 无隶属、认可、赞助、
> 授权或认证关系。

本项目以源代码为主。可以从
[v1.4.4 预发布版](https://github.com/PROcrush/pro-dj-link-monitor/releases/tag/v1.4.4)
下载未签名安装包；目前尚未发布经过签名和公证的二进制文件。

## 下载

| 平台 | 安装包 | 架构 |
| --- | --- | --- |
| macOS | DMG 或 ZIP | Apple Silicon（`arm64`） |
| Windows | NSIS 安装版或便携版 EXE | x64 |

v1.4.4 是**未签名预发布版**。macOS Gatekeeper 或 Windows SmartScreen
可能提示“未知开发者/发布者”。打开前请使用 Release 中的 `SHA256SUMS.txt`
核对文件。当前版本不包含 Intel Mac 和 Windows ARM64 安装包。

> **兼容性提示：**CDJ-3000X、CDJ-1500X 目前均未进行实机测试，是否兼容尚不明确。
> 由于监听器的兼容层会在网络中占用一个 Virtual CDJ 身份，运行监听器时建议最多只连接
> 3 台实体 CDJ，以获得更稳定的现场表现。

## 主要功能

- 监听所选本地网络上的 PRO DJ LINK 设备广播、节拍/状态包和 DBServer 元数据。
- 最多显示四个 Deck；数据可用时可显示曲名、艺人、BPM、播放状态、时间、封面、
  波形、Beat Grid 和 Cue。
- 通过本机 WebSocket 发布统一 Deck 状态，并可选择输出 OSC。
- 用户明确开启后，可提供可信局域网 Web 监看页面。
- 支持面向 Resolume 的 BPM/Downbeat 输出，以及实验性的 TCNet 捕获与研究工作流。
- 生成连续 LTC 音频。Windows 使用原生 WASAPI 辅助程序输出到 VB-CABLE 等端点；
  macOS 可使用已安装的虚拟声卡。

当时间来源缺失或过期时，时间信息会保持不可用，不会伪造 `00:00:00:00`。

## 安全边界

监听器**不会**向 CDJ 发送加载曲目、播放、暂停、Master、Sync 或轨道控制命令。

应用并非完全不发送网络数据：

- Virtual CDJ 兼容探测会在本地网络声明一个逻辑身份，使兼容播放器能够返回元数据和波形。
- OSC、Arena、TCNet 和 LTC 输出只有在用户启用后才会发送。
- 原始 TCNet 捕获会记录监听到的数据包，用于诊断。

请在隔离且可信的 DJ/Show Control 网络中使用，并在正式演出之外先测试所有改动。

## 快速开始

1. 把电脑、CDJ/DJM 连接到同一个有线局域网交换机。
2. 安装依赖并启动：

   ```sh
   npm ci
   npm start
   ```

3. 在应用中选择连接 DJ 设备的有线 IPv4 网卡，然后开始监看。
4. macOS 首次运行时允许“本地网络”访问；Windows 弹出防火墙提示时只允许可信专用网络。
5. Web/WS 默认仅本机可访问。只有可信手机或另一台电脑需要监看时，才在高级设置中开启
   “可信 LAN”。

看到 Deck 连接状态、BPM 和实时播放信息表示基础监听成功。曲名、波形和 Cue 还需要
兼容播放器、正确的 Virtual CDJ 网卡以及可访问的 DBServer 数据。

## 运行要求

- 源码开发需要 Node.js 22.12 或更高版本。
- 支持 macOS 和 Windows；目前不支持 Linux。
- 电脑需通过有线 IPv4 网卡与 DJ 设备处于同一可信局域网。
- Resolume Arena、BlackHole、VB-CABLE 均由各自厂商单独提供和授权，本项目不捆绑。

## 设备兼容性与 CDJ 数量建议

- **CDJ-3000X：**尚未测试，兼容性未知。
- **CDJ-1500X：**尚未测试，兼容性未知。
- 播放器固件、Mixer/网络拓扑以及设备编号分配都可能影响兼容性。正式演出前必须用
  实际设备组合进行离线测试。

监听器的 Virtual CDJ 兼容层会声明一个逻辑播放器身份，使兼容设备返回元数据和波形。
因此当前预览版的现场建议是：**运行监听器时最多连接 3 台实体 CDJ**。这是稳定性建议，
不是经过厂商认证的协议硬限制。

## 从源码开发

```sh
npm ci
npm test
npm start
```

测试套件使用 Fixture，不要求连接实体 DJ 硬件。原生音频端点路由和真实 LTC 锁定仍需在
目标平台与硬件上进行冒烟测试。

## 网络接口

| 接口 | 默认状态 | 绑定/目标 | 说明 |
| --- | --- | --- | --- |
| PRO DJ LINK UDP | 监听器运行时监听 | 所选本地网卡 | 端口 50000、50001、50002、50004 |
| TCNet UDP 捕获 | 监听器运行时监听 | 本地网卡 | 端口 60000、60001、60002、65023、65024 |
| WebSocket | 开启 | `127.0.0.1:7071` | 本机 JSON 状态输出 |
| Web Console | 开启 | `127.0.0.1:7072` | 只有明确开启可信 LAN 后才绑定局域网 |
| OSC | 关闭 | `127.0.0.1:9000` | 用户可修改目标地址 |
| Arena Web API | 关闭 | `127.0.0.1:8080` | BPM/Downbeat 回退；默认不持续拖动 Clip |
| Audio LTC | 关闭 | 所选音频端点 | 必须显式配置虚拟/物理路由 |

可信 LAN Web Console 不提供账号认证或 TLS。禁止把 7071/7072 端口映射到公网，也不要在
不可信 Wi-Fi/VLAN 中使用。详见 [SECURITY.md](SECURITY.md)。

## 时间与输出

Deck 时间只计算一次，并由桌面 UI、LAN Viewer、OSC、Arena 和 LTC 共享。系统优先使用
新鲜的绝对位置包，并可使用 Beat Grid 时间作为回退。Deck 暂停时会保持最后一个有效锚点，
而不是继续漂移。

常用 OSC 字段包括：

- `/vj/deck/{deck}/timingValid`
- `/vj/deck/{deck}/timecode`
- `/vj/deck/{deck}/timecode/frame`
- `/vj/arena/sourceDeck`
- `/vj/arena/timingValid`
- `/vj/arena/timecode`
- `/vj/arena/elapsed`
- `/vj/arena/progress`

`LTC delay compensation` 只影响生成的 LTC 音频，不会移动统一 Deck、OSC 或 TCNet 时间。

## 构建应用

macOS Apple Silicon：

```sh
npm run package:mac
```

macOS Intel：

```sh
npm run package:mac:x64
```

公开分发 macOS 应用需要 Developer ID 签名和公证。macOS LTC 辅助程序通过
`/usr/bin/swift` 编译，因此该开发路径需要 Xcode Command Line Tools。

Windows x64 构建需在原生 Windows 10/11 环境安装 Visual Studio 2022 Build Tools
（Desktop development with C++）和 CMake：

```bat
npm run package:win
```

预打包步骤会构建匹配架构的 WASAPI 辅助程序。Windows ARM64 脚本仍属实验性，需在真实
ARM64 硬件验证。详见
[`src/windows-audio-helper/README.md`](src/windows-audio-helper/README.md)。

NSIS 安装版/便携版外层 Stub 可能显示为 32 位，但其中的 Electron 应用和辅助程序均为 x86-64。

## 仓库结构

```text
src/main.cjs                    Electron 主进程
src/renderer/                   桌面 UI
src/prolink/                    协议、时间与输出模块
src/windows-audio-helper/       原生 WASAPI LTC 辅助程序源码
tests/                          主回归测试
labs/timecode-consistency/      隔离的时间/捕获实验
labs/ltc-audio-timecode/        LTC 渲染与路由实验
docs/                           可公开的架构/研究文档
```

生成的安装包、原生二进制、WAV 和真实数据包捕获不会提交到 Git。运行 macOS 驱动实验时，
请从 BlackHole 官方仓库单独克隆源码。

## 捕获与诊断隐私

TCNet 和 PRO DJ LINK 捕获可能包含精确时间、私网 IP、设备型号和曲目元数据。不要把真实
现场捕获直接附到公开 Issue。请创建小型合成 Fixture，或彻底清理所有可识别字段。

自动波形失败日志写入磁盘前会做隐私缩减；用户主动导出的诊断可能包含更多细节，分享前
必须人工检查。

## 参与贡献

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。项目坚持“不控制 CDJ”的安全边界，
协议、时间和输出生命周期改动必须补充测试。

## 致谢

协议互操作研究基于 Deep Symmetry 社区及相关开源项目的公开工作。来源、许可证和署名详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

项目原创代码采用 MIT License。单独标识的 `src/prolink/virtualCdj.cjs` 因启动模板和逻辑
改编自 Deep Symmetry 的 beat-link 项目，采用 EPL-2.0。详见 [LICENSE](LICENSE)、
[LICENSES/EPL-2.0.txt](LICENSES/EPL-2.0.txt) 和
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

所有产品名称和商标均属于其各自权利人。
