# dsh-popo-watcher

English | [简体中文](README.zh-CN.md)

A POPO group chat plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It monitors one configured group, judges whether a reply is useful, drafts a short response with the host's language model, and sends it through the official POPO CLI. A settings page provides monitoring controls, configuration, manual messaging, and activity records.

The plugin targets **DSH 0.2.x**. Its settings interface is currently in Chinese.

## Features

- Start or stop a monitoring window from **Settings → POPO自动水群**. A fresh installation stays idle until you configure a group and start it.
- Use TypeSafe to judge conversations and drafts, and DSH's model service to generate replies. Select both models independently or follow the host's default generation model.
- Configure the prompt, opening message, duration, polling interval, reply length, quiet hours, hourly cap, and automatic dry run.
- Enable **只回复 @ 我的消息** in Overview to consider automatic replies only to new messages mentioning the current account. The switch defaults to off and saves immediately; opening messages and manual sends keep their existing behavior.
- View recent group messages and local send, judgment, and round records.
- Send a manually written message to the saved target group, including while monitoring is stopped.
- Retry transient collection failures with backoff; stop after five consecutive failures. Authentication errors, missing CLI, invalid responses, and persistence failures stop monitoring immediately.
- Import existing watcher history from an explicitly selected directory without starting monitoring.

```text
New messages → timing/content checks → TypeSafe judgment
             → DSH model draft → final checks → POPO send → local records
```

If judgment is unavailable, the default policy stays silent. **Manual send always sends real text**, even when automatic dry run is enabled. It bypasses automatic timing and judgment checks, but requires a valid saved group and non-empty text and prevents duplicate in-flight submissions. POPO sends use `source=AGENT`.

Mention filtering combines the official `atMembers` search with an explicit `@current name or nickname` in the message. Broadcast-only mentions do not qualify; mixed broadcasts and direct mentions do. Missing identity, account mismatches, and lookup failures stay silent. The API does not expose the original mention list, so typed names or quoted mentions can still be mistaken for direct mentions.

## Dependencies

| Dependency | Purpose |
| --- | --- |
| DSH **0.2.x** | Runtime, model service, RPC, and UI. Compatibility baseline: Desktop **0.2.0-rc.2**. The `@deepseek-ai/dsh-tools` peer range is `^0.2.0-rc.2`, excluding 0.1 and 0.3. |
| `@deepseek-ai/cordis` **^4.0.2** | Host plugin framework, supplied by DSH. |
| Official POPO CLI (`@popo/cli`) | Authenticated message search and sending. Obtain it through your organization's CLI distribution instructions and use an account with access to the target group. |
| [TypeSafe](https://typesafe.ai/) API key | Conversation and draft judgment; default model: `jev-latest`. |
| A configured DSH language model | Automatic replies. Provider credentials are managed by DSH. |
| Git | Cloning this repository for local installation. |
| Node.js **24+**, npm, esbuild **0.28.2** | Development, client builds, and tests. esbuild is a development dependency only. |

The plugin has no third-party runtime dependencies of its own: host code uses Node.js built-ins, and the client uses React provided by DSH. The generated `lib/client.js` is included, so an unchanged checkout needs no client build. Do not install a separate copy of the host packages to satisfy the optional peers.

Windows Desktop is the runtime regression target. Linux uses a DSH web profile and an explicit POPO CLI entry path; the Desktop test runner does not verify a Linux host.

## Installation

Install a compatible DSH host and the official POPO CLI, then authenticate in a terminal:

```sh
popo-cli auth login
popo-cli auth status
```

### Windows: DSH Desktop

Run in PowerShell, replacing the Desktop installation path:

```powershell
git clone https://github.com/TzeHimSung/dsh-popo-watcher.git
cd dsh-popo-watcher

$dshCli = 'C:\path\to\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dshCli --version
& $dshCli plugin --profile desktop add (Get-Location).Path
```

Restart DSH Desktop, then open **Settings → POPO自动水群**. Use Desktop's bundled CLI so installation targets its `desktop` profile and runtime.

### Linux: DSH web profile

With a compatible `dsh` command already installed:

```sh
git clone https://github.com/TzeHimSung/dsh-popo-watcher.git
cd dsh-popo-watcher
dsh --version
dsh plugin --profile web add "$PWD"
dsh web
```

Restart an already running web host after installation. Local installation links the checkout into the profile, so keep that directory in place. See DSH's [plugin installation workflow](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

## First-time setup

1. Open the plugin's **设置** tab, enter the target POPO group ID, and save. Defaults contain no real group.
2. Configure a generation model in DSH, then select it in the plugin or keep **跟随宿主默认**.
3. Enter a TypeSafe key under **判读凭证**, or provide `TYPESAFE_API_KEY` to the host process. Windows user environment variables are also supported. A key saved in the UI takes precedence.
4. Click **检查 POPO CLI** to check the CLI and authentication. This does not start monitoring or send a message.
5. Review the opening message and automatic-send settings, choose a duration, and start monitoring. Automatic dry run is **off** by default; the opening message is enabled.

On Linux or a custom CLI installation, set `popoCliJs` in the plugin's `config.json` to the absolute path of `@popo/cli/bin/popo.js`, preserving other fields, then reload configuration or restart the host. `npm root -g` locates the global module directory. Automatic discovery currently checks the Windows npm layout.

## Data and credentials

Data lives outside the repository in `<user-home>/.dsh/popo-watcher/`:

```text
config.json                  # Saved settings
secret.json                  # TypeSafe key, only if saved through the UI
<group-id>/
  state.json / poller.json    # Window, accounting, and collection state
  messages.jsonl             # Collected messages
  sends.jsonl / judge.jsonl / round.jsonl / poll.log
```

The saved key is a local JSON value, not an encrypted secret store. The UI shows its source without echoing it. Clearing it does not remove an environment variable. Conversation context and drafts are sent to TypeSafe and the configured model when those features run. Logs have entry and byte limits.

The repository uses synthetic test identities and fixtures. Credentials, runtime data, original screenshots, local acceptance logs, and scratch probes are excluded from Git. Stopped windows stay stopped; an unexpired active window may resume when `autoResume` is enabled.

## Update or uninstall

For a linked checkout, run `git pull --ff-only`, then restart DSH and reopen settings. Rebuild first if you edit client source.

```powershell
# Windows Desktop, using $dshCli from above
& $dshCli plugin --profile desktop remove dsh-popo-watcher
```

```sh
# DSH web profile
dsh plugin --profile web remove dsh-popo-watcher
```

Uninstalling leaves separately stored settings and history in place.

## Development

```sh
npm ci
npm run build:client       # src/client/index.js → lib/client.js
npm run check:client       # Verify the committed bundle matches source
npm run dev:client         # Rebuild on source changes
npm test                  # Offline suite; host-only cases are skipped
```

On Windows with DSH Desktop installed:

```powershell
npm run test:desktop -- 'C:\path\to\DeepSeek Harness'
node tools/preview-ui.mjs 'C:\path\to\DeepSeek Harness'
```

The Desktop suite runs all tests with bundled Node and real host libraries, using temporary data and mock external services. The preview loads the actual client and host theme with mock RPC. Neither needs live POPO messages or a model call. `npm pack` rebuilds the client before packaging.

| Directory | Contents |
| --- | --- |
| `lib/` | Host modules and generated client |
| `src/client/` | Client source and styles |
| `test/` | Offline tests and synthetic fixtures |
| `tools/` | Build, test, preview, and optional live diagnostics |
| [`docs/interfaces.md`](docs/interfaces.md) | Behavior and interface contracts (Chinese) |

Live diagnostics require explicit `--group` input; replay also requires `--legacy`. They can read real POPO messages or call TypeSafe and are separate from the offline suite.

## License

[GNU GPL version 3](LICENSE) (`GPL-3.0-only`).
