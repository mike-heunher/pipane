import { describe, expect, it } from "vitest";
import { WsAgentAdapter } from "./ws-agent-adapter";

describe("pi install required events", () => {
	it("notifies listeners when server asks to install pi", () => {
		const adapter = new WsAgentAdapter();
		let payload: any = null;
		adapter.onPiInstallRequired((info) => {
			payload = info;
		});

		(adapter as any).handleMessage(JSON.stringify({
			type: "pi_install_required",
			command: "pi",
			installable: true,
			installing: false,
			message: "pi command not found",
		}));

		expect(payload).toEqual({
			command: "pi",
			installable: true,
			installing: false,
			message: "pi command not found",
		});
	});
});
