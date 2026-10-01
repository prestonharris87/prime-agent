import { describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_FROM_PREVIEW_LABEL,
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	createAgentSessionMessageQueuePreview,
} from "../src/core/agent-messages.js";
import { formatQueuedMessagePreview } from "../src/modes/interactive/interactive-mode.js";

describe("queued agent-message preview names its sender", () => {
	it("names a child by relationship and session name", () => {
		expect(
			createAgentSessionMessageQueuePreview({
				message: "Calendar slice done.",
				from: { sessionName: "scope-alpha", sessionId: "s-1" },
				fromRelationship: "child",
			}),
		).toBe("Agent message from child:scope-alpha: Calendar slice done.");
	});

	it("names a nameless parent by the relationship alone, never the raw session id", () => {
		const preview = createAgentSessionMessageQueuePreview({
			message: "Write it now.",
			from: { sessionId: "0a0a0a0a-1111-4222-8333-444444444444" },
			fromRelationship: "parent",
		});
		expect(preview).toBe("Agent message from parent: Write it now.");
		expect(preview).not.toContain("0a0a0a0a");
	});

	it("names a sender with no relationship by its session name", () => {
		expect(
			createAgentSessionMessageQueuePreview({ message: "Rates are mine.", from: { sessionName: "scope-beta" } }),
		).toBe("Agent message from scope-beta: Rates are mine.");
	});

	it("falls back to the anonymous label when nothing names the sender", () => {
		expect(createAgentSessionMessageQueuePreview({ message: "hello" })).toBe(
			`${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: hello`,
		);
	});

	it("is a labelled preview in the TUI queue (no Steering/Follow-up prefix)", () => {
		const preview = `${AGENT_MESSAGE_FROM_PREVIEW_LABEL} child:scope-alpha: done`;
		expect(formatQueuedMessagePreview(preview, "Steering")).toBe(preview);
		expect(formatQueuedMessagePreview("typed text", "Steering")).toBe("Steering: typed text");
	});
});
