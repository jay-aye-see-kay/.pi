/**
 * Sandbox — OS-level sandboxing for bash + path/network policy for pi's tools.
 *
 * Uses @anthropic-ai/sandbox-runtime (sandbox-exec on macOS, bubblewrap on Linux)
 * to restrict bash. pi's in-process read/write/edit tools bypass the OS sandbox,
 * so they are gated separately in the `tool_call` hook.
 *
 * Two modes (config `mode`, default "sandbox"; switch at runtime with
 * `/sandbox enable` or `/sandbox prompt`):
 *
 *   "sandbox" — OS sandbox on. Network access to hosts outside `allowedDomains`
 *     is prompted at CONNECTION time via the sandbox's request-time ask callback
 *     (accurate — no command regex). read/write/edit are gated against
 *     allowRead/allowWrite/denyWrite. Grants can be kept for the session, the
 *     project, or all projects. When a bash command is blocked by the OS sandbox,
 *     the library's violation log (seatbelt log on macOS, seccomp monitor on
 *     Linux) says what was denied: the user is offered a grant + retry, and
 *     for failed commands the violations are appended to the tool result for
 *     the model. Denying a host/path is remembered for the session
 *     (chatty endpoints otherwise re-prompt on every connection). Prompt keys:
 *     a = session, P = project, G = global, d = deny for session, esc = deny once.
 *
 *   "prompt" — NO OS sandbox. The agent can touch anything outside the sandbox,
 *     but every read/edit/write/bash is prompted, every time, with no memory.
 *
 * Config (merged; project overrides global):
 *   ~/.pi/agent/sandbox.json   (global)
 *   <cwd>/.pi/sandbox.json     (project)
 *
 * The bundled patch (patches/) neutralises the library's hardcoded
 * mandatory write-denies: DANGEROUS_FILES / DANGEROUS_DIRECTORIES (which
 * blocked .vscode/.idea/.claude/* and various dotfiles, see issue #159) and
 * the unconditional .git/hooks + .git/config denies (cwd-relative + glob,
 * inconsistent and broken when running from a repo subdirectory).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, DynamicBorder, getAgentDir, getShellConfig, isToolCallEventType, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// ── Config ──────────────────────────────────────────────────────────────────

type Mode = "sandbox" | "prompt";

interface NetworkConfig {
	allowedDomains?: string[];
	deniedDomains?: string[];
	allowLocalBinding?: boolean;
	allowAllUnixSockets?: boolean;
	allowUnixSockets?: string[];
	allowMachLookup?: string[];
}
interface FilesystemConfig {
	denyRead?: string[];
	allowRead?: string[];
	allowWrite?: string[];
	denyWrite?: string[];
}
interface SandboxConfig {
	mode?: Mode;
	enabled?: boolean;
	enableWeakerNetworkIsolation?: boolean;
	network?: NetworkConfig;
	filesystem?: FilesystemConfig;
}

const DEFAULT_CONFIG: SandboxConfig = {
	mode: "sandbox",
	enabled: true,
	network: {
		allowedDomains: ["localhost", "github.com", "*.github.com", "registry.npmjs.org", "*.npmjs.org", "pypi.org", "*.pypi.org"],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: [],
		allowRead: ["."],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function readJson(path: string): Partial<SandboxConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`sandbox: could not parse ${path}: ${e}`);
		return {};
	}
}

function configPaths(cwd: string): { globalPath: string; projectPath: string } {
	return { globalPath: join(getAgentDir(), "sandbox.json"), projectPath: join(cwd, ".pi", "sandbox.json") };
}

function loadConfig(cwd: string): SandboxConfig {
	const { globalPath, projectPath } = configPaths(cwd);
	const merged = [DEFAULT_CONFIG, readJson(globalPath), readJson(projectPath)].reduce<SandboxConfig>((acc, o) => ({
		mode: o.mode ?? acc.mode,
		enabled: o.enabled ?? acc.enabled,
		enableWeakerNetworkIsolation: o.enableWeakerNetworkIsolation ?? acc.enableWeakerNetworkIsolation,
		network: { ...acc.network, ...o.network },
		filesystem: { ...acc.filesystem, ...o.filesystem },
	}), {} as SandboxConfig);
	return merged;
}

// ── Path matching ───────────────────────────────────────────────────────────

function expandPath(p: string): string {
	return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

function canonicalizePath(p: string): string {
	const abs = expandPath(p);
	try {
		return realpathSync.native(abs);
	} catch {
		// Path (or a tail of it) does not exist yet: resolve symlinks in the
		// nearest existing ancestor, then re-append the missing tail.
		const tail: string[] = [];
		let probe = abs;
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) return abs;
			tail.unshift(basename(probe));
			probe = parent;
		}
		try {
			return resolve(realpathSync.native(probe), ...tail);
		} catch {
			return abs;
		}
	}
}

function matchesPattern(filePath: string, patterns: string[]): boolean {
	const abs = canonicalizePath(filePath);
	return patterns.some((pat) => {
		if (pat.includes("*")) {
			const absPat = expandPath(pat);
			const rx = absPat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			return new RegExp(`^${rx}$`).test(abs);
		}
		const absPat = canonicalizePath(pat);
		const sep = absPat.endsWith("/") ? "" : "/";
		return abs === absPat || abs.startsWith(absPat + sep);
	});
}

// ── Domain matching ─────────────────────────────────────────────────────────

function domainMatches(domain: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		const base = pattern.slice(2);
		return domain === base || domain.endsWith("." + base);
	}
	return domain === pattern;
}

function domainAllowed(domain: string, allowed: string[]): boolean {
	return allowed.some((p) => domainMatches(domain, p));
}

// ── Config writers (in-process; not OS-sandboxed) ─────────────────────────────

function writeConfig(path: string, cfg: Partial<SandboxConfig>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function addToConfigList(path: string, section: "network" | "filesystem", key: string, value: string): void {
	const cfg = readJson(path);
	const sec = ((cfg as Record<string, Record<string, unknown>>)[section] ??= {});
	const list = (sec[key] as string[] | undefined) ?? [];
	if (!list.includes(value)) {
		sec[key] = [...list, value];
		writeConfig(path, cfg);
	}
}

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

/**
 * Bumped on every SandboxManager.reset(). reset() force-cleans mount points and
 * zeroes the library's live-sandbox ref count, so a command wrapped before it
 * must not call cleanupAfterCommand() afterwards — that would decrement the
 * count of a newer command and pull mount points from under its live bwrap.
 */
let sandboxGeneration = 0;
async function resetSandbox(): Promise<void> {
	sandboxGeneration++;
	await SandboxManager.reset();
}

/**
 * `commandId` keys the library's violation store: violations observed while the
 * wrapped command runs are retrievable via getViolationsForCommand(commandId).
 * Must be unique per invocation, or a rerun inherits earlier violations.
 */
function sandboxedBashOps(shellPath: string | undefined, commandId: string): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const { shell, args } = getShellConfig(shellPath);
			const generation = sandboxGeneration;
			const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, { commandId });
			// The sandbox isolates network via an HTTP(S) proxy (HTTPS_PROXY). Node's
			// fetch/undici ignores that proxy unless NODE_USE_ENV_PROXY=1, so Node-based
			// CLIs (e.g. mcporter MCP calls) get EPERM. Opt them into the proxy here.
			const childEnv = { ...(env ?? process.env) };
			if (childEnv.NODE_USE_ENV_PROXY === undefined) childEnv.NODE_USE_ENV_PROXY = "1";
			try {
				return await new Promise((resolvePromise, reject) => {
					const child = spawn(shell, [...args, wrapped], { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
					let timedOut = false;
					let th: NodeJS.Timeout | undefined;
					if (timeout && timeout > 0) {
						th = setTimeout(() => {
							timedOut = true;
							if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
						}, timeout * 1000);
					}
					child.stdout?.on("data", onData);
					child.stderr?.on("data", onData);
					// Spawn failure: no process, settle now. Any later error (e.g. a failed
					// kill): wait for 'close', so cleanup never runs under a live sandbox.
					let childError: Error | undefined;
					child.on("error", (e) => {
						if (child.pid === undefined) { if (th) clearTimeout(th); reject(e); }
						else childError = e;
					});
					const onAbort = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
					signal?.addEventListener("abort", onAbort, { once: true });
					child.on("close", (code, sig) => {
						if (th) clearTimeout(th);
						signal?.removeEventListener("abort", onAbort);
						if (childError) reject(childError);
						else if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						// Killed by a signal: report 128+N like a shell (null would make pi throw).
						else resolvePromise({ exitCode: code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1) });
					});
				});
			} finally {
				// Exactly once per successful wrapWithSandbox (it's ref-counted): on Linux,
				// removes the empty mount-point files bwrap leaves on the host for
				// non-existent deny paths once no sandboxed command is running. No-op on macOS.
				if (generation === sandboxGeneration) SandboxManager.cleanupAfterCommand();
			}
		},
	};
}

// ── Violations ──────────────────────────────────────────────────────────────

interface Blocked {
	kind: "read" | "write";
	path: string;
}

/**
 * Parse a filesystem violation line from the library's violation store.
 *   macOS (seatbelt log):   "bash(123) deny(1) file-write-create /path"
 *   Linux (seccomp monitor): "deny openat /path"   (writes only)
 * Network denies ("deny network-outbound host:port ...") and other operations
 * (mach-lookup, file-read-metadata probes, ...) are ignored.
 */
function parseViolation(line: string): Blocked | null {
	const mac = line.match(/\bdeny(?:\(\d+\))? (file-read-data|file-write[\w-]*) (\/.+)$/);
	if (mac) return { kind: mac[1] === "file-read-data" ? "read" : "write", path: mac[2] };
	if (process.platform !== "linux") return null;
	const linux = line.match(/^deny \S+ (\/.+)$/);
	// The Linux monitor also reports writes bwrap actually permits via its
	// --dev / --proc mounts; those are never real blocks.
	if (!linux || /^\/(dev|proc|sys)(\/|$)/.test(linux[1])) return null;
	return { kind: "write", path: linux[1] };
}

/** Output that suggests an OS-level block, worth waiting for the (async) violation log. */
const PERMISSION_ERROR = /Operation not permitted|Permission denied|Read-only file system|\bEPERM\b|\bEACCES\b/;
/** macOS violations arrive via `log stream`, a little after the command exits. */
const VIOLATION_WAIT_MS = 500;
/** Once one file violation has arrived, give its siblings a moment to follow. */
const VIOLATION_SETTLE_MS = 100;
/** Cap on grant prompts after one bash run, so a noisy command can't prompt-storm. */
const MAX_PROMPTS_PER_RUN = 3;

// Note: the store is a global ring (100 entries); a noisy parallel command can
// evict this run's lines, which degrades to the output-scraping fallback.
async function violationsFor(commandId: string, wait: boolean): Promise<string[]> {
	const store = SandboxManager.getSandboxViolationStore();
	const get = () => store.getViolationsForCommand(commandId).map((v) => v.line);
	if (!wait) return get();
	// Proxy (network) denies are recorded synchronously, so wait specifically for
	// a *file* violation, then settle briefly to collect any that follow it.
	const deadline = Date.now() + VIOLATION_WAIT_MS;
	while (Date.now() < deadline) {
		if (get().some((l) => parseViolation(l) !== null)) {
			await sleep(VIOLATION_SETTLE_MS);
			break;
		}
		await sleep(50);
	}
	return get();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fallback when the violation store has nothing usable (the macOS monitor can
 * drop or misattribute lines; the Linux monitor may not be listening yet):
 * pull a blocked write path out of the output. Linux bwrap fails writes with
 * EROFS ("Read-only file system"), macOS seatbelt with EPERM.
 */
function blockedWritePath(output: string): string | null {
	// bash's own redirection failures:
	//   bash: /path: Operation not permitted
	const shell = output.match(/(?:\/bin\/bash|bash|sh): (?:line \d+: )?(\/[\s\S]+?): (?:Operation not permitted|Read-only file system)/);
	if (shell) return shell[1];
	// tool-reported failures (touch, tee, ...):
	//   touch: /path: Operation not permitted
	const tool = output.match(/^\w[\w./-]*: (\/.+?): (?:Operation not permitted|Read-only file system)/m);
	if (tool) return tool[1];
	// git's lock-file failures:
	//   fatal: Unable to create '/path/.git/index.lock': Operation not permitted
	const git = output.match(/Unable to create '([^']+)': (?:Operation not permitted|Read-only file system)/);
	return git ? git[1] : null;
}

// ── Extension ─────────────────────────────────────────────────────────────────

/**
 * Outcome of a grant prompt. "deny" is an explicit choice and may be remembered;
 * "cancel" means the user dismissed the dialog (ESC) and must never be remembered
 * — it blocks the operation at hand and nothing more.
 */
type Grant = "session" | "project" | "global" | "deny" | "cancel";

const isAllow = (g: Grant): g is "session" | "project" | "global" => g === "session" || g === "project" || g === "global";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const { shell } = getShellConfig();
	// Honor the user's shellCommandPrefix (e.g. "shopt -s expand_aliases"). Core
	// applies it to its own bash tool, but we replace that tool below, so we must
	// thread it through ourselves. user_bash (!) is unaffected — core prepends the
	// prefix before our operations hook runs.
	const shellCommandPrefix = SettingsManager.create(cwd, getAgentDir()).getShellCommandPrefix();
	const localBash = createBashTool(cwd, { commandPrefix: shellCommandPrefix });

	let mode: Mode = "sandbox";
	let sandboxOn = false; // OS sandbox initialised
	let ctxRef: ExtensionContext | null = null;

	// Runtime grants (in-memory, not visible to the agent), on top of config files.
	const sessionDomains = new Set<string>();
	const sessionDeniedDomains = new Set<string>();
	const sessionRead: string[] = [];
	const sessionWrite: string[] = [];
	// Explicit "deny — this session" choices: block without re-prompting.
	const sessionDeniedRead = new Set<string>();
	const sessionDeniedWrite = new Set<string>();

	const effAllowedDomains = () => [...(loadConfig(cwd).network?.allowedDomains ?? []), ...sessionDomains];
	const effAllowRead = () => [...(loadConfig(cwd).filesystem?.allowRead ?? []), ...sessionRead];
	const effAllowWrite = () => [...(loadConfig(cwd).filesystem?.allowWrite ?? []), ...sessionWrite];

	// ── Serial prompt queue (network asks can fire concurrently mid-execution) ──
	let queue: Promise<unknown> = Promise.resolve();
	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.then(() => {}, () => {});
		return run;
	}

	// ── Grant prompt ────────────────────────────────────────────────────────────
	// Each option has a single-key accelerator; ESC is also listed explicitly so
	// the "deny once" escape hatch is discoverable rather than implicit.
	const GRANT_OPTIONS: { grant: Grant; key: string; label: string }[] = [
		{ grant: "session", key: "a", label: "Allow — this session only" },
		{ grant: "project", key: "P", label: "Allow — this project (.pi/sandbox.json)" },
		{ grant: "global", key: "G", label: "Allow — all projects (~/.pi/agent/sandbox.json)" },
		{ grant: "deny", key: "d", label: "Deny — this session" },
		{ grant: "cancel", key: "esc", label: "Deny — just this once" },
	];
	const grantLabel = (o: (typeof GRANT_OPTIONS)[number]) => `${o.label} [${o.key}]`;
	let promptSeq = 0;

	async function promptGrant(ctx: ExtensionContext, title: string): Promise<Grant> {
		// Let alerting extensions know a human is being blocked on (see alerter.ts).
		const attentionKey = `sandbox:${++promptSeq}`;
		pi.events.emit("attention:request", { key: attentionKey, message: title });
		try {
			return await askGrant(ctx, title);
		} finally {
			pi.events.emit("attention:resolve", { key: attentionKey });
		}
	}

	async function askGrant(ctx: ExtensionContext, title: string): Promise<Grant> {
		if (ctx.mode !== "tui") {
			// No custom components (rpc/json/print): fall back to the plain selector.
			const choice = await ctx.ui.select(title, GRANT_OPTIONS.map(grantLabel));
			return GRANT_OPTIONS.find((o) => grantLabel(o) === choice)?.grant ?? "cancel";
		}
		return ctx.ui.custom<Grant>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

			const items: SelectItem[] = GRANT_OPTIONS.map((o) => ({ value: o.grant, label: grantLabel(o) }));
			const list = new SelectList(items, items.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value as Grant);
			list.onCancel = () => done("cancel");
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • a/P/G/d shortcuts • esc deny once"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					const hit = GRANT_OPTIONS.find((o) => o.key === data);
					if (hit) {
						done(hit.grant);
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function applyGrant(kind: "domain" | "read" | "write", value: string, grant: Grant): Promise<void> {
		if (!isAllow(grant)) return;
		const { globalPath, projectPath } = configPaths(cwd);
		const section = kind === "domain" ? "network" : "filesystem";
		const key = kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
		if (kind === "domain") sessionDomains.add(value);
		else if (kind === "read") { if (!sessionRead.includes(value)) sessionRead.push(value); }
		else if (!sessionWrite.includes(value)) sessionWrite.push(value);
		if (grant === "project") addToConfigList(projectPath, section, key, value);
		if (grant === "global") addToConfigList(globalPath, section, key, value);
		// Push new fs paths into the running OS sandbox so the next bash command
		// sees them. Network grants are served by the ask callback, so no update needed.
		if (kind !== "domain" && sandboxOn) updateSandboxConfig();
	}

	// ── Sandbox init ──────────────────────────────────────────────────────────
	function runtimeConfig() {
		const cfg = loadConfig(cwd);
		return {
			enableWeakerNetworkIsolation: cfg.enableWeakerNetworkIsolation,
			network: {
				allowedDomains: effAllowedDomains(),
				deniedDomains: cfg.network?.deniedDomains ?? [],
				allowLocalBinding: cfg.network?.allowLocalBinding,
				allowAllUnixSockets: cfg.network?.allowAllUnixSockets,
				allowUnixSockets: cfg.network?.allowUnixSockets,
				allowMachLookup: cfg.network?.allowMachLookup,
			},
			filesystem: {
				denyRead: cfg.filesystem?.denyRead ?? [],
				allowRead: effAllowRead(),
				allowWrite: effAllowWrite(),
				denyWrite: cfg.filesystem?.denyWrite ?? [],
			},
		};
	}

	// Request-time network gate. Fires only for hosts the proxy can't already
	// resolve via allow/deny lists → we only need to consult runtime grants.
	const askNetwork = async ({ host }: { host: string; port: number | undefined }): Promise<boolean> => {
		if (domainAllowed(host, effAllowedDomains())) return true;
		if (sessionDeniedDomains.has(host)) return false;
		const ctx = ctxRef;
		if (!ctx?.hasUI) return false;
		return enqueue(async () => {
			if (domainAllowed(host, effAllowedDomains())) return true; // granted while queued
			if (sessionDeniedDomains.has(host)) return false; // denied while queued
			const grant = await promptGrant(ctx, `🌐 Allow network connection to "${host}"?`);
			if (grant === "deny") {
				// Remember for the session: chatty endpoints (analytics, telemetry) retry
				// constantly and the library asks on every connection.
				sessionDeniedDomains.add(host);
				return false;
			}
			// Dismissed: fail this connection only, so a stray ESC can't blackhole a
			// host for the rest of the session. The next attempt asks again.
			if (grant === "cancel") return false;
			await applyGrant("domain", host, grant);
			return true;
		});
	};

	async function initSandbox(): Promise<void> {
		await SandboxManager.initialize(runtimeConfig(), askNetwork, true); // true = violation monitor
		sandboxOn = true;
	}
	// Hot-swap the policy without restarting the proxies (reset + initialize
	// would tear down and rebuild them). Applies to subsequently wrapped commands.
	function updateSandboxConfig(): void {
		try {
			SandboxManager.updateConfig(runtimeConfig());
		} catch (e) {
			ctxRef?.ui.notify(`Sandbox config update failed (previous policy still in effect): ${e}`, "error");
		}
	}

	// ── bash tool ─────────────────────────────────────────────────────────────
	pi.registerTool({
		...localBash,
		label: "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			if (mode !== "sandbox" || !sandboxOn) {
				return localBash.execute(id, params, signal, onUpdate); // prompt mode / disabled: run bare
			}
			const run = async () => {
				// Unique per run so a retry doesn't inherit the first run's violations.
				// (Not derived from the tool call id: keys compare on their first 100 chars.)
				const commandId = randomUUID();
				const tool = createBashTool(cwd, { operations: sandboxedBashOps(shell, commandId), commandPrefix: shellCommandPrefix });
				const result = await tool.execute(id, params, signal, onUpdate);
				// Prefer the full (untruncated) output so an early EPERM isn't missed.
				const full = (result.structuredContent as { output?: unknown } | undefined)?.output;
				const text = typeof full === "string" ? full : result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
				// Only treat the run as sandbox-blocked if the output says so: plenty of
				// programs attempt a denied write, shrug, and carry on successfully.
				const blocked = PERMISSION_ERROR.test(text);
				const violations = await violationsFor(commandId, blocked);
				return { result, text, blocked, violations };
			};
			// Tell the model what the sandbox blocked — bare EPERMs are otherwise opaque.
			const annotate = ({ result, violations }: Run) => {
				if (!result.isError) return result;
				const lines = violations.filter((l) => {
					const b = parseViolation(l);
					return !b || !isStale(b);
				});
				if (lines.length === 0) return result;
				const shown = lines.slice(0, 20).join("\n");
				const more = lines.length > 20 ? `\n... ${lines.length - 20} more` : "";
				return { ...result, content: [...result.content, { type: "text" as const, text: `\n<sandbox_violations>\n${shown}${more}\n</sandbox_violations>` }] };
			};
			type Run = Awaited<ReturnType<typeof run>>;

			const first = await run();
			if (!ctx?.hasUI || !first.blocked) return annotate(first);

			// Offer to allow blocked paths, then retry once.
			let granted = false;
			for (const b of blockedCandidates(first)) {
				// Serialise with network prompts (and parallel tool calls); re-check once
				// it's our turn, as a queued prompt may have settled it already.
				const grant = await enqueue(async (): Promise<Grant | "already" | "skip"> => {
					if (isStale(b)) return "already";
					if (!offerable(b)) return "skip";
					const title = b.kind === "write" ? `📝 bash write blocked: allow write to "${b.path}"?` : `📖 bash read blocked: allow read of "${b.path}"?`;
					const g = await promptGrant(ctx, title);
					if (g === "deny") (b.kind === "write" ? sessionDeniedWrite : sessionDeniedRead).add(b.path);
					if (isAllow(g)) await applyGrant(b.kind, b.path, g);
					return g;
				});
				if (grant === "already" || (grant !== "skip" && isAllow(grant))) granted = true;
			}
			if (!granted) return annotate(first);
			onUpdate?.({ content: [{ type: "text", text: `\n--- access granted, retrying ---\n` }], details: undefined });
			return annotate(await run());
		},
	});

	/**
	 * A report for a path that is no longer blocked. On Linux the violation
	 * monitor's allow/deny lists are fixed at initialize and go stale after a
	 * grant (updateConfig), so re-check against the current policy. On macOS
	 * every report is a real seatbelt deny; our own glob matcher doesn't mirror
	 * the library's exactly, so only trust exact grants made this session.
	 */
	function isStale(b: Blocked): boolean {
		if (process.platform === "linux") {
			// bwrap can't enforce globs: the library drops glob allow/deny entries on Linux.
			const literal = (ps: string[]) => ps.filter((p) => !p.includes("*"));
			if (b.kind === "read") return matchesPattern(b.path, literal(effAllowRead()));
			return matchesPattern(b.path, literal(effAllowWrite())) && !matchesPattern(b.path, literal(loadConfig(cwd).filesystem?.denyWrite ?? []));
		}
		return (b.kind === "read" ? sessionRead : sessionWrite).includes(b.path);
	}

	/**
	 * denyRead entries narrower than the home dir / root (e.g. ~/.ssh). Broad
	 * entries like "~" are a default-deny that allowRead carves into, so
	 * offering a grant there is normal; a targeted entry is a deliberate choice
	 * that a quick keypress shouldn't override (an allowRead nested inside a
	 * denyRead re-opens it in the library, which is exactly what a grant adds).
	 */
	function targetedReadDenies(): string[] {
		const broad = new Set([canonicalizePath(homedir()), "/"]);
		return (loadConfig(cwd).filesystem?.denyRead ?? []).filter((p) => !broad.has(canonicalizePath(p)));
	}

	/** Whether to prompt for a blocked path at all (policy / session-deny checks). */
	function offerable(b: Blocked): boolean {
		if (matchesPattern(b.path, targetedReadDenies())) return false;
		if (b.kind === "read") return !sessionDeniedRead.has(b.path);
		return !sessionDeniedWrite.has(b.path) && !matchesPattern(b.path, loadConfig(cwd).filesystem?.denyWrite ?? []);
	}

	/**
	 * Paths worth prompting for after a blocked run. The path named in the error
	 * output comes first (it's what actually failed; the macOS monitor can drop
	 * or misattribute lines), then violation-store reports, those mentioned in
	 * the output first. Reads are only offered when the command failed AND the
	 * output names the path — directory scans (find, rg) probe many denied
	 * paths harmlessly.
	 */
	function blockedCandidates({ result, text, violations }: { result: { isError?: boolean }; text: string; violations: string[] }): Blocked[] {
		const collect = (found: Blocked[]) => {
			const seen = new Set<string>();
			const out: Blocked[] = [];
			for (const f of found) {
				const b = { kind: f.kind, path: canonicalizePath(f.path) };
				const key = `${b.kind}:${b.path}`;
				if (seen.has(key) || isStale(b) || !offerable(b)) continue;
				seen.add(key);
				out.push(b);
			}
			return out;
		};
		const scraped = blockedWritePath(text);
		const reported = violations
			.map(parseViolation)
			.filter((b): b is Blocked => b !== null && (b.kind === "write" || (!!result.isError && text.includes(b.path))))
			.sort((a, b) => Number(text.includes(b.path)) - Number(text.includes(a.path)));
		return collect([...(scraped ? [{ kind: "write" as const, path: scraped }] : []), ...reported]).slice(0, MAX_PROMPTS_PER_RUN);
	}

	// ── tool_call: fs gates (sandbox) / confirm-everything (prompt) ─────────────
	pi.on("tool_call", async (event, ctx) => {
		if (mode === "prompt") {
			if (isToolCallEventType("read", event)) return confirmOnce(ctx, "read", event.input.path);
			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) return confirmOnce(ctx, "write", (event.input as { path: string }).path);
			if (isToolCallEventType("bash", event)) return confirmOnce(ctx, "run", event.input.command);
			return;
		}
		if (!sandboxOn) return;

		if (isToolCallEventType("read", event)) {
			const path = canonicalizePath(event.input.path);
			if (matchesPattern(path, effAllowRead())) return;
			return gateTool(ctx, "read", path);
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = canonicalizePath((event.input as { path: string }).path);
			const cfg = loadConfig(cwd);
			if (matchesPattern(path, cfg.filesystem?.denyWrite ?? [])) {
				return { block: true, reason: `Sandbox: write denied for "${path}" (in denyWrite)` };
			}
			if (matchesPattern(path, effAllowWrite())) return;
			return gateTool(ctx, "write", path);
		}
	});

	/** Prompt for an in-process read/write, serialised with all other grant prompts. */
	async function gateTool(ctx: ExtensionContext, kind: "read" | "write", path: string): Promise<{ block: true; reason: string } | undefined> {
		const allow = kind === "read" ? effAllowRead : effAllowWrite;
		const denied = kind === "read" ? sessionDeniedRead : sessionDeniedWrite;
		return enqueue(async () => {
			if (matchesPattern(path, allow())) return undefined; // granted while queued
			if (denied.has(path)) return { block: true as const, reason: `Sandbox: ${kind} denied for "${path}" (denied for this session)` };
			const grant = await promptGrant(ctx, kind === "read" ? `📖 Allow read of "${path}"?` : `📝 Allow write to "${path}"?`);
			if (grant === "deny") denied.add(path);
			if (!isAllow(grant)) return { block: true as const, reason: `Sandbox: ${kind} denied for "${path}"` };
			await applyGrant(kind, path, grant);
			return undefined;
		});
	}

	async function confirmOnce(ctx: ExtensionContext, verb: string, target: string): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) return { block: true, reason: `Sandbox (prompt mode): no UI to approve ${verb}` };
		const ok = await ctx.ui.confirm(`Allow ${verb}?`, target);
		return ok ? undefined : { block: true, reason: `Denied ${verb}: ${target}` };
	}

	// ── user_bash (! commands) ──────────────────────────────────────────────────
	pi.on("user_bash", async (event, ctx) => {
		if (mode === "prompt") {
			if (ctx.hasUI && !(await ctx.ui.confirm("Allow run?", event.command))) {
				return { result: { output: "Denied by sandbox (prompt mode).", exitCode: 1, cancelled: false, truncated: false } };
			}
			return;
		}
		if (sandboxOn) return { operations: sandboxedBashOps(shell, randomUUID()) };
	});

	// ── lifecycle ───────────────────────────────────────────────────────────────
	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		const cfg = loadConfig(cwd);
		mode = cfg.mode ?? "sandbox";

		if (cfg.enabled === false) {
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}
		if (mode === "prompt") {
			setModeStatus(ctx);
			return;
		}
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		try {
			await initSandbox();
		} catch (err) {
			ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
		}
		setModeStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (sandboxOn) try { await resetSandbox(); } catch {}
	});

	// ── mode switching ────────────────────────────────────────────────────────
	function setModeStatus(ctx: ExtensionContext): void {
		if (mode === "prompt") {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Prompt mode: every read/edit/bash asks"));
			return;
		}
		if (!sandboxOn) {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔒 Sandbox mode (inactive)"));
			return;
		}
		const cfg = loadConfig(cwd);
		const n = cfg.network?.allowedDomains?.length ?? 0;
		const w = cfg.filesystem?.allowWrite?.length ?? 0;
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${n} domains, ${w} write paths`));
	}

	async function enterSandboxMode(ctx: ExtensionContext): Promise<void> {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		mode = "sandbox";
		if (!sandboxOn) {
			try {
				await initSandbox();
			} catch (err) {
				ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
				return;
			}
		}
		setModeStatus(ctx);
		ctx.ui.notify("Sandbox mode: OS sandbox on; network & paths gated", "info");
	}

	async function enterPromptMode(ctx: ExtensionContext): Promise<void> {
		mode = "prompt";
		if (sandboxOn) {
			try { await resetSandbox(); } catch {}
			sandboxOn = false;
		}
		setModeStatus(ctx);
		ctx.ui.notify("Prompt mode: no OS sandbox; every read/edit/bash asks", "info");
	}

	function showConfig(ctx: ExtensionContext): void {
		const cfg = loadConfig(cwd);
		const { globalPath, projectPath } = configPaths(cwd);
		const lines = [
			`Sandbox mode: ${mode}${mode === "sandbox" && !sandboxOn ? " (inactive)" : ""}`,
			"  Switch: /sandbox enable | /sandbox prompt",
			`  Global config:  ${globalPath}`,
			`  Project config: ${projectPath}`,
			"",
			"Network:",
			`  Allowed:      ${cfg.network?.allowedDomains?.join(", ") || "(none)"}`,
			`  Denied:       ${cfg.network?.deniedDomains?.join(", ") || "(none)"}`,
			`  Mach lookup:  ${cfg.network?.allowMachLookup?.join(", ") || "(none)"}`,
			...(sessionDomains.size ? [`  Session allowed: ${[...sessionDomains].join(", ")}`] : []),
			...(sessionDeniedDomains.size ? [`  Session denied:  ${[...sessionDeniedDomains].join(", ")}`] : []),
			"",
			"Filesystem:",
			`  Deny Read:   ${cfg.filesystem?.denyRead?.join(", ") || "(none)"}`,
			`  Allow Read:  ${cfg.filesystem?.allowRead?.join(", ") || "(none)"}`,
			`  Allow Write: ${cfg.filesystem?.allowWrite?.join(", ") || "(none)"}`,
			`  Deny Write:  ${cfg.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			...(sessionRead.length ? [`  Session read:  ${sessionRead.join(", ")}`] : []),
			...(sessionWrite.length ? [`  Session write: ${sessionWrite.join(", ")}`] : []),
			...(sessionDeniedRead.size ? [`  Session denied read:  ${[...sessionDeniedRead].join(", ")}`] : []),
			...(sessionDeniedWrite.size ? [`  Session denied write: ${[...sessionDeniedWrite].join(", ")}`] : []),
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	// ── /sandbox ────────────────────────────────────────────────────────────────
	pi.registerCommand("sandbox", {
		description: "Show config or switch mode: /sandbox [show|enable|prompt]",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "show", label: "show", description: "Show current sandbox config" },
				{ value: "enable", label: "enable", description: "Switch to OS sandbox mode" },
				{ value: "prompt", label: "prompt", description: "Switch to prompt-everything mode" },
			];
			const filtered = subs.filter((s) => s.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "enable" || sub === "sandbox") return enterSandboxMode(ctx);
			if (sub === "prompt") return enterPromptMode(ctx);
			showConfig(ctx);
		},
	});
}
