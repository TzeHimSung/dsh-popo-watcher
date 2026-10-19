# dsh-popo-watcher

English | [简体中文](README.zh-CN.md)

A POPO group chat plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It monitors one configured group, judges whether a reply is useful, drafts a short response with the host's language model, and sends it through the official POPO CLI. A settings page provides monitoring controls, configuration, manual messaging, and activity records.

The plugin targets **DSH 0.2.x**. Its settings interface is currently in Chinese.

## Features

- Start or stop a monitoring window from **Settings → POPO自动水群**. A fresh installation stays idle until you configure a group and start it.
- When the effective generation provider is CodeMaker, starting or resuming monitoring first checks its live model-listing endpoint using the host's current configuration and credentials. A failed check or five-second timeout leaves monitoring stopped and shows the reason; retry by starting it again after fixing the endpoint. This checks connectivity without generating text.
- Use TypeSafe to judge conversations and drafts, or disable it and let DSH's language model decide whether to reply and draft the response in one call. Uncertain TypeSafe judgments also go to the language model; explicit rejections remain final. Select both models independently or follow the host's default generation model.
- The language model favors natural replies to questions, follow-ups, and jokes directed at the current account. Its prompt identifies that account and marks its messages; a reply need not add technical information, while closed conversations can still return `SKIP`.
- Generation uses the host's model limits with no plugin token budget or overall generation deadline. The host still handles connection and stream failures; stopping monitoring cancels generation and releases the queue.
- Merge new messages received while busy or cooling down into one bounded batch. After cooldown, the next successful poll re-evaluates the latest context, even when no new messages arrive.
- Configure the prompt, opening message, duration, polling interval, reply length, quiet hours, hourly cap, and automatic dry run.
- Enable **只回复 @ 我的消息** in Overview to consider automatic replies only to new messages mentioning the current account. The switch defaults to off and saves immediately; opening messages and manual sends keep their existing behavior.
- View recent group messages and local send, judgment, and round records.
- Send a manually written message to the saved target group, including while monitoring is stopped.
- Retry transient model failures after 20, 40, then 60 seconds, continuing at 60 seconds (or the host's longer retry hint). The next successful poll retries pending messages with fresh context, even without new messages. Collection failures use exponential backoff up to 300 seconds with no attempt limit; recovery resets the counter.
- Authentication, model configuration, exhausted quota, missing CLI, invalid collection responses, and persistence failures stop monitoring. Unknown model errors, `SKIP`, rejected or truncated drafts do not loop. Once a send is submitted, its batch is never replayed, including when the receipt is uncertain or accounting fails.
- Import existing watcher history from an explicitly selected directory without starting monitoring.

```text
New/pending messages → timing/content checks → optional TypeSafe judgment
                     → DSH model decision/draft → final checks → POPO send → local records
```

If enabled TypeSafe judgment is unavailable, the default policy stays silent. With TypeSafe disabled, no TypeSafe key is needed and the language model returns a reply or `SKIP`. **Manual send always sends real text**, even when automatic dry run is enabled. It bypasses automatic timing and judgment checks, but requires a valid saved group and non-empty text and prevents duplicate in-flight submissions. POPO sends use `source=AGENT`.

Mention filtering combines the official `atMembers` search with an explicit `@current name or nickname` in the message. Broadcast-only mentions do not qualify; mixed broadcasts and direct mentions do. Missing identity, account mismatches, and lookup failures stay silent. The API does not expose the original mention list, so typed names or quoted mentions can still be mistaken for direct mentions.

## Dependencies

| Dependency | Purpose |
| --- | --- |
| DSH **0.2.x** | Runtime, model service, RPC, and UI. Compatibility baseline: Desktop **0.2.1-rc.2**. The `@deepseek-ai/dsh-tools` peer range is `^0.2.1-rc.2`, excluding older releases and 0.3. |
| `@deepseek-ai/cordis` **^4.0.2** | Host plugin framework, supplied by DSH. |
| Official POPO CLI (`@popo/cli`) | Authenticated message search and sending. Obtain it through your organization's CLI distribution instructions and use an account with access to the target group. |
| [TypeSafe](https://typesafe.ai/) API key | Optional conversation and draft judgment; required only when TypeSafe is enabled. Default model: `jev-latest`. |
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
$package = (npm pack --json --ignore-scripts | ConvertFrom-Json)[0].filename
& $dshCli plugin --profile desktop add (Join-Path (Get-Location).Path $package)
```

Restart DSH Desktop, then open **Settings → POPO自动水群**. Use Desktop's bundled CLI so installation targets its `desktop` profile and runtime. Install the archive to keep the source checkout separate from Desktop's installation and cleanup paths. The committed client bundle is included; rebuild it first if you edit client source.

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
3. When using TypeSafe judgment, enter a key under **判读凭证**, or provide `TYPESAFE_API_KEY` to the host process. Windows user environment variables are also supported. A key saved in the UI takes precedence. Otherwise disable **使用 TypeSafe 判读** to use the language model alone.
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

For the Desktop archive installation, run `git pull --ff-only`, then repeat the packaging and installation commands above and restart DSH. For a linked web checkout, pull and restart. Rebuild first if you edit client source. Version 0.1.4 replaces the obsolete `webRuntime` Connection dependency with `webStartup`; it requires DSH 0.2.1-rc.2 or later in the 0.2 series.

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
