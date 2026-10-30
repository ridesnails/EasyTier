# agent —— 节点侧常驻组件

| 文件 | 用途 |
|---|---|
| `et-report.sh` | Linux/macOS 节点上报（bash + curl），由 systemd / launchd 常驻 |
| `et-report-docker.sh` | Docker 节点上报（官方 Alpine 镜像没有 bash/curl，用 sh + busybox wget） |
| `et-report.service` / `et-report.env.example` | systemd 单元与 env 模板 |
| `co.easytier.report.plist` | macOS launchd 模板（**token 不要写进 plist**，见下） |

## 两个真机踩过的坑

### 1. 节点在透明代理后面时，EasyTier 自己的流量会被代理接走

典型场景：OpenWrt / ImmortalWRT 主路由同时跑 sing-box 做透明分流（nft redirect + `ip rule`）。
这时 EasyTier 的 WSS/UDP 打洞也会被 redirect 到 sing-box，表现是**中继延迟高、丢包大**，
而且代理一挂组网就断。

EasyTier **2.7.0 起**给了 `--socket-mark`（env `ET_SOCKET_MARK`，仅 Linux）：给底层 socket
打 SO_MARK，让 `ip rule` / nftables 能把它按"直连"放行。

本项目的路由器（sing-box 分流）上，mark 语义是：

```
ip rule 9000:  fwmark 0x2024/0x2027 goto 9002   ← 0x2024 = 直连（跳过代理表）
ip rule 9001:  fwmark 0x2023/0x2027 lookup 2022 ← 0x2023 = 走代理
ip rule 32768: not fwmark 0x2024/0x2027 lookup 2022
```

所以加 `--socket-mark 8228`（= 0x2024）即可。效果对比（qwrt → 中继）：

| | 延迟 | 丢包 |
|---|---|---|
| 未打标 | 574 ms | 35% |
| 打标后 | 314 ms | 0% |

> 顺带：mesh 网段本身要在 sing-box 的本地地址集里（如 `inet4_local_address_set` 含
> `10.10.1.0/24`），否则**到节点的流量**也会被 redirect。

**LuCI 的 `luci-app-easytier`（`etcmd=config` 模式）不认 TOML 里的 mark 字段**，因为它
启动命令是写死的 `easytier-core -c config.toml --console-log-level X`。可用的做法是在
init 里加一行读 UCI 的 `list extra_args` 并拼到命令行：

```sh
# /etc/init.d/easytier，check_config() 内（运行命令那行之前）
et_extra="$(grep -o 'list extra_args .*' /etc/config/easytier | sed "s/.*extra_args //; s/'//g" | tr '\n' ' ')"
# 运行命令追加 ${et_extra}
cd /tmp ; ${easytierbin} -c ${config_file} --console-log-level ${log} ${et_extra} >> /tmp/easytier.log 2>&1 &
```

UCI 侧：

```sh
uci add_list easytier.@easytier[0].extra_args='--socket-mark'
uci add_list easytier.@easytier[0].extra_args='8228'
uci commit easytier && /etc/init.d/easytier restart
```

### 2. 上报脚本的 macOS / BSD 兼容

`et-report.sh` 早期用 `date -Is`，BSD date 会报 `invalid argument 's'`；已改为
`now_iso()` 可移植写法。另外主域名 `et.yi.uy` 在部分网络下 TLS 握手会拖到 20s+，
curl 超时已放宽到 20s，必要时把 `ET_HUB_URL` 指向 workers.dev 备用域。

### 3. token 不要写进 launchd plist

`co.easytier.report.plist` 的模板里有 `EnvironmentVariables`，但 plist 是 0644 世界可读的。
生产上改成运行时读 0600 的 env 文件：

```xml
<key>ProgramArguments</key><array>
  <string>/bin/bash</string><string>-c</string>
  <string>set -a; . /etc/easytier/report.env; exec /bin/bash /usr/local/bin/et-report.sh</string>
</array>
```
