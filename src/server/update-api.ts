import type { Express } from "express";
import { isUpdateTarget } from "../shared/updates.js";
import type { UpdateManager } from "./update-manager.js";

export interface UpdateApiManager {
	check(): ReturnType<UpdateManager["check"]>;
	run(target: Parameters<UpdateManager["run"]>[0]): ReturnType<UpdateManager["run"]>;
	readonly currentSnapshot: UpdateManager["currentSnapshot"];
}

export function registerUpdateApi(app: Express, manager: UpdateApiManager): void {
	app.get("/api/updates", async (_req, res) => {
		try {
			res.json(await manager.check());
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/updates/:target", async (req, res) => {
		if (req.get("X-Pipane-Action") !== "update") {
			res.status(400).json({ error: "Missing update action header." });
			return;
		}
		if (!isUpdateTarget(req.params.target)) {
			res.status(400).json({ error: `Unknown update target: ${req.params.target}` });
			return;
		}
		try {
			const result = await manager.run(req.params.target);
			res.json({ result, snapshot: manager.currentSnapshot });
		} catch (error) {
			res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
