import { describe, expect, it } from "vitest";
import {
	type DaemonInfo,
	evaluateShutdownQuietPeriod,
	isWorkerSocketPath,
	planReap,
	planShutdownAll,
	planShutdownConfirmation,
	scanWindowsRegisteredDaemons,
	verifyHelloSupervisorPid,
} from "../src/cli/daemon-ps.js";
import { getProcessStartId } from "../src/core/session-lease.js";

it("recognizes Windows worker named pipes on every platform", () => {
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee")).toBe(true);
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-daemon")).toBe(false);
});

describe("evaluateShutdownQuietPeriod", () => {
	it("requires a full quiet period independently of the convergence window", () => {
		expect(evaluateShutdownQuietPeriod(10_500, 10_000)).toBe("waiting");
		expect(evaluateShutdownQuietPeriod(11_000, 10_000)).toBe("complete");
	});
});

describe("verifyHelloSupervisorPid", () => {
	it("accepts the hello pid only while its process identity still matches", () => {
		const processStartId = getProcessStartId(process.pid);
		expect(verifyHelloSupervisorPid(process.pid, processStartId)).toBe(process.pid);
		if (processStartId) {
			expect(verifyHelloSupervisorPid(process.pid, `${processStartId}-stale`)).toBeUndefined();
		}
	});
});

describe("planReap", () => {
	it("never touches the default daemon or daemons with live sessions", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "stale", isDefault: true, sessionCount: 0, pid: 1 }),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["skip", "skip"]);
	});

	it("removes orphan files and stops reachable idle non-default daemons", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/idle.sock", status: "current", sessionCount: 0, pid: 5 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			false,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "remove-file"]);
	});

	it("removes a stale default socket file", () => {
		const plan = planReap(
			[makeDaemon({ socketPath: "/tmp/default.sock", status: "orphan-file", isDefault: true })],
			true,
		);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("only kills unreachable daemons with --force", () => {
		const daemon = makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 });
		const skipped = planReap([daemon], false)[0]!;
		expect(skipped.kind).toBe("skip");
		expect(skipped.kind === "skip" ? skipped.reason : "").toContain("prime-agent shutdown --force");
		expect(planReap([daemon], true)[0]!.kind).toBe("kill");
	});

	it("refuses to kill a pid that backs more than one discovered daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/listening.sock", status: "current", sessionCount: 4, pid: 99 }),
				makeDaemon({ socketPath: "/tmp/phantom.sock", status: "unreachable", pid: 99 }),
			],
			true,
		);
		const phantom = plan.find((action) => action.daemon.socketPath === "/tmp/phantom.sock");
		expect(phantom?.kind).toBe("skip");
		expect(phantom && phantom.kind === "skip" ? phantom.reason : "").toContain("also backs another daemon");
	});
});

describe("planShutdownAll", () => {
	it("targets every service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({
					socketPath: "/tmp/default.sock",
					status: "current",
					isDefault: true,
					sessionCount: 0,
					pid: 1,
				}),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
				makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "shutdown", "kill", "remove-file"]);
	});

	it("never skips a service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({ socketPath: "/tmp/a.sock", status: "stale", pid: 9 }),
				makeDaemon({ socketPath: "/tmp/b.sock", status: "unreachable", pid: 10 }),
			],
			true,
		);
		expect(plan.some((action) => action.kind === "skip")).toBe(false);
	});

	it("removes the socket file for an unreachable daemon with no pid", () => {
		const plan = planShutdownAll([makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" })], false);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("requires force for unreachable tracked workers", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/worker-only.sock",
			status: "unreachable",
			hasTrackedWorkers: true,
		});
		expect(planShutdownAll([daemon], false)[0]!.kind).toBe("skip");
		expect(planShutdownAll([daemon], true)[0]!.kind).toBe("remove-file");
	});
});

describe("planShutdownConfirmation", () => {
	it("never prompts when JSON output was requested", () => {
		expect(planShutdownConfirmation(1, true, false, true)).toBe("json-error");
	});

	it("prompts only for non-JSON shutdown at a TTY", () => {
		expect(planShutdownConfirmation(1, false, false, true)).toBe("prompt");
		expect(planShutdownConfirmation(1, false, false, false)).toBe("tty-error");
		expect(planShutdownConfirmation(1, true, true, true)).toBe("none");
		expect(planShutdownConfirmation(0, false, false, true)).toBe("none");
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}

// win32 discovery (B1 of the Windows harness spike): the supervisor registry is
// the listener source, gated on the pipe being present and the pid existing.
describe("scanWindowsRegisteredDaemons", () => {
	const pipe = (name: string) => `\\\\.\\pipe\\${name}`;
	const sources = (
		owners: Array<{ pid: number; socketPath: string }>,
		pipes: string[] | undefined,
		live: number[],
	) => ({
		owners: () => owners,
		pipeNames: () => (pipes ? new Set(pipes.map((name) => name.toLowerCase())) : undefined),
		pidExists: (pid: number) => live.includes(pid),
	});

	it("finds every registered supervisor whose pipe is listed and whose pid exists", () => {
		const found = scanWindowsRegisteredDaemons(
			sources(
				[
					{ pid: 101, socketPath: pipe("prime-spike-a") },
					{ pid: 102, socketPath: pipe("Helm-Prime-Lead") },
					{ pid: 103, socketPath: pipe("prime-agent-daemon") },
				],
				["prime-spike-a", "helm-prime-lead", "prime-agent-daemon", "unrelated"],
				[101, 102, 103],
			),
		);
		expect(found).toEqual([
			{ pid: 101, socketPath: pipe("prime-spike-a") },
			{ pid: 102, socketPath: pipe("helm-prime-lead") },
			{ pid: 103, socketPath: pipe("prime-agent-daemon") },
		]);
	});

	it("drops a record whose pipe is gone or whose pid no longer exists", () => {
		const found = scanWindowsRegisteredDaemons(
			sources(
				[
					{ pid: 201, socketPath: pipe("gone-pipe") },
					{ pid: 202, socketPath: pipe("dead-pid") },
					{ pid: 203, socketPath: pipe("live") },
				],
				["dead-pid", "live"],
				[201, 203],
			),
		);
		expect(found).toEqual([{ pid: 203, socketPath: pipe("live") }]);
	});

	it("falls back to the pid check when the pipe namespace cannot be listed", () => {
		const found = scanWindowsRegisteredDaemons(
			sources(
				[
					{ pid: 301, socketPath: pipe("a") },
					{ pid: 302, socketPath: pipe("b") },
				],
				undefined,
				[302],
			),
		);
		expect(found).toEqual([{ pid: 302, socketPath: pipe("b") }]);
	});

	it("never reports a worker pipe, a non-pipe path, or the same listener twice", () => {
		const worker = pipe("prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee");
		const found = scanWindowsRegisteredDaemons(
			sources(
				[
					{ pid: 401, socketPath: worker },
					{ pid: 402, socketPath: "/tmp/prime-agent-0/daemon.sock" },
					{ pid: 403, socketPath: pipe("x") },
					{ pid: 403, socketPath: pipe("X") },
				],
				["prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee", "x"],
				[401, 402, 403],
			),
		);
		expect(found).toEqual([{ pid: 403, socketPath: pipe("x") }]);
	});
});
