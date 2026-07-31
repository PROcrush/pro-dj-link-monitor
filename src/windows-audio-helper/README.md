# Windows WASAPI LTC helper

这是一个与 Electron 主进程隔离的 Windows 原生 helper。它不修改系统默认声卡，而是按 WASAPI render endpoint ID 直接写入目标设备（例如 `CABLE Input (VB-Audio Virtual Cable)`）。

固定音频格式：48 kHz、16-bit PCM、双声道、WASAPI shared/event-driven。LTC 支持 24、25、30 fps；左右声道发送相同信号。

## 构建

需要 Windows 10/11、Visual Studio 2022 Build Tools（Desktop development with C++）和 CMake。

```bat
cd src\windows-audio-helper
build.cmd x64
build.cmd arm64
```

输出位置固定为：

```text
bin/x64/prodjlink-wasapi-ltc.exe
bin/arm64/prodjlink-wasapi-ltc.exe
```

不依赖 NuGet、vcpkg 或其他第三方运行库；MSVC 运行库使用静态链接，便于随 Electron 安装包直接分发。

## 枚举输出设备

```bat
prodjlink-wasapi-ltc.exe --list-devices
```

stdout 只输出一个 JSON 对象：

```json
{"devices":[{"endpointId":"{0.0.0.00000000}...","name":"CABLE Input (VB-Audio Virtual Cable)","state":"active","default":false}]}
```

只枚举 active render endpoints。Node 应保存并传回 `endpointId`，不要只按显示名称绑定设备。

## 启动与 NDJSON 协议

```bat
prodjlink-wasapi-ltc.exe
```

stdin、stdout 都使用 UTF-8 NDJSON，一行一个对象。stdout 不写普通日志；错误也使用事件对象。

进程启动后先发送：

```json
{"event":"ready"}
```

Node 使用 `start` 打开或重开 endpoint。打开后保持静音，直到收到 `sync`：

```json
{"command":"start","endpointId":"{0.0.0.00000000}...","endpointName":"CABLE Input (VB-Audio Virtual Cable)","fps":25,"sampleRate":48000,"channels":2,"amplitude":0.55,"generation":7}
```

成功后返回同一 generation：

```json
{"event":"started","generation":7,"endpointId":"...","endpointName":"CABLE Input (VB-Audio Virtual Cable)"}
```

开始或重新锚定连续 LTC：

```json
{"command":"sync","generation":7,"sourceKey":"deck:2","elapsedMs":92341.5,"rate":1.0,"fps":25}
```

- `generation`：非负整数。helper 丢弃小于已接收 generation 的 `start`、`sync`、`hold`、`stop`。
- `sourceKey`：`sync` 必填，用于识别 Deck/Master 来源切换。
- `elapsedMs`：命令产生时的真实媒体位置，必须大于等于 0。
- `rate`：可省略，默认 `1.0`，范围 `0.25..4.0`。
- `fps`：可省略，默认沿用最近一次 `start`（诊断模式则使用 `--fps`），只接受 24、25、30。

helper 使用音频 presentation sample 作为单调时钟，后续时间位置为：

```text
elapsedMs + monotonicDeltaMs * rate
```

相同来源的持续 `sync` 只更新锚点，不重启 WASAPI 流；来源、fps 或静音状态变化时才清空旧缓冲。有效 `sync` 至少返回一次：

```json
{"event":"playing","generation":7,"sourceKey":"deck:2","elapsedMs":92342.110,"rate":1.000,"fps":25}
```

立即静音并清除已排队的旧 LTC：

```json
{"command":"hold","generation":7,"sourceKey":"deck:2"}
```

返回：

```json
{"event":"held","generation":7,"sourceKey":"deck:2","command":"hold"}
```

`hold` 输出真正的数字静音，不会重复或伪造 `00:00:00:00`。`stop` 是保持进程存活的静音别名，返回相同 `held` 事件并带 `"command":"stop"`。

结束进程：

```json
{"command":"shutdown","generation":7}
```

退出前返回：

```json
{"event":"stopped","generation":7}
```

stdin EOF 也会执行 shutdown。错误格式固定为：

```json
{"event":"error","generation":7,"message":"..."}
```

解析器以 `command` 为正式字段，同时兼容旧的 `cmd`。诊断时也可以使用 `--endpoint-id <id> [--fps 25]` 直接打开设备；该模式会以 generation 0 发送 `started`，但 Electron 集成应使用无参数启动加 `start` 命令。

## 当前验证边界

`tests/ltc_generator_test.cpp` 是可移植测试，验证 LTC sync word、已知时间码和 `rate=0.5` 时保持标准 LTC bit rate。WASAPI endpoint 枚举、VB-CABLE 写入、x64/ARM64 链接和 Resolume Arena 锁码必须在真实 Windows 机器上验证；macOS 不能加载或执行这些 Win32 COM/WASAPI 路径。
