<div align="center">
  <h1 align="center">
    <img src="media/icon.svg" width="128" alt="icon"/>
    <br/>
    DeepSeek Harness for VS Code
  </h1> 
  
  <p>
    A zero-dependency VS Code extension that brings <strong>DeepSeek Harness (DSH)</strong> into VS Code in two forms
  </p>

<!-- Badges -->

![Platform](https://img.shields.io/badge/Platform-VSCode-blue?style=for-the-badge)
![GitHub Release](https://img.shields.io/github/v/release/Vithrive/Deepseek-Harness-for-VS-Code?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/Vithrive/Deepseek-Harness-for-VS-Code?style=for-the-badge)
![GitHub Last Commit](https://img.shields.io/github/last-commit/Vithrive/Deepseek-Harness-for-VS-Code?style=for-the-badge)
[![Total Download](https://img.shields.io/github/downloads/Vithrive/Deepseek-Harness-for-VS-Code/total?style=for-the-badge)](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/releases)

[简体中文](README.md) | [English](README_en.md)

</div>

---

<div align="center">

⭐ If you like this extension, please give it a star on [Deepseek-Harness-for-VS-Code](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code) ⭐<br>If you also need a Chrome extension, check out [Deepseek-Harness-for-Chrome](https://github.com/Vithrive/Deepseek-Harness-for-Chrome)

</div>

## ✨ Two Forms

1. **🪟 Faithful Window**: Embeds DSH's Web GUI as-is into the VS Code sidebar / secondary sidebar / editor tab, auto-detecting and launching the DSH service — no script injection, no UI rewriting, no interaction interception, and no impact on any of your secondary development on DSH, such as page organization or third-party plugin assembly;
2. **🧭 Copilot Bridge** (since v0.7.13, early version): Registers DSH as a VS Code chat model — entries such as **DSH (DeepSeek Harness), DeepSeek-V4-Pro (DSH), DeepSeek-V4-Flash (DSH), deepseek-v4-flash-vision-exp (DSH)** appear in the model picker; selecting one lets you solve problems in Copilot Chat with DSH's powerful task orchestration and tool-calling capabilities.

> 💡 **Copilot Bridge does not affect the Faithful Window form** — it is only a feature enhancement for convenient coding; when you don't select these model entries, everything behaves exactly as if the bridge didn't exist.

---

## 📚 Table of Contents

- [🚀 Quick Installation](#quick-installation)
- [🪟 Faithful Window (Panel)](#faithful-window-panel)
- [🧭 Copilot Bridge: Usage Guide](#copilot-bridge-usage-guide)
- [🧩 Copilot Bridge: How It Works](#copilot-bridge-how-it-works)
- [🌱 Version Status Statement](#version-status-statement)
- [🔧 Install from Source (Dev Mode)](#install-from-source-dev-mode)
- [⚠️ Prerequisites and Known Limitations](#prerequisites-and-known-limitations)

---

## 🚀 Quick Installation

- **Marketplace**: Search for **DeepSeek Harness for VSCode** in the VS Code marketplace and install it with one click ([Marketplace page](https://marketplace.visualstudio.com/items?itemName=vithrive.deepseek-harness-vscode)).
- **.vsix**: Download `deepseek-harness-vscode-<version>.vsix` from [GitHub Releases](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/releases/latest), then:
  ```bash
  code --install-extension deepseek-harness-vscode-<version>.vsix
  ```
  Or in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

After installation, run `Ctrl+Shift+P` → `Reload Window`. When you open the panel, the extension automatically detects and starts DSH (if DSH isn't installed, it will prompt and run `npm install -g @deepseek-ai/dsh` on your behalf).

---

## 🪟 Faithful Window (Panel)

- Embeds the DSH Web GUI as-is into the sidebar / secondary sidebar / **editor tab** (tabs can be pinned; the sidebar's "single active view" yields automatically to work around DSH frontend's single-instance webview limitation);
- **Auto-detect / auto-start / auto-install** dsh, rendering only after the service is ready to avoid blank screens;
- **Automatic workspace hookup**: starts dsh with the current VS Code workspace and registers it in DSH's workspace list (idempotent; doesn't overwrite your manual selection in DSH);
- **Remote support**: under Remote-SSH / Dev Containers it runs on the server side, automatically detecting and installing server-side dsh and wiring the panel into your local VS Code via port forwarding;
- Panel buttons: refresh (doesn't interrupt running tasks) / restart dsh web / open in browser; font size scales proportionally with `editor.fontSize`;
- **Send selection / drag-and-drop files into the DSH chat box** (auto-installs the companion plugin `dsh-drop-caret`): inserts files, folders, and code snippets into the chat box at the exact caret position as `path:line` references; clicking external links in DSH conversations opens them in the system browser (works with the DSH plugin `dsh-open-links`).

### Usage Example: Sending a Selection to the Chat Box

Drag-and-drop / right-click send is the most commonly used capability of `dsh-drop-caret`:

1. **Select** a block of code / text in VS Code;
2. **Right-click** and choose **「DeepSeek Harness: Send Selection to Chat Box」**:

   ![Right-click menu: Send selection to chat box](media/send-selection-menu.png)
3. A link to the selected lines (`path:start-line-end-line`) is sent to the chat box, inserted at the current caret position:

   ![The sent result appears in the DSH chat box](media/send-selection-result.png)
4. Just send the message in DSH — the model can pinpoint the exact file and line numbers via the reference.

> 💡 Likewise, you can **drag** files / folders directly from the system file manager or the VS Code Explorer into the chat box; the insertion position is the caret position corresponding to the drop point.

### Panel-Related Configuration

| Config | Default | Description |
| --- | --- | --- |
| `dshPanel.url` | `http://127.0.0.1:3080` | DSH address the panel connects to |
| `dshPanel.host` / `dshPanel.port` | `127.0.0.1` / `3080` | Host and port to bind when auto-starting |
| `dshPanel.autoStart` | `true` | Whether to auto-start dsh when it isn't running |
| `dshPanel.autoRegisterWorkspace` | `true` | Whether to auto-register the current workspace as a DSH workspace |
| `dshPanel.autoInstallDsh` | `true` | Whether to prompt and install dsh on your behalf when it isn't installed |
| `dshPanel.dshCommand` | `dsh` | The dsh command (can be a full path) |
| `dshPanel.killOnDispose` | `true` | Whether to terminate the dsh it started when the extension is deactivated |

### Remote Server (vscode-server) Scenario

The extension declares `extensionKind: ["workspace"]`, so under Remote-SSH / Dev Containers etc. it runs on the server side:

1. Auto-detects and installs server-side dsh (`npm install -g @deepseek-ai/dsh`; requires Node.js and npm on the server);
2. Automatic port forwarding: exposes remote `127.0.0.1:3080` to your local machine via `vscode.env.asExternalUri`, and the iframe loads directly — no manual SSH tunnel needed (just allow the first forwarding prompt);
3. dsh starts with the remote workspace as cwd and registers automatically.

If DSH runs on another machine and isn't connected via VS Code Remote, you can set up a tunnel manually: `ssh -L 3080:127.0.0.1:3080 user@server`, and set `dshPanel.autoStart` to `false`.

---

## 🧭 Copilot Bridge: Usage Guide

### Quick Start

1. Open the Chat panel (`Ctrl+Alt+I`) → in the model picker (`Ctrl+Alt+.`), select **DSH (DeepSeek Harness)** (or directly select a fixed entry like **DeepSeek-V4-Pro (DSH)**);
2. Just ask, e.g. "help me analyze this project's data" — DSH executes the task in your workspace with its configured model, calls tools to solve it, and **streams** the answer back into the chat box;
3. Each Copilot chat maps to one DSH session: **a new chat creates a new DSH session, and follow-up questions within the same chat reuse the same session**; you can watch the full execution process in the DSH panel in real time.

### Models & Reasoning Effort

- **Model**: the `DSH (DeepSeek Harness)` entry follows the default model configured in DSH settings (`agent-default-model`); you can also specify one via `dshPanel.chatProvider` / `dshPanel.chatModel` (e.g. `deepseek-official` / `deepseek-v4-pro`, provided the corresponding provider is configured in DSH settings). Fixed entries like **DeepSeek-V4-Pro (DSH)** in the model picker always map to the official DeepSeek models.
- **Reasoning effort**: select it in the model configuration in the chat UI (off / low / high / max, synced to the DSH session); `dshPanel.dshReasoningEffort` serves as the fallback config.

### Switching Models and Switching Back

If you switch to another custom model mid-conversation and then switch back to the DSH model, the extension **tags the intermediate turns produced by the other model with an origin label and sends them to the DSH session**; content DSH already answered is not re-sent (saves tokens, doesn't consume context) — the timeline on the DSH side stays complete.

### Common Commands

| Command | Description |
| --- | --- |
| `DeepSeek Harness: Reset DSH Session Mapping` | Clears the "chat → DSH session" mapping; the next question creates a brand-new DSH session |
| `DeepSeek Harness: Check DSH Status` | Shows whether DSH is reachable, whether model providers are registered, and the current model configuration |
| `DeepSeek Harness: Diagnose DSH Model Registry` | Exports model-registry diagnostic data (for troubleshooting) |

> 💡 Cancelling the wait does not kill the DSH task: the task keeps running in DSH, and you can check it in the panel.

### Bridge-Related Configuration

| Config | Default | Description |
| --- | --- | --- |
| `dshPanel.enableDshModel` | `true` | Whether to register the DSH chat model entries (if disabled, the bridge stops working; the panel is unaffected) |
| `dshPanel.chatProvider` / `dshPanel.chatModel` | empty | Provider / model used by the `DSH (DeepSeek Harness)` entry (e.g. `deepseek-official` / `deepseek-v4-pro`); leave empty to follow DSH's default |
| `dshPanel.chatAgentPreset` | empty | Agent preset used when creating DSH sessions (e.g. `liangshen`); empty = DSH default |
| `dshPanel.dshReasoningEffort` | empty | Reasoning-effort fallback: off / low / high / max; the UI selection takes precedence |
| `dshPanel.chatTimeoutMs` | `900000` | Max milliseconds to wait for a single task (15 minutes); on timeout the task keeps running in the DSH panel |
| `dshPanel.chatSyncLookbackMin` | `60` | Chat session file scan window (minutes) |
| `dshPanel.debugModelMessages` | `false` | Debug: writes the message structure VS Code sends to the model into `.dsh-debug/` |

---

## 🧩 Copilot Bridge: How It Works

Overall data flow:

```
Copilot Chat (conversation organized by VS Code)
        │  language model provider protocol (vscode.lm.registerLanguageModelChatProvider)
        ▼
This extension (dsh provider)
  1. Filter out noise: strip system prompts, tool definitions, and environment/context wrappers (<prompt>/<userRequest>/<instructions>…),
     keeping only the real Q&A and Copilot memory content
  2. Session mapping: keyed by the Copilot chat's sessionId, mapped to a DSH session (one chat, one session)
  3. Incremental sync: send DSH only what it hasn't seen (its own answers are not re-sent; other models' Q&A is re-sent with an origin label)
  4. Effort sync: pass the reasoningEffort chosen in the UI to DSH (session.selectModel)
        │  session.create / session.prompt / session.history (DSH RPC)
        ▼
DSH: re-organizes with its own harness (memory / skills / AGENTS.md / tools / agent presets), then hands off to the configured model for execution
        │  streaming events (text-delta)
        ▼
This extension: incrementally streams the response back into the Copilot chat box
```

Key points:

- **Noise filtering**: every message VS Code hands to the model may be wrapped in `<instructions>` (.copilot/instructions, AGENTS.md references), `<prompt>` (the real question), `<userMemory>/<sessionMemory>` memory blocks, etc. The extension extracts only the real questions and memory content — context organization is left to DSH's own harness, avoiding interference between the two harnesses.
- **Session mapping (direct sessionId mapping)**: each Copilot chat has a unique file on disk, `workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl` (the filename IS the sessionId). The extension builds a one-to-one "chat → DSH session" mapping keyed by `m-<sessionId>`:
  - Non-first turn: claims the chat file by matching "the last question in the file == the previous turn's question in the current transcript" (the previous turn is always already written to disk — zero races, zero waiting);
  - First turn: the new chat file only has metadata at this point, so the extension treats the "empty chat file created within the last 60 seconds" as the current chat;
  - Compatible with Windows / macOS / Linux and different user-data directories including vscode-server (Remote-SSH / WSL / Dev Containers), preferring to match the current workspace;
  - Fallback: in rare cases like request-write races, falls back to the first-question hash, with transcript verification to prevent cross-wiring.
- **Incremental sync (saves tokens)**: the DSH session replays its own answered content, so the extension only sends what's new after DSH's last answer — in a continuous conversation it sends only the new question; when you switch away and back, external Q&A is re-sent with the `【Copilot other-model answer】` label.
- **Double-delivery deduplication**: VS Code delivers the same question twice (bare question + question with context); the extension recognizes them as the same question and executes only once, replaying the same answer on the other delivery.
- **Concurrency support**: when multiple chats use the DSH model at the same time, each chat locates independently, has its own session, and returns in parallel; the extension memoizes and caches startup probes and file parsing so concurrent chats don't slow each other down.

---

## 🌱 Version Status Statement

Copilot Bridge is an **early version**, but it has been thoroughly tested and is **fully functional**:

- We welcome you to test it on different operating systems (Windows / macOS / Linux, as well as remote scenarios like Remote-SSH, WSL, Dev Containers);
- If you run into any issues, please open them on [GitHub Issues](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/issues) — the author will respond and improve quickly;
- To reiterate: **Copilot Bridge does not affect the Faithful Window form** — the panel always faithfully presents the DSH Web GUI, injecting, rewriting, or intercepting nothing on the page, and it doesn't interfere with your plugin development or UI customization on DSH.

---

## 🔧 Install from Source (Dev Mode)

This extension is pure JavaScript — no npm install, no compilation needed:

```bash
git clone https://github.com/Vithrive/Deepseek-Harness-for-VS-Code.git
code Deepseek-Harness-for-VS-Code
```

Press `F5` in VS Code to open the Extension Development Host window, then open your project folder in it. To package and install it yourself:

```bash
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension deepseek-harness-vscode-<version>.vsix
```

## ⚠️ Prerequisites and Known Limitations

- **Prerequisites**: DeepSeek Harness installed (`npm install -g @deepseek-ai/dsh` globally or `npx @deepseek-ai/dsh` — the extension auto-detects both, or you can point to a full path with `dshPanel.dshCommand`); DSH's default response headers don't set `X-Frame-Options` / strict CSP, so it can be embedded in an iframe normally.
- **Known limitations**: DSH's frontend degrades to a single instance under multiple VS Code webviews (multiple tabs in a regular browser work fine; this is a DSH frontend implementation issue), so the tab and sidebar can't load DSH simultaneously; the extension works around this with a "single active view" strategy (opening a tab makes the sidebar automatically yield and show a placeholder, and it restores automatically when closed).
