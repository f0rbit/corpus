import { existsSync } from "node:fs";

export async function find_upward(start_dir: string, filename: string): Promise<string | null> {
	let current = start_dir;

	for (;;) {
		const candidate = `${current}/${filename}`;
		if (existsSync(candidate)) {
			return candidate;
		}

		if (existsSync(`${current}/.git`)) {
			return null;
		}

		const parent = current.split("/").slice(0, -1).join("/");
		if (parent === current || parent === "") {
			return null;
		}
		current = parent;
	}
}
