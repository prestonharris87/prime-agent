// launcher-stamp.ts — A LAUNCHER STAMPS THE SESSION IT SPAWNS, AND THIS HARNESS
// IS THE LAUNCHER OF EVERY rlm.spawn CHILD.
//
// The fleet's gate library (`lib/_launcher_identity.py` in the framework tree)
// resolves a session's identity from ONE file the launcher owns, named by
// `AISDLC_LAUNCHER_STAMP` in the session's environment — never from a flag the
// caller types. The Helm server stamps the ROOT session it spawns (identity
// `<lead-role>:<scope>`, class `agent`) and exports the variable into the root's
// environment, which the daemon inherits and every kernel it provisions spreads.
//
// Measured on the pinned fork before this module (c4a7590fd): `_rlmKernelEnv()`
// added `RLM_*` only and the kernel spawn spreads `process.env`, so a depth-1
// child's kernel INHERITED THE LEAD'S STAMP — the child resolved as its parent
// (wrong identity, the parent's seal key in hand, `--by <the lead>` accepted).
// A per-child stamp is a fork change at that seam, so it lives here: for every
// session at `RLM_DEPTH > 0` whose hosting process holds a parent stamp, mint a
// `launcher-stamp/1` document of the child's OWN — identity
// `helper:<child session name>@<parent identity>`, class `agent`, the parent's
// scope (a helper works inside its lead's scope; it never widens it), launcher
// `prime-agent`, sealed with THIS DAEMON'S key (one key per launcher: every child
// this process stamps seals with it; never the parent launcher's key, which the
// child's document does not carry) — and hand the child's kernel THAT file.
//
// Byte-compatible with the python `mint`: the seven keys, hex seal key >= 16
// bytes, mode 0600, tmp + rename. What it cannot do on a one-uid box is make
// the parent's file unreadable BY PATH — the child's environment simply no
// longer names it (the same approximation the framework's reader prints as
// `self-owned`); OS-level separation is the release VM's uid split.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const LAUNCHER_STAMP_ENV = "AISDLC_LAUNCHER_STAMP";
export const LAUNCHER_STAMP_SCHEMA = "launcher-stamp/1";
/** The `launcher` field every child stamp this harness mints carries. */
export const LAUNCHER_STAMP_LAUNCHER = "prime-agent";
/** The python reader refuses a seal key under 16 bytes; the python mint uses 32. */
const SEAL_KEY_BYTES = 32;

export interface LauncherStampDoc {
	schema: typeof LAUNCHER_STAMP_SCHEMA;
	identity: string;
	class: "agent" | "human";
	scope: string;
	seal_key: string;
	issued: string;
	launcher: string;
}

export interface MintedChildStamp {
	file: string;
	identity: string;
	scope: string;
	sealKeyPath: string;
	/** One measured line for the host log. */
	line: string;
}

export function launcherStampDir(stateDir: string): string {
	return join(stateDir, "launcher-stamps");
}

export function launcherSealKeyPath(stateDir: string): string {
	return join(stateDir, "launcher-seal.key");
}

function writePrivate(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

/** Read a stamp exactly as the python reader does — the SAME refusals by name.
 * Throws; a caller never treats a named-but-unreadable stamp as unstamped. */
export function readLauncherStamp(file: string): LauncherStampDoc {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`${LAUNCHER_STAMP_ENV}=${file} names a launcher stamp that cannot be read (${(error as Error).message.split("\n")[0]})`);
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (error) {
		throw new Error(`${LAUNCHER_STAMP_ENV}=${file}: not JSON (${(error as Error).message})`);
	}
	const d = doc as Record<string, unknown>;
	if (!d || typeof d !== "object" || d.schema !== LAUNCHER_STAMP_SCHEMA) {
		throw new Error(`${LAUNCHER_STAMP_ENV}=${file}: schema is not ${JSON.stringify(LAUNCHER_STAMP_SCHEMA)}`);
	}
	if (d.class !== "agent" && d.class !== "human") {
		throw new Error(`${LAUNCHER_STAMP_ENV}=${file}: class ${JSON.stringify(d.class)} is not one of agent|human`);
	}
	if (typeof d.identity !== "string" || !d.identity.trim()) throw new Error(`${LAUNCHER_STAMP_ENV}=${file}: no identity`);
	const key = typeof d.seal_key === "string" ? d.seal_key.trim() : "";
	if (!/^[0-9a-f]+$/i.test(key) || key.length < 32) throw new Error(`${LAUNCHER_STAMP_ENV}=${file}: seal_key must be >= 16 bytes of hex`);
	return {
		schema: LAUNCHER_STAMP_SCHEMA,
		identity: d.identity.trim(),
		class: d.class,
		scope: typeof d.scope === "string" ? d.scope.trim().replace(/\/+$/, "") : "",
		seal_key: key.toLowerCase(),
		issued: typeof d.issued === "string" ? d.issued : "",
		launcher: typeof d.launcher === "string" ? d.launcher : "",
	};
}

/** THIS DAEMON'S seal key as hex — read from the seat, minted on first use
 * (mode 0600). A seat holding fewer than 16 bytes is REFUSED by name rather
 * than re-minted: a rotated key would orphan every document a child sealed. */
export function daemonSealKeyHex(stateDir: string): string {
	const file = launcherSealKeyPath(stateDir);
	if (existsSync(file)) {
		const hex = readFileSync(file, "utf8").trim();
		if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 32) {
			throw new Error(`launcher seal key at ${file} is not >= 16 bytes of hex — refused (remove the file deliberately to re-mint)`);
		}
		return hex.toLowerCase();
	}
	const hex = randomBytes(SEAL_KEY_BYTES).toString("hex");
	writePrivate(file, `${hex}\n`);
	return hex;
}

/** Mint the stamp for ONE child session this process is about to provision a
 * kernel for. The parent stamp is the one the hosting process inherited from
 * ITS launcher; the child's identity is derived from it and from the child's
 * own session name — never typed by the child. */
export function mintChildLauncherStamp(o: {
	parentStampFile: string;
	stateDir: string;
	sessionId: string;
	childName: string | undefined;
	depth: number;
	now?: () => Date;
}): MintedChildStamp {
	const parent = readLauncherStamp(o.parentStampFile);
	if (!/^[A-Za-z0-9._-]+$/.test(o.sessionId)) throw new Error(`child launcher stamp: refused — session id ${JSON.stringify(o.sessionId)} is not a file-safe key`);
	const childName = (o.childName ?? "").trim() || o.sessionId;
	const identity = `helper:${childName}@${parent.identity}`;
	const doc: LauncherStampDoc = {
		schema: LAUNCHER_STAMP_SCHEMA,
		identity,
		class: "agent",
		scope: parent.scope,
		seal_key: daemonSealKeyHex(o.stateDir),
		issued: (o.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, "Z"),
		launcher: LAUNCHER_STAMP_LAUNCHER,
	};
	const file = join(launcherStampDir(o.stateDir), `${o.sessionId}.json`);
	writePrivate(file, `${JSON.stringify(doc, null, 1)}\n`);
	return {
		file,
		identity,
		scope: parent.scope,
		sealKeyPath: launcherSealKeyPath(o.stateDir),
		line: `launcher stamp: minted ${file} for depth-${o.depth} child identity=${identity} class=agent scope=${parent.scope || "-"} launcher=${LAUNCHER_STAMP_LAUNCHER} (parent ${parent.identity} via ${o.parentStampFile}; seal key ${launcherSealKeyPath(o.stateDir)}, this daemon's, not the parent launcher's)`,
	};
}
