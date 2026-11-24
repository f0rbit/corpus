#!/usr/bin/env bun

import { run_cli } from "./main.js";

process.exit(
	await run_cli({
		argv: process.argv.slice(2),
		env: process.env,
		cwd: process.cwd(),
		stdout_is_tty: process.stdout.isTTY,
		stderr_is_tty: process.stderr.isTTY,
	}),
);
