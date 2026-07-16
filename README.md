# Norma

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

**An AI that actually lives on your Mac.**

Norma sits quietly in your menu bar, always within reach. Talk to her there, or from any terminal by typing `norma`. She can see your screen, read your files, remember things about you and your work, and keep herself up to date — all without ever leaving your machine unattended or asking you to hand over your data.

## What she can do

- **She sees your screen.** Norma can look at what's on your display and act on it directly — clicking buttons, filling in fields, typing text — the same way you would, when a task calls for it.
- **She reads what you give her.** Drop in a PDF, a photo, a spreadsheet export, a Jupyter notebook — she reads it properly, images and all, not just as a blob of text.
- **She works in the background.** Give her a multi-step job and she'll run it, checking in only when she needs your input.
- **She can do several things at once.** Norma can spin up helpers to work on separate parts of a task in parallel, and you can watch each one work — or jump in and talk to any of them directly — in real time.
- **She can be taught new tricks.** Norma has a plugin system: capabilities install on demand, run only with your consent, and can be removed just as easily. A battery charge-limiter that protects your Mac's battery health ships as a working example, and popular open-source skill packs already run on her unmodified.
- **She can work on a schedule.** Ask her to check something every morning, clean up a folder every night, or run a report every Monday — she'll do it unattended, on her own schedule, without you having to remember.

## She remembers you

Ask Norma to remember something and she writes it down — as a plain markdown file, sitting in a folder on your Mac. There's no hidden database. Open the file in any text editor, read exactly what she knows, correct her, or delete it. Her memory is yours to inspect, because it's just files.

## She keeps herself updated

Norma updates herself in the background, silently, and only installs a new version when she's not in the middle of helping you. No dialog boxes interrupting your work, no forced restarts — she waits for a natural pause, then quietly picks up right where she left off.

## Your Mac, your data

This part matters more than anything else here, so we'll say it plainly:

- **No credentials ever touch disk.** Every API key and secret Norma uses is stored in the macOS Keychain — the same vault macOS itself uses — never in a config file, never in plain text.
- **Your memory and settings are files you own.** Everything Norma remembers or is configured to do lives in plain files on your Mac. Move them, back them up, read them, delete them — they're yours.
- **Every build is signed and notarized by Apple.** The app that lands on your Mac has been through Apple's own notarization process — the same gate every trustworthy macOS app passes through.
- **The source is fully open.** Nothing is hidden. You — or anyone — can read exactly what Norma does, line by line.

## Install

```sh
brew install --cask norma
```

Or download the latest `.dmg` directly from [GitHub Releases](https://github.com/yanlingLabs/norma/releases).

Norma requires macOS. Once installed, look for her icon in the menu bar — that's her home. Open a terminal and type `norma` any time you'd rather talk to her there instead.

## Bringing your own AI

Norma is the assistant; the intelligence behind her is your own. You connect her one of two ways:

- **Sign in with your ChatGPT account** — Norma uses your existing ChatGPT subscription, on your machine, with your login.
- **Bring your own OpenAI API key** — paste a key and Norma talks to OpenAI directly on your behalf.

A note in plain language: **Norma is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI.** Signing in with a ChatGPT account uses that account under OpenAI's own terms, which don't specifically bless third-party apps — so, as with any tool that isn't OpenAI's own, there's some risk to that account, and it's yours to weigh. If you'd rather not, the API-key option is the straightforward, officially-supported path. Either way, your credentials live only in your Mac's Keychain and Norma keeps no copy.

<details>
<summary>For developers</summary>

### Architecture

Norma is two things working together: a TypeScript/Bun **daemon** (`norma-core`) that runs the actual agent loop — providers, tools, sessions, plugins — and a native **Swift app** that gives it a face (menu bar, chat windows, notifications, screen/input access). They talk over a local Unix-domain socket using a small JSON-RPC/NDJSON protocol, so the daemon can run headless (from the `norma` CLI) or backed by the full app. A plugin platform sits on top of both: plugins are separate processes that request narrow, user-consented capabilities (filesystem, hardware, MCP servers) and can contribute tools, tiles, and skills back to the agent.

### Monorepo layout

```
packages/
  core/         norma-core daemon: agent loop, tools, sessions, plugins
  cli/          the `norma` command-line client (Ink/React TUI + headless mode)
  protocol/     the JSON-RPC method/event contracts shared by every client
  plugin-sdk/   the SDK third-party plugins build against
apple/
  Norma/        the native macOS app (menu bar, chat windows, computer-use bridge)
  NormaKit/     Swift client library for the daemon's socket protocol
  NormaProtocol/ Swift mirror of the protocol package's types
```

### Dev quickstart

```sh
bun install

# run the daemon headlessly
cd packages/cli
bun src/main.ts daemon run

# in another terminal, talk to it
bun src/main.ts -p "hello"
```

To build and run the native app:

```sh
cd apple/Norma
xcodegen generate
xcodebuild -project Norma.xcodeproj -scheme Norma -destination 'platform=macOS' build
```

### Plugins

See `packages/plugin-sdk` and the example plugins under `examples/` (`battery-limiter` is a complete, real reference plugin). Install any plugin from a git URL with `norma plugin install <git-url>`.

### Contributing

Issues and pull requests are welcome — please open an issue to discuss anything nontrivial before sending a PR.

### License

Apache License 2.0 — see [LICENSE](LICENSE).

</details>

---

Apache-2.0 licensed. © 2026 Norma.
