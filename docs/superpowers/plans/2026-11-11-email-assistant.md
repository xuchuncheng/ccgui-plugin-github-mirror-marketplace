# 邮箱助手（email-assistant）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 CCgui 邮箱插件（QQ 邮箱配置 UI + 连通性测试 + MCP 注册向导）与配套的 Python 零依赖 stdio MCP 服务（send_mail / list_recent_mails / get_mail 三工具）。

**Architecture:** 插件（Tier-1 JS，单 ESM + 纯逻辑命名导出）与 MCP 服务（Python 标准库包 `email_mcp`）通过磁盘文件 `~/.ccgui-next/plugin-data/email-assistant/profiles.json` 解耦：插件经 `plugin_exec_run` 调 python 原子写配置与注册 MCP，MCP 进程启动时只读该文件。MCP 为 JSON-RPC 2.0 over stdio，协议层与邮件层严格分模块。

**Tech Stack:** 原生 ESM（零 import，React 由 `ctx.react` 提供）、node:test；Python 3.13（仅标准库：smtplib / imaplib / email / json / argparse 无）、unittest。

**Spec:** `docs/superpowers/specs/2026-11-11-email-assistant-design.md`（执行者同时读 spec 与本计划；冲突以 spec 为准并停下确认）

## Global Constraints

- 插件根目录：`ccgui-plugin-email-assistant/`；manifest id 固定 `email-assistant`，name「邮箱助手」，version `0.1.0`，tier `js`，sdkVersion `^0.3`，minAppVersion `1.1.1`，license MIT。
- JS 侧零第三方依赖、零 import 语句（宿主不打包 node_modules）；React 元素一律 `ctx.react.createElement`，禁止 JSX。
- Python 侧零第三方依赖，只允许标准库；包目录 `mcp/email_mcp/`，所有模块不得 `import requests` 等第三方库。
- 凭据只允许写入 `~/.ccgui-next/plugin-data/email-assistant/profiles.json`（可被环境变量 `EMAIL_MCP_HOME` 覆盖根目录，仅测试用）；禁止写入 `ctx.storage`、日志、测试夹具、仓库任何文件。
- 所有面向用户的文案为中文；代码标识符英文。文件 UTF-8、LF（仓库 git 会按本机规则处理 CRLF，无需特殊配置）。
- 配置文件与注册文件写入必须：先时间戳备份 → 临时文件 + os.replace 原子替换 → 回读 JSON 校验，失败自动还原备份。
- 邮件约束：单附件 ≤ 25MB；socket 超时 30s；list limit 钳制 1–50 默认 10；正文单部分 > 512KB 截断并提示。
- TDD：每个生产模块先写失败测试再实现；每个 Task 以测试全绿 + 一次 commit 收尾。commit message 中文，结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 测试一律不得真实联网：SMTP/IMAP 用替身类注入；JS 测试用临时 HOME/临时目录，绝不碰真实 `~/.claude.json` 与 `~/.ccgui-next`。

---

## 文件结构

```
ccgui-plugin-email-assistant/
├── manifest.json               # 插件声明（ui:settings-section/storage/exec:python3/theme）
├── main.js                     # 默认导出 activate(ctx) + 纯逻辑命名导出（供测试）
├── styles.css                  # 宿主自动加载，类名前缀 ea-
├── README.md                   # 安装/授权码指引/安全提示/MCP 注册说明
├── LICENSE                     # MIT（从 ccgui-plugin-session-wait/LICENSE 复制）
├── test/
│   └── core.test.mjs           # node --test：纯逻辑 + python 片段契约（临时目录）
└── mcp/
    ├── README.md               # 面向非 CCgui 宿主的独立注册说明
    └── email_mcp/
        ├── __init__.py         # 空包标记
        ├── config.py           # 路径解析、profiles.json 读取与校验、QQ 预设
        ├── protocol.py         # JSON-RPC 帧读写、MCP 握手、消息分发
        ├── sender.py           # MIME 组装 + smtplib 发信
        ├── receiver.py         # imaplib 列表/取信 + 邮件解析
        ├── selftest.py         # 连通性测试脚本（插件按钮调用）
        ├── __main__.py         # stdio 主循环入口 + 工具表
        └── tests/
            ├── __init__.py
            ├── _helpers.py     # 假 stdin/stdout、假 SMTP/IMAP、临时环境
            ├── test_config.py
            ├── test_protocol.py
            ├── test_sender.py
            ├── test_receiver.py
            └── test_main.py
```

模块间接口契约（后续 Task 严格按此命名）：

- `config.data_dir() -> pathlib.Path`；`config.config_path() -> Path`；`config.load_active_profile() -> dict`；异常 `config.ConfigError`
- profile dict 形状：`{id, provider, email, authCode, displayName, smtp:{host,port,ssl}, imap:{host,port,ssl}, updatedAt}`
- `protocol.read_message(stream) -> dict|None`；`protocol.write_message(stream, obj)`；`protocol.handle_message(msg, tools) -> dict|None`（None=通知不回）；工具规格 `{name, description, inputSchema, handler(args:dict)->dict}`，handler 返回值作为 result；抛 `ToolError(msg)` 转 MCP isError
- `sender.build_message(profile, to, subject, body, cc=None, html=None, attachments=None) -> email.message.EmailMessage`；`sender.send_mail(profile, params:dict) -> dict`；异常 `sender.SendError`
- `receiver.list_recent(profile, limit=10, folder="INBOX") -> list[dict]`；`receiver.get_mail(profile, uid, folder="INBOX", mark_read=True) -> dict`；`receiver.parse_message(raw:bytes) -> dict`；异常 `receiver.ReceiveError`

---

## Task 1: Python 包脚手架 + config.py（配置读取与校验）

**Files:**
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/__init__.py`
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/config.py`
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/__init__.py`
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/_helpers.py`
- Test: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_config.py`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `config.QQ_PRESET`、`config.ConfigError`、`config.data_dir()`、`config.config_path()`、`config.load_active_profile()`、`config.validate_profile(raw)`；环境变量 `EMAIL_MCP_HOME`

- [ ] **Step 1: 建目录与空包文件**

```bash
mkdir -p ccgui-plugin-email-assistant/mcp/email_mcp/tests
touch ccgui-plugin-email-assistant/mcp/email_mcp/__init__.py
touch ccgui-plugin-email-assistant/mcp/email_mcp/tests/__init__.py
```

`_helpers.py` 内容（后续所有 Python 测试共用的环境工具）：

```python
import os
import sys
import tempfile
from pathlib import Path

# 让测试无论从哪个 cwd 启动都能 import email_mcp 包（包的父目录是 mcp/）
_MCP_ROOT = Path(__file__).resolve().parents[2]
if str(_MCP_ROOT) not in sys.path:
    sys.path.insert(0, str(_MCP_ROOT))


class TempHome:
    """临时 EMAIL_MCP_HOME 上下文：隔离所有配置文件读写。"""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def __enter__(self):
        self._old = os.environ.get("EMAIL_MCP_HOME")
        os.environ["EMAIL_MCP_HOME"] = str(self.root)
        return self

    def __exit__(self, *exc):
        if self._old is None:
            os.environ.pop("EMAIL_MCP_HOME", None)
        else:
            os.environ["EMAIL_MCP_HOME"] = self._old
        self.tmp.cleanup()

    def write_config(self, payload: dict) -> Path:
        import json
        d = self.root / "plugin-data" / "email-assistant"
        d.mkdir(parents=True, exist_ok=True)
        p = d / "profiles.json"
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return p
```

- [ ] **Step 2: 写失败测试 test_config.py**

```python
import json
import os
import unittest
from pathlib import Path

from email_mcp import config
from email_mcp.tests._helpers import TempHome


class TestConfig(unittest.TestCase):
    def _payload(self, **over):
        p = {
            "id": "qq-default",
            "provider": "qq",
            "email": "tester@qq.com",
            "authCode": "abcdefghijklmnop",
            "displayName": "测试员",
            "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
            "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
            "updatedAt": 1762838400000,
        }
        p.update(over)
        return p

    def test_paths_follow_override(self):
        with TempHome() as h:
            self.assertEqual(
                config.data_dir(),
                h.root / "plugin-data" / "email-assistant",
            )
            self.assertEqual(config.config_path().name, "profiles.json")

    def test_qq_preset_constants(self):
        self.assertEqual(config.QQ_PRESET["smtp"]["host"], "smtp.qq.com")
        self.assertEqual(config.QQ_PRESET["smtp"]["port"], 465)
        self.assertEqual(config.QQ_PRESET["imap"]["host"], "imap.qq.com")
        self.assertEqual(config.QQ_PRESET["imap"]["port"], 993)
        self.assertTrue(config.QQ_PRESET["smtp"]["ssl"])

    def test_load_active_profile_ok(self):
        with TempHome() as h:
            h.write_config({"version": 1, "activeId": "qq-default",
                            "profiles": [self._payload()]})
            prof = config.load_active_profile()
            self.assertEqual(prof["email"], "tester@qq.com")
            self.assertEqual(prof["authCode"], "abcdefghijklmnop")

    def test_missing_file_raises_chinese(self):
        with TempHome():
            with self.assertRaises(config.ConfigError) as cx:
                config.load_active_profile()
            self.assertIn("插件设置页", str(cx.exception))

    def test_broken_json_raises(self):
        with TempHome() as h:
            p = h.write_config({"version": 1})
            p.write_text("{不是 json", encoding="utf-8")
            with self.assertRaises(config.ConfigError):
                config.load_active_profile()

    def test_active_id_not_found(self):
        with TempHome() as h:
            h.write_config({"version": 1, "activeId": "nope",
                            "profiles": [self._payload()]})
            with self.assertRaises(config.ConfigError):
                config.load_active_profile()

    def test_validate_rejects_bad_email(self):
        with self.assertRaises(config.ConfigError):
            config.validate_profile(self._payload(email="no-at-sign"))

    def test_validate_rejects_empty_auth_code(self):
        with self.assertRaises(config.ConfigError):
            config.validate_profile(self._payload(authCode="  "))

    def test_validate_rejects_bad_ports(self):
        with self.assertRaises(config.ConfigError):
            config.validate_profile(self._payload(
                smtp={"host": "smtp.qq.com", "port": 0, "ssl": True}))

    def test_validate_fills_display_name_default(self):
        out = config.validate_profile(self._payload(displayName=""))
        self.assertEqual(out["displayName"], "tester")

    def test_env_not_set_uses_home(self):
        old = os.environ.pop("EMAIL_MCP_HOME", None)
        try:
            self.assertEqual(
                config.data_dir(),
                Path.home() / ".ccgui-next" / "plugin-data" / "email-assistant",
            )
        finally:
            if old is not None:
                os.environ["EMAIL_MCP_HOME"] = old


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_config -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'email_mcp.config'`

- [ ] **Step 4: 实现 config.py**

```python
"""配置读取：唯一接触 profiles.json 的模块。"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

PLUGIN_DATA_REL = ("plugin-data", "email-assistant")
CONFIG_FILENAME = "profiles.json"
DEFAULT_PROFILE_ID = "qq-default"

QQ_PRESET = {
    "provider": "qq",
    "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
    "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
}

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@(qq|foxmail)\.com$", re.IGNORECASE)


class ConfigError(Exception):
    """配置缺失或不合法；message 为可直接展示给用户的中文。"""


def data_dir() -> Path:
    root = os.environ.get("EMAIL_MCP_HOME")
    if root and root.strip():
        return Path(root.strip(), *PLUGIN_DATA_REL)
    return Path.home() / ".ccgui-next" / *PLUGIN_DATA_REL


def config_path() -> Path:
    return data_dir() / CONFIG_FILENAME


def validate_profile(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ConfigError("账号配置格式错误：条目不是对象")
    email = str(raw.get("email", "")).strip()
    if not _EMAIL_RE.match(email):
        raise ConfigError("邮箱地址格式不正确：%s" % email)
    auth_code = str(raw.get("authCode", "")).strip()
    if not auth_code:
        raise ConfigError("授权码为空，请在插件设置页填写 QQ 邮箱授权码")

    def _server(key, default_host):
        s = raw.get(key) or {}
        host = str(s.get("host", "")).strip() or default_host
        try:
            port = int(s.get("port"))
        except (TypeError, ValueError):
            raise ConfigError("%s 端口必须是数字" % key)
        if not (1 <= port <= 65535):
            raise ConfigError("%s 端口超出范围：%s" % (key, port))
        return {"host": host, "port": port, "ssl": bool(s.get("ssl", True))}

    smtp = _server("smtp", QQ_PRESET["smtp"]["host"])
    imap = _server("imap", QQ_PRESET["imap"]["host"])
    display = str(raw.get("displayName", "")).strip() or email.split("@", 1)[0]
    try:
        updated = int(raw.get("updatedAt", 0))
    except (TypeError, ValueError):
        updated = 0
    return {
        "id": str(raw.get("id", DEFAULT_PROFILE_ID)).strip() or DEFAULT_PROFILE_ID,
        "provider": str(raw.get("provider", "qq")).strip() or "qq",
        "email": email,
        "authCode": auth_code,
        "displayName": display,
        "smtp": smtp,
        "imap": imap,
        "updatedAt": updated,
    }


def load_raw() -> dict:
    p = config_path()
    if not p.exists():
        raise ConfigError("尚未配置邮箱账号，请先在 CCgui「邮箱助手」插件设置页填写并保存")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError("配置文件损坏（%s）：%s" % (p, e)) from e
    if not isinstance(data, dict) or not isinstance(data.get("profiles"), list):
        raise ConfigError("配置文件结构错误：缺少 profiles 数组")
    return data


def load_active_profile() -> dict:
    data = load_raw()
    active_id = str(data.get("activeId", DEFAULT_PROFILE_ID))
    for raw in data["profiles"]:
        if isinstance(raw, dict) and str(raw.get("id", "")) == active_id:
            return validate_profile(raw)
    if data["profiles"]:  # activeId 失效时回退第一个，仍校验
        return validate_profile(data["profiles"][0])
    raise ConfigError("配置中没有任何账号，请回到插件设置页重新保存")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_config -v`
Expected: 11 个测试全 PASS

- [ ] **Step 6: 提交**

```bash
git add ccgui-plugin-email-assistant/mcp
git commit -m "feat(email-mcp): 脚手架与配置读取模块 config.py

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: protocol.py（JSON-RPC 帧与 MCP 握手分发）

**Files:**
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/protocol.py`
- Test: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_protocol.py`

**Interfaces:**
- Consumes: 无网络/配置依赖
- Produces: `protocol.ToolError`、`protocol.read_message(stream)`、`protocol.write_message(stream, obj)`、`protocol.handle_message(msg, tools)`；tools 为 `{name: {"description":str, "inputSchema":dict, "handler": callable}}`

- [ ] **Step 1: 写失败测试 test_protocol.py**

```python
import io
import json
import unittest

from email_mcp import protocol


class FakeStdin:
    def __init__(self, lines):
        self._buf = io.StringIO("\n".join(lines) + ("\n" if lines else ""))

    def readline(self):
        return self._buf.readline()


class TestFraming(unittest.TestCase):
    def test_roundtrip(self):
        out = io.StringIO()
        protocol.write_message(out, {"jsonrpc": "2.0", "id": 1, "result": {}})
        line = out.getvalue().strip("\n")
        back = protocol.read_message(io.StringIO(line + "\n"))
        self.assertEqual(back["id"], 1)

    def test_read_eof_returns_none(self):
        self.assertIsNone(protocol.read_message(io.StringIO("")))

    def test_blank_line_skipped_then_message(self):
        msg = protocol.read_message(io.StringIO("\n\n" + json.dumps({"id": 2}) + "\n"))
        self.assertEqual(msg["id"], 2)

    def test_broken_json_raises_protocol_error(self):
        with self.assertRaises(protocol.ProtocolError) as cx:
            protocol.read_message(io.StringIO("{oops\n"))
        self.assertEqual(cx.exception.code, -32700)


class TestDispatch(unittest.TestCase):
    def _tools(self):
        def echo(args):
            return {"you Said": args.get("text", "")}

        def boom(args):
            raise protocol.ToolError("中文业务错误")

        return {
            "echo": {"description": "回显", "inputSchema": {"type": "object"},
                     "handler": echo},
            "boom": {"description": "报错", "inputSchema": {"type": "object"},
                     "handler": boom},
        }

    def test_initialize(self):
        msg = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2024-11-05"}}
        resp = protocol.handle_message(msg, self._tools())
        self.assertEqual(resp["id"], 1)
        self.assertEqual(resp["result"]["protocolVersion"], "2024-11-05")
        self.assertIn("tools", resp["result"]["capabilities"])
        self.assertEqual(resp["result"]["serverInfo"]["name"], "email-assistant-mcp")

    def test_initialized_notification_no_response(self):
        msg = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        self.assertIsNone(protocol.handle_message(msg, self._tools()))

    def test_ping(self):
        resp = protocol.handle_message({"id": 2, "method": "ping"}, self._tools())
        self.assertEqual(resp["result"], {})

    def test_tools_list_shape(self):
        resp = protocol.handle_message({"id": 3, "method": "tools/list"}, self._tools())
        tools = resp["result"]["tools"]
        self.assertEqual([t["name"] for t in tools], ["boom", "echo"])  # 名字排序稳定
        self.assertIn("inputSchema", tools[0])

    def test_tools_call_ok(self):
        resp = protocol.handle_message(
            {"id": 4, "method": "tools/call",
             "params": {"name": "echo", "arguments": {"text": "你好"}}},
            self._tools())
        self.assertFalse(resp["result"]["isError"])
        text = resp["result"]["content"][0]["text"]
        self.assertIn("你好", text)

    def test_tools_call_tool_error_is_content_not_rpc_error(self):
        resp = protocol.handle_message(
            {"id": 5, "method": "tools/call",
             "params": {"name": "boom", "arguments": {}}},
            self._tools())
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("中文业务错误", resp["result"]["content"][0]["text"])
        self.assertNotIn("error", resp)

    def test_unknown_tool(self):
        resp = protocol.handle_message(
            {"id": 6, "method": "tools/call", "params": {"name": "nope"}},
            self._tools())
        self.assertEqual(resp["error"]["code"], -32602)

    def test_unknown_method(self):
        resp = protocol.handle_message({"id": 7, "method": "shutdown"}, self._tools())
        self.assertEqual(resp["error"]["code"], -32601)

    def test_bad_params_shape(self):
        resp = protocol.handle_message(
            {"id": 8, "method": "tools/call", "params": "oops"}, self._tools())
        self.assertEqual(resp["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_protocol -v`
Expected: FAIL，`ModuleNotFoundError: email_mcp.protocol`

- [ ] **Step 3: 实现 protocol.py**

```python
"""JSON-RPC 2.0 over stdio 分帧与 MCP 协议分发。本模块不懂邮件。"""
from __future__ import annotations

import json

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "email-assistant-mcp"
SERVER_VERSION = "0.1.0"


class ProtocolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class ToolError(Exception):
    """工具业务错误：转成 MCP isError 文本结果，而非 JSON-RPC error。"""


def read_message(stream):
    """读一帧（单行 JSON）；EOF 返回 None；空行跳过。"""
    while True:
        line = stream.readline()
        if line == "":
            return None
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            raise ProtocolError(-32700, "解析错误: %s" % e) from e
        if not isinstance(msg, dict):
            raise ProtocolError(-32700, "帧不是 JSON 对象")
        return msg


def write_message(stream, obj):
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


def _rpc_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": code, "message": message}}


def _tool_result(msg_id, text, is_error=False):
    return {"jsonrpc": "2.0", "id": msg_id,
            "result": {"content": [{"type": "text", "text": text}],
                       "isError": is_error}}


def _initialize(msg_id):
    return {"jsonrpc": "2.0", "id": msg_id, "result": {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
    }}


def _tools_list(msg_id, tools):
    listing = []
    for name in sorted(tools):
        spec = tools[name]
        listing.append({"name": name, "description": spec["description"],
                        "inputSchema": spec["inputSchema"]})
    return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": listing}}


def _tools_call(msg, tools):
    msg_id = msg.get("id")
    params = msg.get("params")
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        return _rpc_error(msg_id, -32602, "params 必须含字符串 name")
    spec = tools.get(params["name"])
    if spec is None:
        return _rpc_error(msg_id, -32602, "未知工具: %s" % params["name"])
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        return _rpc_error(msg_id, -32602, "arguments 必须是对象")
    try:
        result = spec["handler"](args)
    except ToolError as e:
        return _tool_result(msg_id, str(e), is_error=True)
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
    return _tool_result(msg_id, text)


def handle_message(msg, tools):
    """处理一帧；通知返回 None，其余返回可直接写出的响应 dict。"""
    method = msg.get("method")
    msg_id = msg.get("id")
    if method == "initialize":
        return _initialize(msg_id)
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return _tools_list(msg_id, tools)
    if method == "tools/call":
        return _tools_call(msg, tools)
    return _rpc_error(msg_id, -32601, "未知方法: %s" % method)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_protocol -v`
Expected: 13 个测试全 PASS

- [ ] **Step 5: 提交**

```bash
git add ccgui-plugin-email-assistant/mcp/email_mcp/protocol.py ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_protocol.py
git commit -m "feat(email-mcp): JSON-RPC/MCP 协议帧与分发模块 protocol.py

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: sender.py（MIME 组装与 SMTP 发信）

**Files:**
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/sender.py`
- Test: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_sender.py`

**Interfaces:**
- Consumes: profile dict（Task 1 的 validate_profile 输出）
- Produces: `sender.SendError`、`sender.build_message(...)`、`sender.send_mail(profile, params)`、`sender.smtp_connect(profile)`（供 selftest 复用）

- [ ] **Step 1: 写失败测试 test_sender.py**

```python
import unittest
from email.header import decode_header, make_header
from email.message import EmailMessage

from email_mcp import sender
from email_mcp.tests._helpers import TempHome


PROFILE = {
    "id": "qq-default", "provider": "qq", "email": "tester@qq.com",
    "authCode": "x", "displayName": "测试员",
    "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
    "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
    "updatedAt": 0,
}


def _decode(s):
    return str(make_header(decode_header(s)))


class FakeSMTP:
    """记录调用，不联网。"""
    instances = []

    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.sent = None
        self.logged_in = None
        self.quit_called = False
        FakeSMTP.instances.append(self)

    def login(self, user, password):
        self.logged_in = (user, password)

    def send_message(self, msg, from_addr=None, to_addrs=None):
        self.sent = (msg, from_addr, list(to_addrs))
        return {}

    def noop(self):
        return (250, b"OK")

    def quit(self):
        self.quit_called = True


class TestBuildMessage(unittest.TestCase):
    def test_basic_headers_and_text(self):
        msg = sender.build_message(PROFILE, ["a@qq.com"], "中文主题", "正文你好")
        self.assertEqual(_decode(msg["Subject"]), "中文主题")
        self.assertEqual(_decode(msg["From"]), "测试员 <tester@qq.com>")
        self.assertEqual(msg["To"], "a@qq.com")
        self.assertIn("正文你好", msg.get_body(preferencelist=("plain",)).get_content())

    def test_cc_and_multiple_recipients(self):
        msg = sender.build_message(PROFILE, ["a@qq.com", "b@qq.com"], "s", "b",
                                   cc=["c@qq.com"])
        self.assertEqual(msg["Cc"], "c@qq.com")
        self.assertEqual(len(msg.get("To").split(",")), 2)

    def test_html_makes_alternative(self):
        msg = sender.build_message(PROFILE, ["a@qq.com"], "s", "纯文本",
                                   html="<b>粗体</b>")
        alt = msg.get_body(preferencelist=("html",))
        self.assertIn("粗体", alt.get_content())
        self.assertEqual(msg.get_content_type(), "multipart/alternative")

    def test_attachment(self):
        with TempHome() as h:
            f = h.root / "报告.txt"
            f.write_text("附件内容", encoding="utf-8")
            msg = sender.build_message(PROFILE, ["a@qq.com"], "s", "b",
                                       attachments=[str(f)])
            names = [_decode(part.get_filename()) for part in msg.iter_attachments()]
            self.assertEqual(names, ["报告.txt"])

    def test_attachment_missing_raises(self):
        with TempHome() as h:
            with self.assertRaises(sender.SendError) as cx:
                sender.build_message(PROFILE, ["a@qq.com"], "s", "b",
                                     attachments=[str(h.root / "no.txt")])
            self.assertIn("不存在", str(cx.exception))

    def test_attachment_size_limit(self):
        with TempHome() as h:
            f = h.root / "big.bin"
            f.write_bytes(b"0" * (25 * 1024 * 1024 + 1))
            with self.assertRaises(sender.SendError) as cx:
                sender.build_message(PROFILE, ["a@qq.com"], "s", "b",
                                     attachments=[str(f)])
            self.assertIn("25MB", str(cx.exception))

    def test_bad_recipient_rejected(self):
        with self.assertRaises(sender.SendError):
            sender.build_message(PROFILE, ["no-at"], "s", "b")


class TestSendMail(unittest.TestCase):
    def setUp(self):
        FakeSMTP.instances.clear()
        self._old = sender.SMTP_SSL
        sender.SMTP_SSL = FakeSMTP

    def tearDown(self):
        sender.SMTP_SSL = self._old

    def test_send_happy_path(self):
        out = sender.send_mail(PROFILE, {
            "to": ["a@qq.com"], "subject": "主题", "body": "正文"})
        smtp = FakeSMTP.instances[0]
        self.assertEqual(smtp.host, "smtp.qq.com")
        self.assertEqual(smtp.port, 465)
        self.assertEqual(smtp.timeout, 30)
        self.assertEqual(smtp.logged_in, ("tester@qq.com", "x"))
        self.assertTrue(smtp.quit_called)
        self.assertIn("messageId", out)
        self.assertEqual(out["accepted"], ["a@qq.com"])

    def test_send_auth_failure_chinese(self):
        class Bad(FakeSMTP):
            def login(self, user, password):
                raise sender.smtplib.SMTPAuthenticationError(535, b"auth fail")
        sender.SMTP_SSL = Bad
        with self.assertRaises(sender.SendError) as cx:
            sender.send_mail(PROFILE, {"to": ["a@qq.com"], "subject": "s", "body": "b"})
        self.assertIn("认证失败", str(cx.exception))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_sender -v`
Expected: FAIL，`ModuleNotFoundError: email_mcp.sender`

- [ ] **Step 3: 实现 sender.py**

```python
"""SMTP 发信与 MIME 组装。只依赖标准库。"""
from __future__ import annotations

import mimetypes
import os
import smtplib
import socket
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
SOCKET_TIMEOUT = 30

# 测试可替换此符号（生产环境即 smtplib.SMTP_SSL）
SMTP_SSL = smtplib.SMTP_SSL


class SendError(Exception):
    """发信失败；message 为中文用户文案。"""


def _check_addresses(addrs, field):
    if not isinstance(addrs, list) or not addrs:
        raise SendError("%s 必须是非空数组" % field)
    out = []
    for a in addrs:
        a = str(a or "").strip()
        if "@" not in a or a.startswith("@") or a.endswith("@"):
            raise SendError("收件地址格式不正确：%s" % a)
        out.append(a)
    return out


def build_message(profile, to, subject, body, cc=None, html=None, attachments=None):
    to = _check_addresses(to, "to")
    cc = _check_addresses(cc, "cc") if cc else None
    if not str(subject or "").strip():
        raise SendError("主题不能为空")
    if not str(body or "").strip():
        raise SendError("正文不能为空")

    msg = EmailMessage()
    msg["From"] = formataddr((profile["displayName"], profile["email"]))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = str(subject)
    msg["Message-ID"] = make_msgid(domain=profile["email"].split("@", 1)[1])
    msg.set_content(str(body))
    if html and str(html).strip():
        msg.add_alternative(str(html), subtype="html")

    for path in attachments or []:
        p = str(path or "")
        if not os.path.isfile(p):
            raise SendError("附件不存在或不是文件：%s" % p)
        size = os.path.getsize(p)
        if size > MAX_ATTACHMENT_BYTES:
            raise SendError("附件 %s 超过 25MB 上限（当前 %.1fMB）"
                            % (os.path.basename(p), size / 1024 / 1024))
        ctype, _ = mimetypes.guess_type(p)
        maintype, subtype = (ctype.split("/", 1) if ctype else ("application", "octet-stream"))
        with open(p, "rb") as f:
            msg.add_attachment(f.read(), maintype=maintype, subtype=subtype,
                               filename=os.path.basename(p))
    return msg


def smtp_connect(profile):
    s = profile["smtp"]
    socket.setdefaulttimeout(SOCKET_TIMEOUT)
    try:
        client = SMTP_SSL(s["host"], s["port"], timeout=SOCKET_TIMEOUT)
    except (OSError, smtplib.SMTPException) as e:
        raise SendError("无法连接 %s:%s，请检查网络：%s" % (s["host"], s["port"], e)) from e
    try:
        client.login(profile["email"], profile["authCode"])
    except smtplib.SMTPAuthenticationError as e:
        raise SendError("邮箱认证失败：授权码错误或 SMTP 服务未开启（%s）" % e) from e
    return client


def send_mail(profile, params):
    msg = build_message(
        profile,
        params.get("to"), params.get("subject", ""), params.get("body", ""),
        cc=params.get("cc"), html=params.get("html"),
        attachments=params.get("attachments"),
    )
    recipients = msg["To"].split(", ")
    if msg["Cc"]:
        recipients += msg["Cc"].split(", ")
    client = smtp_connect(profile)
    try:
        refused = client.send_message(msg, from_addr=profile["email"], to_addrs=recipients)
    except smtplib.SMTPAuthenticationError as e:
        raise SendError("邮箱认证失败：授权码错误或 SMTP 服务未开启（%s）" % e) from e
    except (smtplib.SMTPException, OSError) as e:
        raise SendError("邮件发送失败：%s" % e) from e
    finally:
        try:
            client.quit()
        except Exception:
            pass
    rejected = sorted(refused.keys()) if isinstance(refused, dict) else []
    accepted = [a for a in recipients if a not in rejected]
    return {"messageId": msg["Message-ID"], "accepted": accepted, "rejected": rejected}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_sender -v`
Expected: 9 个测试全 PASS。再跑全量确认无回归：`python -m unittest discover -s email_mcp/tests -v`

- [ ] **Step 5: 提交**

```bash
git add ccgui-plugin-email-assistant/mcp/email_mcp/sender.py ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_sender.py
git commit -m "feat(email-mcp): SMTP 发信与 MIME 组装模块 sender.py

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## Task 4: receiver.py（IMAP 列表、取信与邮件解析）

**Files:**
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/receiver.py`
- Test: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_receiver.py`

**Interfaces:**
- Consumes: profile dict（Task 1）
- Produces: `receiver.ReceiveError`、`receiver.IMAP4_SSL`（可替换的连接符号）、`receiver.imap_connect(profile)`、`receiver.list_recent(profile, limit=10, folder="INBOX")`、`receiver.get_mail(profile, uid, folder="INBOX", mark_read=True)`、`receiver.parse_message(raw: bytes)`

- [ ] **Step 1: 写失败测试 test_receiver.py**

```python
import unittest
from email.message import EmailMessage
from email.header import decode_header, make_header
from email.utils import formataddr

from email_mcp import receiver

PROFILE = {
    "id": "qq-default", "provider": "qq", "email": "tester@qq.com",
    "authCode": "x", "displayName": "测试员",
    "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
    "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
    "updatedAt": 0,
}


def _dec(s):
    return str(make_header(decode_header(s)))


def make_raw(subject="中文主题", from_name="老王", from_addr="lao@qq.com",
             text="纯文本正文", html=None, attachments=None, charset="utf-8"):
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, from_addr))
    msg["To"] = "tester@qq.com"
    msg["Subject"] = subject
    msg["Date"] = "Wed, 11 Nov 2026 10:00:00 +0800"
    msg.set_content(text, charset=charset)
    if html:
        msg.add_alternative(html, subtype="html", charset=charset)
    for name, blob in (attachments or []):
        msg.add_attachment(blob, maintype="application",
                           subtype="octet-stream", filename=name)
    return msg.as_bytes()


class FakeIMAP:
    """模拟 imaplib.IMAP4_SSL 的最小表面。"""
    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.messages = {}          # uid(bytes) -> raw bytes
        self.seen_flags = set()     # 带 \\Seen 的 uid
        self.selected = None
        self.readonly = None
        self.logged_in = None
        self.closed = False

    def login(self, user, pw):
        self.logged_in = (user, pw)

    def select(self, folder, readonly=False):
        self.selected, self.readonly = folder, readonly
        return "OK", [str(len(self.messages)).encode()]

    def uid(self, command, *args):
        if command == "SEARCH":
            uids = b" ".join(sorted(self.messages.keys()))
            return "OK", [uids]
        if command == "FETCH":
            uid = args[0]
            raw = self.messages[uid]
            flags = b"\\Seen" if uid in self.seen_flags else b""
            if "PEEK" in args[1] or args[1] == "RFC822":
                prefix = b"1 (UID %s FLAGS (%s) BODY[] {%d}" % (
                    uid, flags, len(raw))
                return "OK", [(prefix, raw), b")"]
            prefix = b"1 (UID %s RFC822.SIZE %d FLAGS (%s) BODY[HEADER.FIELDS] {%d}" % (
                uid, len(raw), flags, len(raw))
            return "OK", [(prefix, raw), b")"]
        raise AssertionError("unexpected uid command: %s" % command)

    def logout(self):
        self.closed = True
        return "BYE", []


class TestParseMessage(unittest.TestCase):
    def test_basic_chinese(self):
        p = receiver.parse_message(make_raw())
        self.assertEqual(_dec(p["subject"]), "中文主题")
        self.assertEqual(p["from"], "lao@qq.com")
        self.assertEqual(p["fromName"], "老王")
        self.assertIn("纯文本正文", p["text"])
        self.assertFalse(p["textTruncated"])
        self.assertEqual(p["attachments"], [])

    def test_html_and_alternative(self):
        p = receiver.parse_message(make_raw(html="<b>粗体</b>"))
        self.assertIn("粗体", p["html"])
        self.assertIn("纯文本正文", p["text"])

    def test_attachment_listed(self):
        p = receiver.parse_message(
            make_raw(attachments=[("报告.txt", b"hello"), ("a.bin", b"0" * 10)]))
        names = [a["filename"] for a in p["attachments"]]
        self.assertEqual(names, ["报告.txt", "a.bin"])
        self.assertEqual(p["attachments"][1]["size"], 10)
        self.assertEqual(p["attachments"][0]["mimeType"], "application/octet-stream")

    def test_gb18030_body_fallback(self):
        raw = make_raw(text="国标正文", charset="gb18030")
        p = receiver.parse_message(raw)
        self.assertIn("国标正文", p["text"])

    def test_truncation(self):
        big = "x" * (receiver.MAX_TEXT_CHARS + 10)
        p = receiver.parse_message(make_raw(text=big))
        self.assertTrue(p["textTruncated"])
        self.assertEqual(len(p["text"]), receiver.MAX_TEXT_CHARS)


class TestListRecent(unittest.TestCase):
    def setUp(self):
        self._old = receiver.IMAP4_SSL
        receiver.IMAP4_SSL = FakeIMAP

    def tearDown(self):
        receiver.IMAP4_SSL = self._old

    def test_list_order_limit_and_unread(self):
        holder = {}

        class Prep(FakeIMAP):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                for i in range(3):
                    uid = str(101 + i).encode()
                    self.messages[uid] = make_raw(subject="主题%d" % i)
                self.seen_flags.add(b"101")
                holder["c"] = self

        receiver.IMAP4_SSL = Prep
        rows = receiver.list_recent(PROFILE, limit=2)
        self.assertEqual([r["uid"] for r in rows], ["103", "102"])  # 最新在前
        self.assertEqual(rows[0]["subject"], "主题2")
        self.assertTrue(rows[0]["unread"])
        self.assertFalse(rows[1]["unread"])  # 102 未标记 Seen
        self.assertTrue(holder["c"].readonly)       # readonly 选择
        self.assertTrue(holder["c"].closed)         # finally logout

    def test_limit_clamped(self):
        holder = {}

        class Prep(FakeIMAP):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                self.messages[b"1"] = make_raw()
                holder["c"] = self

        receiver.IMAP4_SSL = Prep
        self.assertEqual(len(receiver.list_recent(PROFILE, limit=999)), 1)
        self.assertEqual(len(receiver.list_recent(PROFILE, limit=0)), 1)


class TestGetMail(unittest.TestCase):
    def setUp(self):
        self._old = receiver.IMAP4_SSL

    def tearDown(self):
        receiver.IMAP4_SSL = self._old

    def test_get_by_uid_peek_when_not_mark_read(self):
        holder = {}

        class Prep(FakeIMAP):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                self.messages[b"555"] = make_raw(subject="找我")
                holder["c"] = self

        receiver.IMAP4_SSL = Prep
        out = receiver.get_mail(PROFILE, "555", mark_read=False)
        self.assertEqual(out["uid"], "555")
        self.assertEqual(out["subject"], "找我")
        self.assertTrue(holder["c"].readonly)

    def test_get_mark_read_uses_writable_select(self):
        holder = {}

        class Prep(FakeIMAP):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                self.messages[b"9"] = make_raw()
                holder["c"] = self

        receiver.IMAP4_SSL = Prep
        receiver.get_mail(PROFILE, "9", mark_read=True)
        self.assertFalse(holder["c"].readonly)

    def test_missing_uid_raises_chinese(self):
        class Empty(FakeIMAP):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)

            def uid(self, command, *args):
                if command == "FETCH":
                    return "OK", [None]
                return super().uid(command, *args)

        receiver.IMAP4_SSL = Empty
        with self.assertRaises(receiver.ReceiveError) as cx:
            receiver.get_mail(PROFILE, "404")
        self.assertIn("未找到", str(cx.exception))

    def test_auth_failure_chinese(self):
        class Bad(FakeIMAP):
            def login(self, user, pw):
                raise receiver.imaplib.IMAP4.error("LOGIN failed")

        receiver.IMAP4_SSL = Bad
        with self.assertRaises(receiver.ReceiveError) as cx:
            receiver.list_recent(PROFILE)
        self.assertIn("认证失败", str(cx.exception))


if __name__ == "__main__":
    unittest.main()
```

注意：`test_list_order_limit_and_unread` 里开头的占位循环无实际用途，实现时只保留 `Prep` 版本（即删掉 `Capture` 与 for 循环两段死代码，保留 holder/Prep）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_receiver -v`
Expected: FAIL，`ModuleNotFoundError: email_mcp.receiver`

- [ ] **Step 3: 实现 receiver.py**

```python
"""IMAP 收信与邮件解析。只依赖标准库。"""
from __future__ import annotations

import imaplib
import re
import socket
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parseaddr
import email

SOCKET_TIMEOUT = 30
MAX_TEXT_CHARS = 512 * 1024
DEFAULT_LIMIT = 10
MAX_LIMIT = 50

# 测试可替换此符号（生产环境即 imaplib.IMAP4_SSL）
IMAP4_SSL = imaplib.IMAP4_SSL


class ReceiveError(Exception):
    """收信失败；message 为中文用户文案。"""


def _dec_header(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return str(value)


def _decode_bytes(raw: bytes, charset: str | None) -> str:
    for enc in (charset, "utf-8", "gb18030"):
        if not enc:
            continue
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _extract_fetch(data):
    """从 imaplib FETCH 数据里抽出 (描述字节, 内容字节)。"""
    for item in data or []:
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[1], (bytes, bytearray)):
            return item[0], bytes(item[1])
    return None, None


def parse_message(raw: bytes) -> dict:
    msg = email.message_from_bytes(raw)
    name, addr = parseaddr(msg.get("From", ""))
    text, html = "", ""
    attachments = []
    for part in msg.walk():
        disposition = part.get_content_disposition()
        ctype = part.get_content_type()
        if disposition == "attachment" or (part.get_filename() and ctype != "text/plain"):
            payload = part.get_payload(decode=True) or b""
            attachments.append({
                "filename": _dec_header(part.get_filename() or "unnamed"),
                "mimeType": ctype,
                "size": len(payload),
            })
            continue
        if ctype == "text/plain" and not text:
            text = _decode_bytes(part.get_payload(decode=True) or b"",
                                 part.get_content_charset())
        elif ctype == "text/html" and not html:
            html = _decode_bytes(part.get_payload(decode=True) or b"",
                                 part.get_content_charset())
    text_truncated = len(text) > MAX_TEXT_CHARS
    if text_truncated:
        text = text[:MAX_TEXT_CHARS]
    return {
        "from": addr,
        "fromName": _dec_header(name),
        "to": msg.get("To", ""),
        "subject": _dec_header(msg.get("Subject", "")),
        "date": msg.get("Date", ""),
        "text": text,
        "html": html,
        "textTruncated": text_truncated,
        "attachments": attachments,
    }


def imap_connect(profile):
    s = profile["imap"]
    socket.setdefaulttimeout(SOCKET_TIMEOUT)
    try:
        client = IMAP4_SSL(s["host"], s["port"], timeout=SOCKET_TIMEOUT)
    except (OSError, imaplib.IMAP4.error) as e:
        raise ReceiveError("无法连接 %s:%s，请检查网络：%s" % (s["host"], s["port"], e)) from e
    try:
        client.login(profile["email"], profile["authCode"])
    except imaplib.IMAP4.error as e:
        raise ReceiveError("邮箱认证失败：授权码错误或 IMAP 服务未开启（%s）" % e) from e
    return client


def list_recent(profile, limit=DEFAULT_LIMIT, folder="INBOX"):
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    client = imap_connect(profile)
    try:
        client.select(folder, readonly=True)
        typ, data = client.uid("SEARCH", None, "ALL")
        if typ != "OK":
            raise ReceiveError("搜索邮件失败：%s" % typ)
        uids = (data[0].split() if data and data[0] else [])[-limit:][::-1]
        rows = []
        query = "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] RFC822.SIZE FLAGS)"
        for uid in uids:
            typ, fd = client.uid("FETCH", uid, query)
            meta, header_bytes = _extract_fetch(fd)
            if not meta:
                continue
            hm = email.message_from_bytes(header_bytes)
            name, addr = parseaddr(hm.get("From", ""))
            flags_m = re.search(rb"FLAGS \(([^)]*)\)", meta)
            size_m = re.search(rb"RFC822\.SIZE (\d+)", meta)
            unread = not (flags_m and b"\\Seen" in flags_m.group(1))
            rows.append({
                "uid": uid.decode(),
                "from": addr,
                "fromName": _dec_header(name),
                "subject": _dec_header(hm.get("Subject", "")),
                "date": hm.get("Date", ""),
                "size": int(size_m.group(1)) if size_m else 0,
                "unread": unread,
            })
        return rows
    except imaplib.IMAP4.error as e:
        raise ReceiveError("邮件列表获取失败：%s" % e) from e
    finally:
        try:
            client.logout()
        except Exception:
            pass


def get_mail(profile, uid, folder="INBOX", mark_read=True):
    uid = str(uid or "").strip()
    if not uid:
        raise ReceiveError("uid 不能为空")
    client = imap_connect(profile)
    try:
        client.select(folder, readonly=not mark_read)
        query = "RFC822" if mark_read else "BODY.PEEK[]"
        typ, data = client.uid("FETCH", uid.encode(), query)
        _, raw = _extract_fetch(data)
        if not raw:
            raise ReceiveError("未找到 uid=%s 的邮件" % uid)
        out = parse_message(raw)
        out["uid"] = uid
        return out
    except imaplib.IMAP4.error as e:
        raise ReceiveError("邮件获取失败：%s" % e) from e
    finally:
        try:
            client.logout()
        except Exception:
            pass
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_receiver -v`
Expected: 11 个测试全 PASS；再 `python -m unittest discover -s email_mcp/tests` 全量无回归

- [ ] **Step 5: 提交**

```bash
git add ccgui-plugin-email-assistant/mcp/email_mcp/receiver.py ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_receiver.py
git commit -m "feat(email-mcp): IMAP 收信与邮件解析模块 receiver.py

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: __main__.py（工具注册与 stdio 主循环）+ selftest.py

**Files:**
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/__main__.py`
- Create: `ccgui-plugin-email-assistant/mcp/email_mcp/selftest.py`
- Test: `ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_main.py`

**Interfaces:**
- Consumes: `config.load_active_profile` / `ConfigError`（T1）、`protocol.*`（T2）、`sender.send_mail` / `SendError`（T3）、`receiver.list_recent` / `get_mail` / `ReceiveError`（T4）
- Produces: `email_mcp.__main__.build_tools()`、`email_mcp.__main__.main(stdin, stdout)`；命令行 `python3 <包目录>` 启动 MCP；`python3 selftest.py` 输出 base64 JSON

- [ ] **Step 1: 写失败测试 test_main.py**

```python
import io
import json
import unittest

from email_mcp import config, protocol
from email_mcp import __main__ as entry
from email_mcp.tests._helpers import TempHome


class TestToolWrappers(unittest.TestCase):
    def test_no_config_raises_tool_error(self):
        with TempHome():
            tools = entry.build_tools()
            with self.assertRaises(protocol.ToolError) as cx:
                tools["send_mail"]["handler"](
                    {"to": ["a@qq.com"], "subject": "s", "body": "b"})
            self.assertIn("插件设置页", str(cx.exception))

    def test_send_wrapper_happy_path(self):
        with TempHome() as h:
            h.write_config({"version": 1, "activeId": "qq-default", "profiles": [{
                "id": "qq-default", "provider": "qq", "email": "t@qq.com",
                "authCode": "code", "displayName": "T",
                "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
                "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
                "updatedAt": 0}]})
            called = {}

            def fake_send(profile, params):
                called["profile"] = profile
                called["params"] = params
                return {"messageId": "<m@qq.com>", "accepted": params["to"], "rejected": []}

            old = entry.sender.send_mail
            entry.sender.send_mail = fake_send
            try:
                out = entry.build_tools()["send_mail"]["handler"](
                    {"to": ["a@qq.com"], "subject": "主题", "body": "正文"})
            finally:
                entry.sender.send_mail = old
            self.assertEqual(out["messageId"], "<m@qq.com>")
            self.assertEqual(called["profile"]["email"], "t@qq.com")
            # 授权码绝不进入工具入参
            self.assertNotIn("authCode", called["params"])

    def test_list_wrapper_passes_limit(self):
        with TempHome() as h:
            h.write_config({"version": 1, "activeId": "qq-default", "profiles": [{
                "id": "qq-default", "provider": "qq", "email": "t@qq.com",
                "authCode": "code", "displayName": "T",
                "smtp": {"host": "smtp.qq.com", "port": 465, "ssl": True},
                "imap": {"host": "imap.qq.com", "port": 993, "ssl": True},
                "updatedAt": 0}]})
            old = entry.receiver.list_recent
            entry.receiver.list_recent = lambda p, limit=10, folder="INBOX": [
                {"uid": "1", "subject": "s", "unread": True}]
            try:
                out = entry.build_tools()["list_recent_mails"]["handler"]({"limit": 1})
            finally:
                entry.receiver.list_recent = old
            self.assertEqual(out[0]["uid"], "1")

    def test_schemas_complete(self):
        tools = entry.build_tools()
        self.assertEqual(set(tools), {"send_mail", "list_recent_mails", "get_mail"})
        for spec in tools.values():
            self.assertEqual(spec["inputSchema"]["type"], "object")
            self.assertTrue(spec["description"])


class TestMainLoop(unittest.TestCase):
    def test_initialize_list_eof(self):
        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05"}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        ]
        sin, sout = io.StringIO("\n".join(lines) + "\n"), io.StringIO()
        entry.main(sin, sout)
        frames = [json.loads(x) for x in sout.getvalue().strip().split("\n")]
        self.assertEqual(frames[0]["result"]["serverInfo"]["name"],
                         "email-assistant-mcp")
        self.assertEqual(len(frames[1]["result"]["tools"]), 3)

    def test_broken_frame_does_not_kill_process(self):
        sin = io.StringIO("{坏帧\n" + json.dumps(
            {"jsonrpc": "2.0", "id": 9, "method": "ping"}) + "\n")
        sout = io.StringIO()
        entry.main(sin, sout)
        frames = [json.loads(x) for x in sout.getvalue().strip().split("\n")]
        self.assertEqual(frames[0]["error"]["code"], -32700)
        self.assertEqual(frames[1]["result"], {})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_main -v`
Expected: FAIL，`ModuleNotFoundError: email_mcp.__main__`

- [ ] **Step 3: 实现 __main__.py**

```python
"""MCP stdio 入口：组装工具表并驱动协议主循环。python3 <包目录> 启动。"""
from __future__ import annotations

import sys

from . import config, protocol, receiver, sender


def _profile():
    try:
        return config.load_active_profile()
    except config.ConfigError as e:
        raise protocol.ToolError(str(e)) from e


def _wrap_mail_error(e):
    raise protocol.ToolError(str(e)) from e


def build_tools():
    def send_mail(args):
        try:
            return sender.send_mail(_profile(), args)
        except sender.SendError as e:
            _wrap_mail_error(e)

    def list_recent_mails(args):
        try:
            return receiver.list_recent(
                _profile(), limit=args.get("limit", 10),
                folder=args.get("folder", "INBOX"))
        except receiver.ReceiveError as e:
            _wrap_mail_error(e)

    def get_mail(args):
        try:
            return receiver.get_mail(
                _profile(), args.get("uid", ""),
                folder=args.get("folder", "INBOX"),
                mark_read=bool(args.get("mark_read", True)))
        except receiver.ReceiveError as e:
            _wrap_mail_error(e)

    return {
        "send_mail": {
            "description": "用已配置的 QQ 邮箱发送邮件。to 为收件人数组，"
                           "cc 可选抄送，attachments 可选本机绝对路径数组，html 可选。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": {"type": "array", "items": {"type": "string"}},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                    "cc": {"type": "array", "items": {"type": "string"}},
                    "html": {"type": "string"},
                    "attachments": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["to", "subject", "body"],
            },
            "handler": send_mail,
        },
        "list_recent_mails": {
            "description": "列出收件箱（或指定文件夹）最近的邮件信封，"
                           "不含正文；limit 1-50 默认 10，最新在前。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    "folder": {"type": "string"},
                },
            },
            "handler": list_recent_mails,
        },
        "get_mail": {
            "description": "按 uid 取整封邮件（纯文本/HTML 正文与附件清单）；"
                           "mark_read 默认 true，置 false 用 PEEK 不改变已读状态。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string"},
                    "folder": {"type": "string"},
                    "mark_read": {"type": "boolean"},
                },
                "required": ["uid"],
            },
            "handler": get_mail,
        },
    }


def main(stdin=None, stdout=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    tools = build_tools()
    while True:
        try:
            msg = protocol.read_message(stdin)
        except protocol.ProtocolError as e:
            protocol.write_message(stdout,
                                  {"jsonrpc": "2.0", "id": None,
                                   "error": {"code": e.code, "message": str(e)}})
            continue
        if msg is None:
            break
        # 访问日志走 stderr：只记方法与 id，绝不记录参数（参数可能含邮箱地址）
        sys.stderr.write("[email-mcp] recv method=%s id=%s\n"
                         % (msg.get("method"), msg.get("id")))
        try:
            resp = protocol.handle_message(msg, tools)
        except Exception as e:  # 兜底：任何意外都不杀进程
            sys.stderr.write("[email-mcp] 处理失败: %r\n" % e)
            resp = {"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32603, "message": "内部错误: %s" % e}}
        if resp is not None:
            protocol.write_message(stdout, resp)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 实现 selftest.py（脚本方式启动，自举 sys.path）**

```python
"""连通性测试：SMTP login+noop、IMAP login+logout。
插件经 plugin_exec_run 以脚本路径调用：python3 .../email_mcp/selftest.py
成功 stdout 打印一行 base64(JSON)；失败打印 {"error": 中文} 的 base64，退出码 1。"""
import base64
import json
import os
import sys

# 以脚本路径启动时把 mcp/ 目录放进 sys.path，使 email_mcp 包可导入
_MCP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _MCP_DIR not in sys.path:
    sys.path.insert(0, _MCP_DIR)

from email_mcp import config, receiver, sender  # noqa: E402


def _emit(payload, code):
    sys.stdout.write(base64.b64encode(
        json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii"))
    sys.exit(code)


def run():
    try:
        profile = config.load_active_profile()
    except config.ConfigError as e:
        _emit({"error": str(e)}, 1)
    result = {}
    try:
        smtp = sender.smtp_connect(profile)
        try:
            smtp.noop()
        finally:
            smtp.quit()
        result["smtp"] = "ok"
    except sender.SendError as e:
        result["smtp"] = str(e)
    try:
        imap = receiver.imap_connect(profile)
        imap.logout()
        result["imap"] = "ok"
    except receiver.ReceiveError as e:
        result["imap"] = str(e)
    _emit(result, 0 if result.get("smtp") == "ok" and result.get("imap") == "ok" else 1)


if __name__ == "__main__":
    run()
```

- [ ] **Step 5: 跑测试确认通过 + 手测协议握手**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest email_mcp.tests.test_main -v`
Expected: 6 个测试全 PASS

手测（无配置也应正常握手；Windows Git Bash）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 email_mcp
```

Expected: 输出两帧 JSON，第二帧含 3 个工具；进程正常退出不报错

- [ ] **Step 6: 提交**

```bash
git add ccgui-plugin-email-assistant/mcp/email_mcp/__main__.py ccgui-plugin-email-assistant/mcp/email_mcp/selftest.py ccgui-plugin-email-assistant/mcp/email_mcp/tests/test_main.py
git commit -m "feat(email-mcp): stdio 主循环、三工具注册与 selftest 连通脚本

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## Task 6: 插件脚手架 + main.js 纯逻辑层（配置归一化与注册配置生成）

**Files:**
- Create: `ccgui-plugin-email-assistant/manifest.json`
- Create: `ccgui-plugin-email-assistant/styles.css`
- Create: `ccgui-plugin-email-assistant/LICENSE`（复制 `ccgui-plugin-session-wait/LICENSE` 全文）
- Create: `ccgui-plugin-email-assistant/main.js`（本任务只放纯逻辑 + 占位 activate）
- Test: `ccgui-plugin-email-assistant/test/core.test.mjs`

**Interfaces:**
- Consumes: 无（JS 侧首个任务）
- Produces（main.js 命名导出，后续任务与测试依赖）：`NS`、`QQ_PRESET`、`EMAIL_RE`、`b64enc(s)`、`b64dec(s)`、`validateProfileInput(input)`、`buildProfilesPayload(input, existing)`、`buildMcpEntry(pluginDir)`、`mergeClaudeConfig(obj, entry)`、`removeClaudeConfig(obj)`、`mergeProviderConfig(obj, entry)`、`removeProviderConfig(obj)`、`configTargetPaths(home)`、`PY_PLUGIN_DIR`、`PY_WRITE_PROFILE`、`PY_READ_PROFILE`、`PY_REGISTER`；默认导出 `activate(ctx)`（本任务为占位）

- [ ] **Step 1: manifest.json / styles.css / LICENSE**

`manifest.json`：

```json
{
  "id": "email-assistant",
  "name": "邮箱助手",
  "version": "0.1.0",
  "tier": "js",
  "sdkVersion": "^0.3",
  "minAppVersion": "1.1.1",
  "author": "IM Builder",
  "description": "QQ 邮箱参数配置（地址/授权码/显示名）+ 连通性测试 + 一键注册配套 email_mcp 服务，让对话引擎获得发信、列信、取信三个工具。",
  "permissions": [
    "ui:settings-section",
    "storage",
    "exec:python3",
    "theme"
  ],
  "keywords": ["email", "qq邮箱", "smtp", "imap", "mcp", "邮件"],
  "license": "MIT"
}
```

`styles.css`（宿主自动加载，类名统一 `ea-` 前缀）：

```css
.ea-card {
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 16px;
}
.ea-card h4 {
  margin: 0 0 10px;
  font-size: 14px;
}
.ea-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ea-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.ea-btn {
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid rgba(128, 128, 128, 0.5);
  background: transparent;
  color: inherit;
}
.ea-btn-primary {
  border: none;
  background: #1a7f37;
  color: #fff;
  font-weight: 600;
}
.ea-btn-danger {
  border-color: rgba(179, 38, 30, 0.6);
  color: #b3261e;
}
.ea-status-ok { color: #1a7f37; font-size: 12px; }
.ea-status-err { color: #b3261e; font-size: 12px; }
.ea-hint { font-size: 12px; opacity: 0.65; line-height: 1.6; margin-top: 4px; }
.ea-code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.15);
}
```

LICENSE：`cp ccgui-plugin-session-wait/LICENSE ccgui-plugin-email-assistant/LICENSE`

- [ ] **Step 2: 写失败测试 test/core.test.mjs（纯逻辑部分）**

```javascript
// 邮箱助手 · 纯逻辑测试（node --test，零依赖，不启动宿主）
// 运行：cd ccgui-plugin-email-assistant && node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NS, QQ_PRESET, EMAIL_RE, b64enc, b64dec,
  validateProfileInput, buildProfilesPayload,
  buildMcpEntry, mergeClaudeConfig, removeClaudeConfig,
  mergeProviderConfig, removeProviderConfig, configTargetPaths,
} from "../main.js";

test("常量：NS 与 QQ 预设服务器参数", () => {
  assert.equal(NS, "email-assistant");
  assert.deepEqual(QQ_PRESET.smtp, { host: "smtp.qq.com", port: 465, ssl: true });
  assert.deepEqual(QQ_PRESET.imap, { host: "imap.qq.com", port: 993, ssl: true });
});

test("EMAIL_RE：qq/foxmail 通过，非法地址拒绝", () => {
  for (const ok of ["a@qq.com", "a.b@foxmail.com", "x_y@qq.com"]) assert.ok(EMAIL_RE.test(ok));
  for (const bad of ["no-at", "@qq.com", "a@", "a b@qq.com"]) assert.equal(EMAIL_RE.test(bad), false);
});

test("base64 中文往返", () => {
  assert.equal(b64dec(b64enc("中文主题✉️")), "中文主题✉️");
});

test("validateProfileInput：合法输入归一化", () => {
  const r = validateProfileInput({ email: " A@QQ.COM ", authCode: " code1234 ", displayName: " 张三 " });
  assert.equal(r.ok, true);
  assert.equal(r.value.email, "A@QQ.COM");
  assert.equal(r.value.authCode, "code1234");
  assert.equal(r.value.displayName, "张三");
});

test("validateProfileInput：非法邮箱/空授权码报错", () => {
  assert.equal(validateProfileInput({ email: "bad", authCode: "c" }).ok, false);
  const r = validateProfileInput({ email: "a@qq.com", authCode: "  " });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(""), /授权码/);
});

test("validateProfileInput：displayName 缺省回退邮箱前缀", () => {
  const r = validateProfileInput({ email: "zhangsan@qq.com", authCode: "c", displayName: "  " });
  assert.equal(r.value.displayName, "zhangsan");
});

test("buildProfilesPayload：空授权码保留旧授权码，结构含 QQ 预设", () => {
  const existing = { version: 1, activeId: "qq-default", profiles: [{
    id: "qq-default", provider: "qq", email: "old@qq.com", authCode: "KEPT-CODE",
    displayName: "旧", smtp: {}, imap: {}, updatedAt: 1 }] };
  const payload = buildProfilesPayload(
    validateProfileInput({ email: "new@qq.com", authCode: "", displayName: "新" }).value,
    existing);
  assert.equal(payload.activeId, "qq-default");
  const prof = payload.profiles[0];
  assert.equal(prof.email, "new@qq.com");
  assert.equal(prof.authCode, "KEPT-CODE");
  assert.equal(prof.smtp.host, "smtp.qq.com");
  assert.equal(prof.imap.port, 993);
  assert.ok(typeof prof.updatedAt === "number" && prof.updatedAt > 0);
});

test("buildProfilesPayload：无历史文件时空授权码报错由调用方拦截（此处给全量）", () => {
  const payload = buildProfilesPayload(
    validateProfileInput({ email: "a@qq.com", authCode: "fresh", displayName: "" }).value, null);
  assert.equal(payload.profiles[0].authCode, "fresh");
  assert.equal(payload.profiles[0].displayName, "a");
});

test("buildMcpEntry：stdio 条目指向包目录且命令为 python3", () => {
  const e = buildMcpEntry("D:/dev/ccgui-plugin-email-assistant");
  assert.deepEqual(e, {
    type: "stdio", command: "python3", env: {},
    args: ["D:/dev/ccgui-plugin-email-assistant/mcp/email_mcp"],
  });
});

test("mergeClaudeConfig：新注册/幂等/卸载", () => {
  const entry = buildMcpEntry("/tmp/p");
  const r1 = mergeClaudeConfig({ mcpServers: { old: {} } }, entry);
  assert.equal(r1.changed, true);
  assert.equal(r1.obj.mcpServers[NS].command, "python3");
  const r2 = mergeClaudeConfig(r1.obj, entry);
  assert.equal(r2.changed, false); // 幂等
  const r3 = removeClaudeConfig(r2.obj);
  assert.equal(r3.changed, true);
  assert.equal(r3.obj.mcpServers[NS], undefined);
  assert.equal(removeClaudeConfig(r3.obj).changed, false);
});

test("mergeProviderConfig：遍历所有 provider 写入/卸载，缺结构不炸", () => {
  const obj = { claude: { providers: {
    p1: { settingsConfig: { mcpServers: {} } },
    p2: { settingsConfig: {} },
    p3: {},
  } } };
  const r = mergeProviderConfig(obj, buildMcpEntry("/tmp/p"));
  assert.equal(r.changed, true);
  assert.equal(r.obj.claude.providers.p1.settingsConfig.mcpServers[NS].type, "stdio");
  assert.equal(r.obj.claude.providers.p2.settingsConfig.mcpServers[NS].type, "stdio");
  const r2 = removeProviderConfig(r.obj);
  assert.equal(r2.obj.claude.providers.p1.settingsConfig.mcpServers[NS], undefined);
  assert.deepEqual(mergeProviderConfig({}, buildMcpEntry("/tmp/p")).obj, {});
});

test("configTargetPaths：两个注册目标的绝对路径", () => {
  const home = path.join(fileURLToPath("file:///tmp/home"));
  const targets = configTargetPaths(home);
  assert.equal(targets.length, 2);
  assert.match(targets[0], /\.claude\.json$/);
  assert.match(targets[1], /[\\/]\.ccgui-next[\\/]config\.json$/);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant && node --test test/`
Expected: FAIL，`Cannot find module '../main.js'`

- [ ] **Step 4: 实现 main.js 纯逻辑层与 python 片段常量**

`main.js` 完整内容（本任务版本；activate 为占位，Task 8 替换）：

```javascript
// 邮箱助手（CCgui Tier-1 JS 插件，零依赖 ESM）
// 职责：QQ 邮箱配置 UI + 连通性测试 + 配套 email_mcp 服务注册向导。
// 凭据落盘与 MCP 注册均经 plugin_exec_run 调 python 完成（Tier-1 无 FS API）。

export const NS = "email-assistant";

export const QQ_PRESET = {
  provider: "qq",
  smtp: { host: "smtp.qq.com", port: 465, ssl: true },
  imap: { host: "imap.qq.com", port: 993, ssl: true },
};

export const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/* ---------------- base64（与 python 片段约定：UTF-8 标准 base64） ---------------- */

export function b64enc(s) {
  return Buffer.from(String(s), "utf-8").toString("base64");
}
export function b64dec(s) {
  return Buffer.from(String(s), "base64").toString("utf-8");
}

/* ---------------- 表单校验与 profiles.json 载荷构造（纯函数） ---------------- */

export function validateProfileInput(input) {
  const raw = input || {};
  const email = String(raw.email || "").trim();
  const authCode = String(raw.authCode || "").trim();
  const displayName = String(raw.displayName || "").trim();
  const errors = [];
  if (!EMAIL_RE.test(email)) errors.push("邮箱地址格式不正确");
  if (!authCode) errors.push("授权码不能为空（首次保存必须填写）");
  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: { email, authCode, displayName: displayName || email.split("@", 1)[0] },
  };
}

export function buildProfilesPayload(value, existing) {
  const profiles = (existing && Array.isArray(existing.profiles)) ? existing.profiles : [];
  let keptCode = "";
  for (const p of profiles) {
    if (p && p.id === "qq-default") { keptCode = String(p.authCode || ""); break; }
  }
  const authCode = value.authCode || keptCode;
  const profile = {
    id: "qq-default",
    provider: QQ_PRESET.provider,
    email: value.email,
    authCode,
    displayName: value.displayName,
    smtp: Object.assign({}, QQ_PRESET.smtp),
    imap: Object.assign({}, QQ_PRESET.imap),
    updatedAt: Date.now(),
  };
  const rest = profiles.filter((p) => !(p && p.id === "qq-default"));
  rest.unshift(profile);
  return { version: 1, activeId: "qq-default", profiles: rest };
}

/* ---------------- MCP 注册配置（纯函数，目标文件读写在 python 片段） ---------------- */

export function buildMcpEntry(pluginDir) {
  const dir = String(pluginDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    type: "stdio",
    command: "python3",
    args: [dir + "/mcp/email_mcp"],
    env: {},
  };
}

export function mergeClaudeConfig(obj, entry) {
  const cur = Object.assign({}, obj || {});
  const servers = Object.assign({}, cur.mcpServers || {});
  const changed = JSON.stringify(servers[NS]) !== JSON.stringify(entry);
  servers[NS] = entry;
  cur.mcpServers = servers;
  return { changed, obj: cur };
}

export function removeClaudeConfig(obj) {
  const cur = Object.assign({}, obj || {});
  const servers = Object.assign({}, cur.mcpServers || {});
  const changed = Object.prototype.hasOwnProperty.call(servers, NS);
  delete servers[NS];
  cur.mcpServers = servers;
  return { changed, obj: cur };
}

export function mergeProviderConfig(obj, entry) {
  const cur = obj || {};
  const providers = cur && cur.claude && cur.claude.providers;
  if (!providers || typeof providers !== "object") return { changed: false, obj: cur };
  let changed = false;
  for (const pid of Object.keys(providers)) {
    const sc = providers[pid].settingsConfig || (providers[pid].settingsConfig = {});
    const servers = sc.mcpServers || (sc.mcpServers = {});
    if (JSON.stringify(servers[NS]) !== JSON.stringify(entry)) {
      servers[NS] = entry;
      changed = true;
    }
  }
  return { changed, obj: cur };
}

export function removeProviderConfig(obj) {
  const cur = obj || {};
  const providers = cur && cur.claude && cur.claude.providers;
  if (!providers || typeof providers !== "object") return { changed: false, obj: cur };
  let changed = false;
  for (const pid of Object.keys(providers)) {
    const sc = providers[pid].settingsConfig;
    if (sc && sc.mcpServers && Object.prototype.hasOwnProperty.call(sc.mcpServers, NS)) {
      delete sc.mcpServers[NS];
      changed = true;
    }
  }
  return { changed, obj: cur };
}

export function configTargetPaths(home) {
  const h = String(home || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return [h + "/.claude.json", h + "/.ccgui-next/config.json"];
}

/* ---------------- python 片段（经 plugin_exec_run 执行；EMAIL_MCP_HOME 仅测试覆盖） ---------------- */

// 定位插件安装目录：env 显式指定 → ~/.ccgui-next/plugins/email-assistant
export const PY_PLUGIN_DIR = String.raw`
import os, sys
ed = os.environ.get('EMAIL_PLUGIN_DIR')
cands = [ed] if ed else []
home = os.environ.get('EMAIL_MCP_HOME') or os.path.expanduser('~')
cands.append(os.path.join(home, '.ccgui-next', 'plugins', 'email-assistant'))
for c in cands:
    if c and os.path.isfile(os.path.join(c, 'manifest.json')) and \
       os.path.isfile(os.path.join(c, 'mcp', 'email_mcp', 'selftest.py')):
        print(c.replace(os.sep, '/'))
        break
else:
    sys.exit('ERR_NO_PLUGIN_DIR')
`;

// 读非敏感回显字段 + hasAuthCode；无参调用
export const PY_READ_PROFILE = String.raw`
import base64, json, os, sys
home = os.environ.get('EMAIL_MCP_HOME') or os.path.expanduser('~')
p = os.path.join(home, '.ccgui-next', 'plugin-data', 'email-assistant', 'profiles.json')
out = {'configured': False}
if os.path.exists(p):
    try:
        data = json.loads(open(p, encoding='utf-8').read())
        for prof in data.get('profiles', []):
            if isinstance(prof, dict) and prof.get('id') == 'qq-default':
                out = {'configured': True, 'email': prof.get('email', ''),
                       'displayName': prof.get('displayName', ''),
                       'hasAuthCode': bool(prof.get('authCode'))}
                break
    except Exception:
        pass
sys.stdout.write(base64.b64encode(json.dumps(out, ensure_ascii=False).encode('utf-8')).decode('ascii'))
`;

// 写 profiles.json：EA_B64 = {email, authCode(空=保留旧码), displayName}，原子替换
export const PY_WRITE_PROFILE = String.raw`
import base64, json, os, sys, tempfile, time
home = os.environ.get('EMAIL_MCP_HOME') or os.path.expanduser('~')
d = os.path.join(home, '.ccgui-next', 'plugin-data', 'email-assistant')
os.makedirs(d, exist_ok=True)
p = os.path.join(d, 'profiles.json')
payload = json.loads(base64.b64decode(os.environ['EA_B64']).decode('utf-8'))
existing = None
if os.path.exists(p):
    try:
        existing = json.loads(open(p, encoding='utf-8').read())
    except Exception:
        existing = None
email = str(payload.get('email', '')).strip()
auth = str(payload.get('authCode', '')).strip()
display = str(payload.get('displayName', '')).strip() or email.split('@', 1)[0]
kept = ''
if isinstance(existing, dict):
    for prof in existing.get('profiles', []):
        if isinstance(prof, dict) and prof.get('id') == 'qq-default':
            kept = str(prof.get('authCode', ''))
            break
if not auth:
    auth = kept
if not email or '@' not in email:
    sys.exit('ERR_BAD_EMAIL')
if not auth:
    sys.exit('ERR_NO_AUTHCODE')
old_profiles = existing.get('profiles', []) if isinstance(existing, dict) else []
prof = {'id': 'qq-default', 'provider': 'qq', 'email': email, 'authCode': auth,
        'displayName': display,
        'smtp': {'host': 'smtp.qq.com', 'port': 465, 'ssl': True},
        'imap': {'host': 'imap.qq.com', 'port': 993, 'ssl': True},
        'updatedAt': int(time.time() * 1000)}
profiles = [x for x in old_profiles if not (isinstance(x, dict) and x.get('id') == 'qq-default')]
profiles.insert(0, prof)
out = {'version': 1, 'activeId': 'qq-default', 'profiles': profiles}
fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
os.replace(tmp, p)
print('OK')
`;

// MCP 注册/卸载：EA_B64 = {action:'register'|'unregister', pluginDir}，
// 改 ~/.claude.json 与 ~/.ccgui-next/config.json，先备份再原子写，回读校验失败还原。
export const PY_REGISTER = String.raw`
import base64, json, os, shutil, sys, tempfile, time
home = os.environ.get('EMAIL_MCP_HOME') or os.path.expanduser('~')
payload = json.loads(base64.b64decode(os.environ['EA_B64']).decode('utf-8'))
action = payload.get('action', 'register')
plugin_dir = str(payload.get('pluginDir', ''))
entry = {'type': 'stdio', 'command': 'python3',
         'args': [os.path.join(plugin_dir, 'mcp', 'email_mcp')], 'env': {}}
KEY = 'email-assistant'
summary = {'registered': [], 'already': [], 'unregistered': [], 'missing': [], 'errors': []}

def backup(path):
    bak = path + '.bak-email-assistant.' + str(int(time.time()))
    shutil.copy2(path, bak)
    return bak

def atomic_write(path, obj):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        with open(path, encoding='utf-8') as f:
            json.load(f)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise

def apply_target(path, read_view, mutate):
    if not os.path.exists(path):
        summary['missing'].append(path)
        return
    bak = None
    try:
        obj = json.loads(open(path, encoding='utf-8').read())
        view = read_view(obj)
        if view is None:
            summary['missing'].append(path)
            return
        state = mutate(view)  # 'registered' | 'already' | 'unregistered' | 'skip'
        if state in ('registered', 'unregistered'):
            bak = backup(path)
            atomic_write(path, obj)
        summary[state if state != 'skip' else 'already'].append(path)
    except Exception as e:
        if bak and os.path.exists(bak):
            shutil.copy2(bak, path)
        summary['errors'].append(path + ' :: ' + str(e))

def claude_view(obj):
    obj['mcpServers'] = obj.get('mcpServers') or {}
    return obj['mcpServers']

def mut_register(view):
    if json.dumps(view.get(KEY), sort_keys=True) == json.dumps(entry, sort_keys=True):
        return 'already'
    view[KEY] = entry
    return 'registered'

def mut_unregister(view):
    if KEY not in view:
        return 'skip'
    del view[KEY]
    return 'unregistered'

p1 = os.path.join(home, '.claude.json')
p2 = os.path.join(home, '.ccgui-next', 'config.json')
# 目标 1：.claude.json（mcpServers 在根）
apply_target(p1, claude_view, mut)
# 目标 2：CCgui config.json（遍历 claude.providers.*.settingsConfig.mcpServers）
if not os.path.exists(p2):
    summary['missing'].append(p2)
else:
    bak2 = None
    try:
        obj2 = json.loads(open(p2, encoding='utf-8').read())
        providers = (obj2.get('claude') or {}).get('providers') or {}
        if not providers:
            summary['missing'].append(p2)
        else:
            states = []
            for pid in providers:
                sc = providers[pid].setdefault('settingsConfig', {})
                view = sc.setdefault('mcpServers', {})
                states.append(mut(view))   # 先全部变更，杜绝短路漏改
            if 'registered' in states or 'unregistered' in states:
                bak2 = backup(p2)
                atomic_write(p2, obj2)
                summary['registered' if action == 'register' else 'unregistered'].append(p2)
            else:
                summary['already'].append(p2)
    except Exception as e:
        if bak2 and os.path.exists(bak2):
            shutil.copy2(bak2, p2)
        summary['errors'].append(p2 + ' :: ' + str(e))
sys.stdout.write(base64.b64encode(
    json.dumps(summary, ensure_ascii=False).encode('utf-8')).decode('ascii'))
`;

export default function activate(ctx) {
  // Task 8 实现完整设置页；本任务占位保证模块可被宿主加载。
  return function deactivate() {};
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant && node --test test/`
Expected: 12 个测试全 PASS

- [ ] **Step 6: 提交**

```bash
git add ccgui-plugin-email-assistant/manifest.json ccgui-plugin-email-assistant/styles.css ccgui-plugin-email-assistant/LICENSE ccgui-plugin-email-assistant/main.js ccgui-plugin-email-assistant/test/core.test.mjs
git commit -m "feat(email-assistant): 插件脚手架与纯逻辑层（校验/载荷/注册配置）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

## Task 7: python 桥接片段契约测试（临时 HOME，不碰真实配置）

**Files:**
- Create: `ccgui-plugin-email-assistant/test/python-bridge.test.mjs`
- Test: 该文件本身（node:test + node:child_process 调本机 python3）

**Interfaces:**
- Consumes: Task 6 的 `PY_PLUGIN_DIR` / `PY_READ_PROFILE` / `PY_WRITE_PROFILE` / `PY_REGISTER`；Task 5 产出的 `mcp/email_mcp/selftest.py`
- Produces: 无新生产代码；锁定 JS↔python 之间的 env 变量、退出码与 base64 契约

- [ ] **Step 1: 写失败测试 test/python-bridge.test.mjs**

```javascript
// python 桥接契约：所有进程都带 EMAIL_MCP_HOME 指向临时目录，绝不触碰真实 ~/.ccgui-next。
// 运行：cd ccgui-plugin-email-assistant && node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NS, b64enc, b64dec,
  PY_PLUGIN_DIR, PY_READ_PROFILE, PY_WRITE_PROFILE, PY_REGISTER,
} from "../main.js";

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-test-"));
  return {
    dir,
    env(extra = {}) {
      return Object.assign({}, process.env, { EMAIL_MCP_HOME: dir, ...extra });
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), "utf-8");
    },
    exists(rel) {
      return fs.existsSync(path.join(dir, rel));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runPy(snippet, env) {
  return execFileSync("python3", ["-c", snippet], { env, encoding: "utf-8" }).trim();
}

function runPyFail(snippet, env) {
  try {
    execFileSync("python3", ["-c", snippet], { env, encoding: "utf-8" });
    return null;
  } catch (e) {
    return e;
  }
}

test("PY_PLUGIN_DIR：EMAIL_PLUGIN_DIR 显式指定优先", () => {
  const h = tmpHome();
  try {
    const plugin = path.join(h.dir, "my-plugin");
    fs.mkdirSync(path.join(plugin, "mcp", "email_mcp"), { recursive: true });
    fs.writeFileSync(path.join(plugin, "manifest.json"), "{}");
    fs.writeFileSync(path.join(plugin, "mcp", "email_mcp", "selftest.py"), "#");
    const out = runPy(PY_PLUGIN_DIR, h.env({ EMAIL_PLUGIN_DIR: plugin }));
    assert.equal(out, plugin.replace(/\\/g, "/"));
  } finally { h.cleanup(); }
});

test("PY_PLUGIN_DIR：回退到 EMAIL_MCP_HOME 下的安装目录；缺失时报错", () => {
  const h = tmpHome();
  try {
    const plugin = path.join(h.dir, ".ccgui-next", "plugins", NS);
    fs.mkdirSync(path.join(plugin, "mcp", "email_mcp"), { recursive: true });
    fs.writeFileSync(path.join(plugin, "manifest.json"), "{}");
    fs.writeFileSync(path.join(plugin, "mcp", "email_mcp", "selftest.py"), "#");
    assert.match(runPy(PY_PLUGIN_DIR, h.env()), /plugins\/email-assistant$/);
  } finally { h.cleanup(); }

  const h2 = tmpHome();
  try {
    const e = runPyFail(PY_PLUGIN_DIR, h2.env());
    assert.ok(e && String(e.stderr || e.message).includes("ERR_NO_PLUGIN_DIR"));
  } finally { h2.cleanup(); }
});

test("PY_WRITE_PROFILE + PY_READ_PROFILE：写入、回显、原子文件", () => {
  const h = tmpHome();
  try {
    const payload = { email: "tester@qq.com", authCode: "code1234567890", displayName: "测试员" };
    assert.equal(runPy(PY_WRITE_PROFILE, h.env({ EA_B64: b64enc(JSON.stringify(payload)) })), "OK");
    const saved = JSON.parse(h.read(path.join(".ccgui-next", "plugin-data", NS, "profiles.json")));
    assert.equal(saved.activeId, "qq-default");
    assert.equal(saved.profiles[0].smtp.host, "smtp.qq.com");
    assert.equal(saved.profiles[0].imap.port, 993);

    const echo = JSON.parse(b64dec(runPy(PY_READ_PROFILE, h.env())));
    assert.deepEqual(echo, {
      configured: true, email: "tester@qq.com",
      displayName: "测试员", hasAuthCode: true,
    });
  } finally { h.cleanup(); }
});

test("PY_WRITE_PROFILE：空授权码保留旧码；非法邮箱/无码报错", () => {
  const h = tmpHome();
  try {
    runPy(PY_WRITE_PROFILE, h.env({ EA_B64: b64enc(JSON.stringify(
      { email: "a@qq.com", authCode: "FIRST-CODE", displayName: "A" })) }));
    runPy(PY_WRITE_PROFILE, h.env({ EA_B64: b64enc(JSON.stringify(
      { email: "b@qq.com", authCode: "  ", displayName: "B" })) }));
    const saved = JSON.parse(h.read(path.join(".ccgui-next", "plugin-data", NS, "profiles.json")));
    assert.equal(saved.profiles[0].email, "b@qq.com");
    assert.equal(saved.profiles[0].authCode, "FIRST-CODE");

    const e1 = runPyFail(PY_WRITE_PROFILE, h.env({ EA_B64: b64enc(JSON.stringify(
      { email: "bad", authCode: "c", displayName: "" })) }));
    assert.ok(String(e1.stderr || e1.message).includes("ERR_BAD_EMAIL"));
  } finally { h.cleanup(); }

  const h2 = tmpHome();
  try {
    const e2 = runPyFail(PY_WRITE_PROFILE, h2.env({ EA_B64: b64enc(JSON.stringify(
      { email: "new@qq.com", authCode: "", displayName: "" })) }));
    assert.ok(String(e2.stderr || e2.message).includes("ERR_NO_AUTHCODE"));
  } finally { h2.cleanup(); }
});

test("PY_REGISTER：注册→幂等→卸载全流程，两个目标都覆盖并留备份", () => {
  const h = tmpHome();
  try {
    fs.mkdirSync(path.join(h.dir, ".ccgui-next"));
    fs.writeFileSync(path.join(h.dir, ".claude.json"), JSON.stringify({ mcpServers: { old: {} } }));
    fs.writeFileSync(path.join(h.dir, ".ccgui-next", "config.json"), JSON.stringify({
      claude: { providers: { p1: { settingsConfig: { mcpServers: {} } } } } }));
    const pluginDir = path.join(h.dir, "plugin").replace(/\\/g, "/");
    const env = h.env({ EA_B64: b64enc(JSON.stringify({ action: "register", pluginDir })) });

    const s1 = JSON.parse(b64dec(runPy(PY_REGISTER, env)));
    assert.deepEqual(s1.errors, []);
    const claude = JSON.parse(h.read(".claude.json"));
    assert.equal(claude.mcpServers[NS].command, "python3");
    assert.match(claude.mcpServers[NS].args[0], /plugin[\\/]mcp[\\/]email_mcp$/);
    assert.equal(claude.mcpServers.old !== undefined, true); // 原有条目不受影响
    const cfg = JSON.parse(h.read(path.join(".ccgui-next", "config.json")));
    assert.equal(cfg.claude.providers.p1.settingsConfig.mcpServers[NS].type, "stdio");
    assert.ok(h.exists(".claude.json") &&
      fs.readdirSync(h.dir).some((f) => f.startsWith(".claude.json.bak-email-assistant.")));

    const s2 = JSON.parse(b64dec(runPy(PY_REGISTER, env)));
    assert.deepEqual(s2.registered, []); // 幂等：第二次无写入

    const env3 = h.env({ EA_B64: b64enc(JSON.stringify({ action: "unregister", pluginDir })) });
    const s3 = JSON.parse(b64dec(runPy(PY_REGISTER, env3)));
    assert.deepEqual(s3.errors, []);
    const after = JSON.parse(h.read(".claude.json"));
    assert.equal(after.mcpServers[NS], undefined);
    assert.equal(after.mcpServers.old !== undefined, true);
  } finally { h.cleanup(); }
});

test("PY_REGISTER：目标文件缺失记 missing；坏 JSON 记 error 且不改文件", () => {
  const h = tmpHome();
  try {
    const env = h.env({ EA_B64: b64enc(JSON.stringify(
      { action: "register", pluginDir: path.join(h.dir, "plugin").replace(/\\/g, "/") })) });
    const s1 = JSON.parse(b64dec(runPy(PY_REGISTER, env)));
    assert.equal(s1.missing.length, 2);

    fs.mkdirSync(path.join(h.dir, ".ccgui-next"));
    fs.writeFileSync(path.join(h.dir, ".claude.json"), "{坏了");
    const before = h.read(".claude.json");
    const s2 = JSON.parse(b64dec(runPy(PY_REGISTER, env)));
    assert.equal(s2.errors.length, 1);
    assert.equal(h.read(".claude.json"), before); // 坏文件原样保留
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd ccgui-plugin-email-assistant && node --test test/`
Expected: 全部 PASS（Task 6 已实现这些片段；若失败说明片段与契约不符，修 `main.js` 中的 python 字符串直到全绿，不改测试）

- [ ] **Step 3: 跑 Python 全量回归并提交**

Run: `cd ccgui-plugin-email-assistant/mcp && python -m unittest discover -s email_mcp/tests -v`
Expected: 全部 PASS

```bash
git add ccgui-plugin-email-assistant/test/python-bridge.test.mjs ccgui-plugin-email-assistant/main.js
git commit -m "test(email-assistant): python 桥接片段契约测试（临时 HOME 隔离）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: activate 设置页（账号表单 / 连通测试 / 注册向导）

**Files:**
- Modify: `ccgui-plugin-email-assistant/main.js`（新增 `PY_CHECK_REGISTER` 导出；替换占位 `activate`）
- Create: `ccgui-plugin-email-assistant/test/ui-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 6 全部纯函数与 python 片段、Task 5 的 selftest.py、宿主 `ctx.bridge.invoke("plugin_exec_run")` / `ctx.ui.registerSettingsSection` / `ctx.react` / `ctx.host.locale`
- Produces: 完整可用的设置页；新导出 `PY_CHECK_REGISTER`

- [ ] **Step 1: 写失败测试 test/ui-wiring.test.mjs**

```javascript
// activate 装配测试：不渲染 React，只验证注册行为与 PY_CHECK_REGISTER 契约。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import activateMod, { NS, b64enc, b64dec, PY_CHECK_REGISTER } from "../main.js";

function mockCtx() {
  const sections = [];
  return {
    sections,
    react: {
      createElement: (...a) => ({ __el: a }),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
    },
    host: { locale: "zh-CN", appVersion: "1.1.1" },
    storage: { get: async () => undefined, set: async () => {} },
    bridge: { invoke: async () => ({ code: 0, stdout: "" }) },
    ui: { registerSettingsSection: (s) => sections.push(s) },
    theme: {},
  };
}

test("activate：注册设置页且卸载不抛异常", () => {
  const ctx = mockCtx();
  const deactivate = activateMod(ctx);
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].key, NS);
  assert.equal(typeof ctx.sections[0].component, "function");
  assert.doesNotThrow(() => deactivate());
});

test("activate：宿主不支持设置页时不致命", () => {
  const ctx = mockCtx();
  ctx.ui.registerSettingsSection = () => { throw new Error("unsupported"); };
  assert.doesNotThrow(() => activateMod(ctx));
});

test("PY_CHECK_REGISTER：两个目标的注册状态检测", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-check-"));
  try {
    const env = Object.assign({}, process.env, { EMAIL_MCP_HOME: dir });
    const run = () => JSON.parse(b64dec(execFileSync(
      "python3", ["-c", PY_CHECK_REGISTER], { env, encoding: "utf-8" }).trim()));
    assert.deepEqual(run(), { claude: false, providers: {} });

    fs.mkdirSync(path.join(dir, ".ccgui-next"));
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
      mcpServers: { [NS]: { type: "stdio" } } }));
    fs.writeFileSync(path.join(dir, ".ccgui-next", "config.json"), JSON.stringify({
      claude: { providers: { p1: { settingsConfig: { mcpServers: {} } } } } }));
    const r2 = run();
    assert.equal(r2.claude, true);
    assert.equal(r2.providers.p1, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ccgui-plugin-email-assistant && node --test test/ui-wiring.test.mjs`
Expected: FAIL，`PY_CHECK_REGISTER is not a function`（或 activate 为占位未注册 section）

- [ ] **Step 3: 在 main.js 增加 PY_CHECK_REGISTER（放在 PY_REGISTER 之后）**

```javascript
// 只读检测两个注册目标是否已有 email-assistant 条目
export const PY_CHECK_REGISTER = String.raw`
import base64, json, os, sys
home = os.environ.get('EMAIL_MCP_HOME') or os.path.expanduser('~')
KEY = 'email-assistant'
out = {'claude': False, 'providers': {}}
p1 = os.path.join(home, '.claude.json')
if os.path.exists(p1):
    try:
        d = json.loads(open(p1, encoding='utf-8').read())
        out['claude'] = KEY in (d.get('mcpServers') or {})
    except Exception:
        pass
p2 = os.path.join(home, '.ccgui-next', 'config.json')
if os.path.exists(p2):
    try:
        d = json.loads(open(p2, encoding='utf-8').read())
        for pid, prov in ((d.get('claude') or {}).get('providers') or {}).items():
            sc = prov.get('settingsConfig') or {}
            out['providers'][pid] = KEY in (sc.get('mcpServers') or {})
    except Exception:
        pass
sys.stdout.write(base64.b64encode(json.dumps(out, ensure_ascii=False).encode('utf-8')).decode('ascii'))
`;
```

- [ ] **Step 4: 替换 activate 为完整设置页实现**

把占位 `activate` 整体替换为以下实现（保留文件上方全部纯逻辑导出不动）：

```javascript
/* ---------------- 宿主装配 ---------------- */

function zh(locale) {
  return String(locale || "").toLowerCase().indexOf("zh") === 0;
}

function toast(msg, ok) {
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483000;" +
    "padding:9px 14px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;color:#fff;" +
    "background:" + (ok === false ? "#b3261e" : "#1a7f37") +
    ";box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:70vw;word-break:break-all";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

export default function activate(ctx) {
  const h = ctx.react.createElement;
  const useState = ctx.react.useState;
  const useEffect = ctx.react.useEffect;
  const isZh = zh(ctx.host.locale);

  let pluginDir = "";

  async function runPy(py, env, timeoutMs) {
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "python3", args: ["-c", py], env: env || {}, timeoutMs: timeoutMs || 15000,
    });
    if (!res || res.code !== 0) {
      throw new Error((res && res.stderr && String(res.stderr).trim()) ||
        ("python3 退出码 " + (res ? res.code : "?")));
    }
    return String(res.stdout || "").trim();
  }

  async function resolvePluginDir() {
    if (pluginDir) return pluginDir;
    pluginDir = (await runPy(PY_PLUGIN_DIR, {})).replace(/\//g, pathSep());
    return pluginDir;
  }

  function pathSep() {
    return (navigator && navigator.userAgent && /windows/i.test(navigator.userAgent)) ? "\\" : "/";
  }

  async function runSelftest() {
    const dir = await resolvePluginDir();
    const script = [dir, "mcp", "email_mcp", "selftest.py"].join(pathSep());
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "python3", args: [script], env: {}, timeoutMs: 15000,
    });
    // selftest 失败时退出码 1 但 stdout 仍带 base64 部分结果
    const out = String((res && res.stdout) || "").trim();
    if (out) return JSON.parse(b64dec(out));
    throw new Error((res && res.stderr) || "连通性测试无输出");
  }

  function Field(label, node, hint) {
    return h("div", { style: { marginBottom: 14 } },
      h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, label),
      node,
      hint ? h("div", { className: "ea-hint" }, hint) : null);
  }

  function Settings() {
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [authCode, setAuthCode] = useState("");
    const [saved, setSaved] = useState(null);   // {configured,email,displayName,hasAuthCode}
    const [busy, setBusy] = useState("");       // "" | "save" | "test" | "register"
    const [testResult, setTestResult] = useState(null);
    const [regInfo, setRegInfo] = useState(null); // {claude, providers}
    const [regMsg, setRegMsg] = useState("");

    async function refresh() {
      try {
        const info = JSON.parse(b64dec(await runPy(PY_READ_PROFILE, {})));
        setSaved(info);
        if (info.configured) {
          setEmail(info.email || "");
          setDisplayName(info.displayName || "");
        }
      } catch (e) {
        setSaved({ configured: false });
      }
      try {
        setRegInfo(JSON.parse(b64dec(await runPy(PY_CHECK_REGISTER, {}))));
      } catch (e) {
        setRegInfo(null);
      }
    }

    useEffect(() => { refresh(); }, []);

    async function onSave() {
      const v = validateProfileInput({ email, authCode, displayName });
      if (!v.ok) { toast(v.errors.join("；"), false); return; }
      if (!authCode && !(saved && saved.hasAuthCode)) {
        toast("首次保存必须填写 QQ 邮箱授权码", false);
        return;
      }
      setBusy("save");
      try {
        await runPy(PY_WRITE_PROFILE, { EA_B64: b64enc(JSON.stringify(v.value)) });
        toast("配置已保存", true);
        await refresh();
        setAuthCode("");
      } catch (e) {
        toast("保存失败：" + ((e && e.message) || e), false);
      } finally { setBusy(""); }
    }

    async function onTest() {
      setBusy("test");
      setTestResult(null);
      try {
        const r = await runSelftest();
        setTestResult(r);
      } catch (e) {
        setTestResult({ smtp: String((e && e.message) || e), imap: "未执行" });
      } finally { setBusy(""); }
    }

    async function onRegister(action) {
      setBusy("register");
      setRegMsg("");
      try {
        const dir = await resolvePluginDir();
        const out = JSON.parse(b64dec(await runPy(PY_REGISTER, {
          EA_B64: b64enc(JSON.stringify({ action, pluginDir: dir.replace(/\\/g, "/") })),
        })));
        const parts = [];
        if (out.registered && out.registered.length) parts.push("已写入 " + out.registered.length + " 处");
        if (out.unregistered && out.unregistered.length) parts.push("已移除 " + out.unregistered.length + 处");
        if (out.already && out.already.length) parts.push("已是目标状态 " + out.already.length + " 处");
        if (out.missing && out.missing.length) parts.push("缺失跳过 " + out.missing.length + " 处");
        if (out.errors && out.errors.length) parts.push("错误：" + out.errors.join("；"));
        setRegMsg(parts.join("，") || "无变化");
        await refresh();
      } catch (e) {
        setRegMsg("操作失败：" + ((e && e.message) || e));
      } finally { setBusy(""); }
    }

    const inputCls = "ea-input";
    const registered = regInfo && (regInfo.claude ||
      Object.values(regInfo.providers || {}).some(Boolean));

    return h("div", { style: { padding: "4px 2px", maxWidth: 720 } },
      h("div", { className: "ea-card" },
        h("h4", null, "QQ 邮箱账号"),
        Field("邮箱地址（qq.com / foxmail.com）",
          h("input", { className: inputCls, value: email, placeholder: "name@qq.com",
            onChange: (e) => setEmail(e.target.value) })),
        Field("授权码",
          h("input", { className: inputCls, type: "password", value: authCode,
            placeholder: saved && saved.hasAuthCode ? "已保存，留空表示不修改" : "QQ 邮箱设置中生成的 16 位授权码",
            onChange: (e) => setAuthCode(e.target.value) }),
          "获取方式：QQ 邮箱 → 设置 → 账号 → POP3/IMAP/SMTP 服务开启 → 生成授权码。授权码等同于密码，仅存于本机 plugin-data 目录。"),
        Field("发件显示名（可选）",
          h("input", { className: inputCls, value: displayName, placeholder: "默认取邮箱前缀",
            onChange: (e) => setDisplayName(e.target.value) })),
        h("div", { className: "ea-hint" },
          h("span", { className: "ea-code" }, "SMTP smtp.qq.com:465 (SSL)"), "　",
          h("span", { className: "ea-code" }, "IMAP imap.qq.com:993 (SSL)")),
        h("button", { className: "ea-btn ea-btn-primary", disabled: busy === "save",
          onClick: onSave }, busy === "save" ? "保存中…" : "保存配置")),

      h("div", { className: "ea-card" },
        h("h4", null, "连通性测试"),
        h("button", { className: "ea-btn", disabled: busy === "test", onClick: onTest },
          busy === "test" ? "测试中…" : "测试 SMTP / IMAP 连接"),
        testResult ? h("div", { style: { marginTop: 8, fontSize: 12, lineHeight: 1.8 } },
          h("div", { className: testResult.smtp === "ok" ? "ea-status-ok" : "ea-status-err" },
            "SMTP：" + (testResult.smtp === "ok" ? "连接正常" : testResult.smtp)),
          h("div", { className: testResult.imap === "ok" ? "ea-status-ok" : "ea-status-err" },
            "IMAP：" + (testResult.imap === "ok" ? "连接正常" : testResult.imap))) : null),

      h("div", { className: "ea-card" },
        h("h4", null, "MCP 服务注册"),
        h("div", { className: "ea-hint", style: { marginBottom: 8 } },
          registered
            ? "当前状态：已检测到 email-assistant 注册条目。修改配置后需重启对话引擎 / 重连 MCP 生效。"
            : "当前状态：未注册。注册后对话引擎将获得 send_mail / list_recent_mails / get_mail 三个工具。"),
        h("div", { className: "ea-row" },
          h("button", { className: "ea-btn ea-btn-primary", disabled: busy === "register",
            onClick: () => onRegister("register") }, "一键注册"),
          h("button", { className: "ea-btn ea-btn-danger", disabled: busy === "register",
            onClick: () => onRegister("unregister") }, "卸载注册")),
        regMsg ? h("div", { className: "ea-hint", style: { marginTop: 6 } }, regMsg) : null,
        h("div", { className: "ea-hint" },
          "写入 ~/.claude.json 与 ~/.ccgui-next/config.json，写前自动备份（.bak-email-assistant.时间戳），失败自动还原。")));
  }

  try {
    ctx.ui.registerSettingsSection({
      key: NS,
      label: () => (isZh ? "邮箱助手" : "Email Assistant"),
      component: Settings,
    });
  } catch (e) {
    // 宿主不支持设置页时不致命
  }

  return function deactivate() {};
}
```

- [ ] **Step 5: 跑全部 JS 测试确认通过**

Run: `cd ccgui-plugin-email-assistant && node --test test/`
Expected: 全部 PASS（含 Task 6/7 用例与本任务 3 个新用例）

- [ ] **Step 6: 提交**

```bash
git add ccgui-plugin-email-assistant/main.js ccgui-plugin-email-assistant/test/ui-wiring.test.mjs
git commit -m "feat(email-assistant): 设置页完整实现（账号/连通测试/注册向导）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: 两份 README + 全量验证与交付检查

**Files:**
- Create: `ccgui-plugin-email-assistant/README.md`
- Create: `ccgui-plugin-email-assistant/mcp/README.md`

**Interfaces:**
- Consumes: 前 8 个任务的全部产物
- Produces: 可评审、可安装、可独立分发的完整插件目录

- [ ] **Step 1: 写插件 README.md**

内容必须包含以下小节（中文）：

1. 标题与一句话简介；功能清单（QQ 配置 / 连通测试 / 一键注册 / 三工具）
2. 安装：CCgui 设置 → 插件 →「从本地目录安装」选中含 manifest.json 的目录；更新需重装同 id 覆盖；要求本机 `python3` 可用（与便签会话查询插件相同环境）
3. QQ 邮箱授权码获取步骤（设置 → 账号 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务 → 开启 IMAP/SMTP → 生成授权码）
4. 使用流程：保存配置 → 连通性测试 → 一键注册 → 重启对话引擎 → 在对话中让 AI 发信/收信
5. 三个 MCP 工具的参数说明表（与 Task 5 的 inputSchema 一致）
6. 安全提示：授权码明文存于 `~/.ccgui-next/plugin-data/email-assistant/profiles.json`，勿提交仓库/同步网盘，建议定期轮换；注册写配置前自动备份
7. 开发与测试命令：`node --test test/` 与 `cd mcp && python -m unittest discover -s email_mcp/tests`
8. 目录结构说明与 MIT 许可

- [ ] **Step 2: 写 mcp/README.md（独立分发说明）**

内容包含：环境要求（Python 3.9+，零依赖）；独立宿主注册 JSON 片段：

```json
"email-assistant": {
  "type": "stdio",
  "command": "python3",
  "args": ["<解压目录>/mcp/email_mcp"],
  "env": {}
}
```

配置文件位置与 `EMAIL_MCP_HOME` 覆盖说明；三工具参数表；协议版本 `2024-11-05`；手动握手示例（printf 管道 initialize + tools/list）；测试命令。

- [ ] **Step 3: 全量自动化验证**

Run:

```bash
cd ccgui-plugin-email-assistant && node --test test/
cd mcp && python -m unittest discover -s email_mcp/tests -v
```

Expected: JS 与 Python 测试全部 PASS，记录测试数量与输出摘要到提交说明（若任何 FAIL，停下修复，不得带红提交）

- [ ] **Step 4: MCP 握手手工验证（无需真实邮箱）**

```bash
cd ccgui-plugin-email-assistant/mcp
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 email_mcp
```

Expected: 两帧 JSON；第一帧 serverInfo.name 为 `email-assistant-mcp`；第二帧 tools 恰好三个且名字为 `get_mail`、`list_recent_mails`、`send_mail`（字母序）；进程退出码 0

- [ ] **Step 5: 凭据泄漏静态检查**

Run:

```bash
cd ccgui-plugin-email-assistant
grep -rn "authCode" test/ | grep -v "hasAuthCode\|KEPT-CODE\|FIRST-CODE\|code1234567890\|authCode.*=\|authCode:" || true
grep -rn "@qq.com" test/ | grep -v "tester@qq.com\|a@qq.com\|b@qq.com\|new@qq.com\|old@qq.com\|t@qq.com\|name@qq.com\|lao@qq.com\|zhangsan@qq.com" || true
```

Expected: 无真实授权码/真实邮箱出现；测试夹具仅含假地址。再确认 git 状态中没有 profiles.json：`git status --short | grep profiles.json` 应无输出

- [ ] **Step 6: 提交并交付**

```bash
git add ccgui-plugin-email-assistant/README.md ccgui-plugin-email-assistant/mcp/README.md
git commit -m "docs(email-assistant): 插件与 MCP 服务使用文档

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

交付后向用户说明：自动化与握手验证已完成；真实 QQ 收发闭环（spec 7.3）需用户在设置页填入真实授权码后按 README 步骤人工执行，授权码不要发在对话里。
